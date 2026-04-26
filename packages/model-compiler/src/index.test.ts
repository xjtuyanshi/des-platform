import { analyzeDesModel, compileDesModel, runDesModel, runDesModelReplicationsToResult, runDesModelSweepToResult, runDesModelToResult } from './index.js';

function applyJsonPatch(document: unknown, patch: Array<{ op: 'add' | 'replace' | 'remove'; path: string; value?: unknown }>): unknown {
  const root = structuredClone(document);
  for (const operation of patch) {
    const parts = operation.path.split('/').slice(1).map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'));
    const key = parts.at(-1);
    const parent = parts.slice(0, -1).reduce<unknown>((current, part) => {
      if (Array.isArray(current)) {
        return current[Number(part)];
      }
      return (current as Record<string, unknown>)[part];
    }, root);
    if (key === undefined) {
      throw new Error(`Invalid patch path ${operation.path}`);
    }
    if (Array.isArray(parent)) {
      if (operation.op === 'add') {
        parent.splice(key === '-' ? parent.length : Number(key), 0, operation.value);
      } else if (operation.op === 'replace') {
        parent[Number(key)] = operation.value;
      } else {
        parent.splice(Number(key), 1);
      }
    } else if (operation.op === 'remove') {
      delete (parent as Record<string, unknown>)[key];
    } else {
      (parent as Record<string, unknown>)[key] = operation.value;
    }
  }
  return root;
}

describe('model compiler', () => {
  it('validates and runs an AI-native process model DSL', () => {
    const model = {
      schemaVersion: 'des-platform.v1',
      id: 'mm1-smoke',
      name: 'Single Server Smoke',
      process: {
        id: 'mm1',
        resourcePools: [{ id: 'server', capacity: 1 }],
        blocks: [
          { id: 'source', kind: 'source', entityType: 'customer', startAtSec: 0, intervalSec: 3, maxArrivals: 4 },
          { id: 'queue', kind: 'queue', capacity: 10 },
          { id: 'service', kind: 'service', resourcePoolId: 'server', durationSec: 5 },
          { id: 'sink', kind: 'sink' }
        ],
        connections: [
          { from: 'source', to: 'queue' },
          { from: 'queue', to: 'service' },
          { from: 'service', to: 'sink' }
        ]
      },
      materialHandling: {
        id: 'warehouse',
        nodes: [
          { id: 'home', type: 'home', x: 0, z: 0 },
          { id: 'station', type: 'station', x: 6, z: 0 }
        ],
        paths: [{ id: 'home-station', from: 'home', to: 'station', lengthM: 6 }],
        transporterFleets: [{ id: 'amr', count: 1, homeNodeId: 'home', speedMps: 1.5 }],
        storageSystems: [],
        conveyors: []
      },
      experiments: [{ id: 'baseline', stopTimeSec: 30 }]
    };

    const compiled = compileDesModel(model);
    const result = compiled.runExperiment('baseline');
    const materialHandling = compiled.createMaterialHandlingRuntime();

    expect(compiled.model.id).toBe('mm1-smoke');
    expect(materialHandling?.findShortestRoute('home', 'station', 'amr').travelTimeSec).toBe(4);
    expect(result.snapshot.completedEntities).toBe(4);
    expect(result.snapshot.entities.map((entity) => entity.completedAtSec)).toEqual([5, 10, 15, 20]);
  });

  it('runs material handling process blocks through the compiler', () => {
    const result = runDesModel({
      schemaVersion: 'des-platform.v1',
      id: 'mh-flow',
      name: 'Material Handling Flow',
      process: {
        id: 'mh-process',
        blocks: [
          { id: 'source', kind: 'source', entityType: 'load', scheduleAtSec: [0] },
          { id: 'move', kind: 'moveByTransporter', fleetId: 'amr', fromNodeId: 'dock', toNodeId: 'storage' },
          { id: 'sink', kind: 'sink' }
        ],
        connections: [
          { from: 'source', to: 'move' },
          { from: 'move', to: 'sink' }
        ]
      },
      materialHandling: {
        id: 'mh',
        nodes: [
          { id: 'dock', type: 'dock', x: 0, z: 0 },
          { id: 'storage', type: 'storage', x: 4, z: 0 }
        ],
        paths: [{ id: 'dock-storage', from: 'dock', to: 'storage', lengthM: 4 }],
        transporterFleets: [{ id: 'amr', count: 1, homeNodeId: 'dock', speedMps: 2 }]
      },
      experiments: [{ id: 'baseline', stopTimeSec: 10 }]
    });

    expect(result.snapshot.completedEntities).toBe(1);
    expect(result.snapshot.entities[0]?.completedAtSec).toBe(2);
    expect(result.snapshot.materialHandling?.transporterUnits[0]?.currentNodeId).toBe('storage');
  });

  it('rejects material process blocks with missing material references before runtime', () => {
    expect(() =>
      runDesModel({
        schemaVersion: 'des-platform.v1',
        id: 'bad-mh',
        name: 'Bad Material Model',
        process: {
          id: 'bad-mh-flow',
          blocks: [
            { id: 'source', kind: 'source', scheduleAtSec: [0] },
            { id: 'move', kind: 'moveByTransporter', fleetId: 'missing', fromNodeId: 'dock', toNodeId: 'storage' },
            { id: 'sink', kind: 'sink' }
          ],
          connections: [
            { from: 'source', to: 'move' },
            { from: 'move', to: 'sink' }
          ]
        },
        materialHandling: {
          id: 'mh',
          nodes: [
            { id: 'dock', type: 'dock', x: 0, z: 0 },
            { id: 'storage', type: 'storage', x: 4, z: 0 }
          ],
          paths: [{ id: 'dock-storage', from: 'dock', to: 'storage', lengthM: 4 }],
          transporterFleets: [{ id: 'amr', count: 1, homeNodeId: 'dock', speedMps: 2 }]
        },
        experiments: [{ id: 'baseline', stopTimeSec: 10 }]
      })
    ).toThrow(/unknown fleet missing/);
  });

  it('builds a serializable generic run result for headless workflows', () => {
    const result = runDesModelToResult({
      schemaVersion: 'des-platform.v1',
      id: 'serializable',
      name: 'Serializable Run',
      process: {
        id: 'flow',
        resourcePools: [{ id: 'server', capacity: 1 }],
        blocks: [
          { id: 'source', kind: 'source', entityType: 'job', scheduleAtSec: [0, 0] },
          { id: 'service', kind: 'service', resourcePoolId: 'server', durationSec: 3 },
          { id: 'sink', kind: 'sink' }
        ],
        connections: [
          { from: 'source', to: 'service' },
          { from: 'service', to: 'sink' }
        ]
      },
      experiments: [{ id: 'baseline', stopTimeSec: 10 }]
    });

    expect(result.schemaVersion).toBe('des-platform.run.v1');
    expect(result.summary.createdEntities).toBe(2);
    expect(result.summary.completedEntities).toBe(2);
    expect(result.summary.averageCycleTimeSec).toBe(4.5);
    expect(result.summary.stoppedBy).toBe('empty');
    expect(result.summary.resourcePools[0]).toMatchObject({
      id: 'server',
      utilization: 0.6,
      totalWaitTimeSec: 3,
      averageWaitTimeSec: 1.5,
      completedRequests: 2,
      maxQueueLength: 1
    });
    expect(result.seed).toBe(1);
    expect(JSON.parse(JSON.stringify(result)).modelId).toBe('serializable');
  });

  it('applies named parameter overrides before running a model', () => {
    const result = runDesModelToResult({
      schemaVersion: 'des-platform.v1',
      id: 'parameterized',
      name: 'Parameterized',
      parameters: [
        {
          id: 'service-time',
          path: '/process/blocks/service/durationSec',
          valueType: 'number',
          defaultValue: 3,
          min: 1,
          max: 10
        }
      ],
      process: {
        id: 'flow',
        resourcePools: [{ id: 'server', capacity: 1 }],
        blocks: [
          { id: 'source', kind: 'source', scheduleAtSec: [0] },
          { id: 'service', kind: 'service', resourcePoolId: 'server', durationSec: 3 },
          { id: 'sink', kind: 'sink' }
        ],
        connections: [
          { from: 'source', to: 'service' },
          { from: 'service', to: 'sink' }
        ]
      },
      experiments: [{ id: 'slow', stopTimeSec: 20, parameterOverrides: { 'service-time': 8 } }]
    }, 'slow');

    expect(result.parameterValues).toEqual({ 'service-time': 8 });
    expect(result.summary.entities[0]?.completedAtSec).toBe(8);
  });

  it('builds replication experiment reports with seeded KPI statistics', () => {
    const report = runDesModelReplicationsToResult({
      schemaVersion: 'des-platform.v1',
      id: 'replications',
      name: 'Replications',
      process: {
        id: 'flow',
        resourcePools: [{ id: 'server', capacity: 1 }],
        blocks: [
          { id: 'source', kind: 'source', intervalSec: { kind: 'uniform', min: 1, max: 3 }, maxArrivals: 4 },
          { id: 'service', kind: 'service', resourcePoolId: 'server', durationSec: { kind: 'triangular', min: 2, mode: 4, max: 7 } },
          { id: 'sink', kind: 'sink' }
        ],
        connections: [
          { from: 'source', to: 'service' },
          { from: 'service', to: 'sink' }
        ]
      },
      experiments: [{ id: 'baseline', seed: 100, seedStride: 10, replications: 3, stopTimeSec: 100 }]
    });

    expect(report.schemaVersion).toBe('des-platform.experiment.v1');
    expect(report.replications).toBe(3);
    expect(report.replicationSummaries.map((replication) => replication.seed)).toEqual([100, 110, 120]);
    expect(report.metricStats.completedEntities.count).toBe(3);
    expect(report.metricStats.completedEntities.mean).toBe(4);
    expect(report.metricStats.averageCycleTimeSec.halfWidth95).toBeGreaterThan(0);
    expect(JSON.parse(JSON.stringify(report)).modelId).toBe('replications');
  });

  it('builds parameter sweep reports across all parameter combinations', () => {
    const report = runDesModelSweepToResult({
      schemaVersion: 'des-platform.v1',
      id: 'sweep',
      name: 'Sweep',
      parameters: [
        {
          id: 'interarrival',
          path: '/process/blocks/source/intervalSec',
          valueType: 'number',
          defaultValue: 1,
          min: 1,
          max: 3
        },
        {
          id: 'service-time',
          path: '/process/blocks/service/durationSec',
          valueType: 'number',
          defaultValue: 2,
          min: 2,
          max: 4
        }
      ],
      process: {
        id: 'flow',
        resourcePools: [{ id: 'server', capacity: 1 }],
        blocks: [
          { id: 'source', kind: 'source', intervalSec: 1, maxArrivals: 3 },
          { id: 'service', kind: 'service', resourcePoolId: 'server', durationSec: 2 },
          { id: 'sink', kind: 'sink' }
        ],
        connections: [
          { from: 'source', to: 'service' },
          { from: 'service', to: 'sink' }
        ]
      },
      experiments: [{
        id: 'grid',
        seed: 7,
        replications: 2,
        stopTimeSec: 30,
        sweep: {
          interarrival: [1, 3],
          'service-time': [2, 4]
        }
      }]
    }, 'grid');

    expect(report.schemaVersion).toBe('des-platform.sweep.v1');
    expect(report.sweepParameters).toEqual(['interarrival', 'service-time']);
    expect(report.caseCount).toBe(4);
    expect(report.cases.map((candidate) => candidate.parameterValues)).toEqual([
      { interarrival: 1, 'service-time': 2 },
      { interarrival: 1, 'service-time': 4 },
      { interarrival: 3, 'service-time': 2 },
      { interarrival: 3, 'service-time': 4 }
    ]);
    expect(report.cases.every((candidate) => candidate.replicationSummaries.length === 2)).toBe(true);
    expect(report.cases[0]?.metricStats.averageCycleTimeSec.mean).toBeLessThan(report.cases[1]?.metricStats.averageCycleTimeSec.mean ?? 0);
    expect(JSON.parse(JSON.stringify(report)).caseCount).toBe(4);
  });

  it('rejects invalid graph references before runtime', () => {
    expect(() =>
      runDesModel({
        schemaVersion: 'des-platform.v1',
        id: 'bad',
        name: 'Bad Model',
        process: {
          id: 'bad-flow',
          blocks: [
            { id: 'source', kind: 'source', scheduleAtSec: [0] },
            { id: 'sink', kind: 'sink' }
          ],
          connections: [{ from: 'source', to: 'missing' }]
        },
        experiments: [{ id: 'baseline', stopTimeSec: 1 }]
      })
    ).toThrow(/unknown to block missing/);
  });

  it('reports no diagnostics for a valid minimal model', () => {
    const report = analyzeDesModel({
      schemaVersion: 'des-platform.v1',
      id: 'valid-minimal',
      name: 'Valid Minimal',
      process: {
        id: 'flow',
        blocks: [
          { id: 'source', kind: 'source', scheduleAtSec: [0] },
          { id: 'sink', kind: 'sink' }
        ],
        connections: [{ from: 'source', to: 'sink' }]
      },
      experiments: [{ id: 'baseline', stopTimeSec: 10 }]
    });

    expect(report.valid).toBe(true);
    expect(report.errors).toHaveLength(0);
    expect(report.warnings).toHaveLength(0);
  });

  it('reports static process graph diagnostics without throwing', () => {
    const report = analyzeDesModel({
      schemaVersion: 'des-platform.v1',
      id: 'dead-end',
      name: 'Dead End',
      process: {
        id: 'flow',
        blocks: [
          { id: 'source', kind: 'source', scheduleAtSec: [0] },
          { id: 'queue', kind: 'queue' },
          { id: 'sink', kind: 'sink' }
        ],
        connections: [{ from: 'source', to: 'queue' }]
      },
      experiments: [{ id: 'baseline', stopTimeSec: 10 }]
    });

    expect(report.valid).toBe(false);
    expect(report.errors.map((diagnostic) => diagnostic.code)).toEqual(
      expect.arrayContaining(['process.dead-end', 'process.source-cannot-reach-sink'])
    );
    expect(report.warnings.map((diagnostic) => diagnostic.code)).toEqual(
      expect.arrayContaining(['process.unreachable-block', 'process.unused-sink'])
    );
  });

  it('reports material handling route diagnostics before runtime', () => {
    const report = analyzeDesModel({
      schemaVersion: 'des-platform.v1',
      id: 'unreachable-route',
      name: 'Unreachable Route',
      process: {
        id: 'flow',
        blocks: [
          { id: 'source', kind: 'source', scheduleAtSec: [0] },
          { id: 'move', kind: 'moveByTransporter', fleetId: 'amr', fromNodeId: 'dock', toNodeId: 'storage' },
          { id: 'sink', kind: 'sink' }
        ],
        connections: [
          { from: 'source', to: 'move' },
          { from: 'move', to: 'sink' }
        ]
      },
      materialHandling: {
        id: 'layout',
        nodes: [
          { id: 'dock', type: 'dock', x: 0, z: 0 },
          { id: 'storage', type: 'storage', x: 10, z: 0 }
        ],
        paths: [],
        transporterFleets: [{ id: 'amr', count: 1, homeNodeId: 'dock', speedMps: 1.5 }]
      },
      experiments: [{ id: 'baseline', stopTimeSec: 10 }]
    });

    expect(report.valid).toBe(false);
    expect(report.errors.map((diagnostic) => diagnostic.code)).toContain('material.route-unreachable');
  });

  it('reports schema diagnostics for invalid model input', () => {
    const report = analyzeDesModel({
      schemaVersion: 'wrong-version',
      id: 'bad-schema'
    });

    expect(report.valid).toBe(false);
    expect(report.errors.map((diagnostic) => diagnostic.code)).toContain('schema.invalid');
  });

  it('reports invalid parameter paths as static diagnostics', () => {
    const report = analyzeDesModel({
      schemaVersion: 'des-platform.v1',
      id: 'bad-parameter-path',
      name: 'Bad Parameter Path',
      parameters: [
        {
          id: 'missing-path',
          path: '/process/blocks/missing/durationSec',
          valueType: 'number',
          defaultValue: 1
        }
      ],
      process: {
        id: 'flow',
        blocks: [
          { id: 'source', kind: 'source', scheduleAtSec: [0] },
          { id: 'sink', kind: 'sink' }
        ],
        connections: [{ from: 'source', to: 'sink' }]
      },
      experiments: [{ id: 'baseline', stopTimeSec: 10 }]
    });

    expect(report.valid).toBe(false);
    expect(report.errors.map((diagnostic) => diagnostic.code)).toContain('parameter.path-invalid');
  });

  it('emits patch-safe JSON pointers and repair candidates for common diagnostics', () => {
    const deadEndModel = {
      schemaVersion: 'des-platform.v1',
      id: 'dead-end-repair',
      name: 'Dead End Repair',
      process: {
        id: 'flow',
        blocks: [
          { id: 'source', kind: 'source', scheduleAtSec: [0] },
          { id: 'queue', kind: 'queue' },
          { id: 'sink', kind: 'sink' }
        ],
        connections: [{ from: 'source', to: 'queue' }]
      },
      experiments: [{ id: 'baseline', stopTimeSec: 10 }]
    };
    const report = analyzeDesModel(deadEndModel);
    const deadEnd = report.diagnostics.find((diagnostic) => diagnostic.code === 'process.dead-end');

    expect(deadEnd?.jsonPointer).toBe('/process/blocks/1');
    expect(deadEnd?.repairCandidate?.requiresUserConfirmation).toBe(true);
    const repaired = applyJsonPatch(deadEndModel, deadEnd?.repairCandidate?.patch ?? []) as typeof deadEndModel;
    expect(repaired.process.connections).toContainEqual({ from: 'queue', to: 'sink' });
  });

  it('emits safe schema repair candidates for unsupported queue discipline and invalid capacities', () => {
    const badSchema = {
      schemaVersion: 'des-platform.v1',
      id: 'bad-schema-repair',
      name: 'Bad Schema Repair',
      process: {
        id: 'flow',
        blocks: [
          { id: 'source', kind: 'source', scheduleAtSec: [0] },
          { id: 'queue', kind: 'queue', discipline: 'lifo', capacity: -1 },
          { id: 'sink', kind: 'sink' }
        ],
        connections: [
          { from: 'source', to: 'queue' },
          { from: 'queue', to: 'sink' }
        ]
      },
      experiments: [{ id: 'baseline', stopTimeSec: 10 }]
    };
    const report = analyzeDesModel(badSchema);
    const discipline = report.diagnostics.find((diagnostic) => diagnostic.jsonPointer === '/process/blocks/1/discipline');
    const capacity = report.diagnostics.find((diagnostic) => diagnostic.jsonPointer === '/process/blocks/1/capacity');

    expect(discipline?.repairCandidate?.patch).toEqual([{ op: 'replace', path: '/process/blocks/1/discipline', value: 'fifo' }]);
    expect(capacity?.repairCandidate?.patch).toEqual([{ op: 'replace', path: '/process/blocks/1/capacity', value: 1 }]);
    const repaired = applyJsonPatch(badSchema, [
      ...(discipline?.repairCandidate?.patch ?? []),
      ...(capacity?.repairCandidate?.patch ?? [])
    ]) as typeof badSchema;
    expect(repaired.process.blocks[1]).toMatchObject({ discipline: 'fifo', capacity: 1 });
  });

  it('emits repair candidates for missing experiments, bad parameters, and unreachable material routes', () => {
    const noExperiment = analyzeDesModel({
      schemaVersion: 'des-platform.v1',
      id: 'no-experiment',
      name: 'No Experiment',
      process: {
        id: 'flow',
        blocks: [
          { id: 'source', kind: 'source', scheduleAtSec: [0] },
          { id: 'sink', kind: 'sink' }
        ],
        connections: [{ from: 'source', to: 'sink' }]
      }
    });
    expect(noExperiment.diagnostics.find((diagnostic) => diagnostic.code === 'experiment.none')?.repairCandidate?.patch[0]).toMatchObject({
      op: 'add',
      path: '/experiments/-'
    });

    const badParameter = analyzeDesModel({
      schemaVersion: 'des-platform.v1',
      id: 'bad-param-repair',
      name: 'Bad Param Repair',
      parameters: [{ id: 'bad', path: '/process/blocks/missing/durationSec', valueType: 'number', defaultValue: 1 }],
      process: {
        id: 'flow',
        blocks: [
          { id: 'source', kind: 'source', scheduleAtSec: [0] },
          { id: 'sink', kind: 'sink' }
        ],
        connections: [{ from: 'source', to: 'sink' }]
      },
      experiments: [{ id: 'baseline', stopTimeSec: 10 }]
    });
    expect(badParameter.diagnostics.find((diagnostic) => diagnostic.code === 'parameter.path-invalid')?.repairCandidate?.patch).toEqual([
      { op: 'remove', path: '/parameters/0' }
    ]);

    const unreachable = analyzeDesModel({
      schemaVersion: 'des-platform.v1',
      id: 'route-repair',
      name: 'Route Repair',
      process: {
        id: 'flow',
        blocks: [
          { id: 'source', kind: 'source', scheduleAtSec: [0] },
          { id: 'move', kind: 'moveByTransporter', fleetId: 'amr', fromNodeId: 'dock', toNodeId: 'storage' },
          { id: 'sink', kind: 'sink' }
        ],
        connections: [
          { from: 'source', to: 'move' },
          { from: 'move', to: 'sink' }
        ]
      },
      materialHandling: {
        id: 'layout',
        nodes: [
          { id: 'dock', type: 'dock', x: 0, z: 0 },
          { id: 'storage', type: 'storage', x: 10, z: 0 }
        ],
        paths: [],
        transporterFleets: [{ id: 'amr', count: 1, homeNodeId: 'dock', speedMps: 1.5 }]
      },
      experiments: [{ id: 'baseline', stopTimeSec: 10 }]
    });
    expect(unreachable.diagnostics.find((diagnostic) => diagnostic.code === 'material.route-unreachable')?.repairCandidate).toMatchObject({
      kind: 'proposal',
      requiresUserConfirmation: true,
      patch: [{ op: 'add', path: '/materialHandling/paths/-' }]
    });

    const crossing = analyzeDesModel({
      schemaVersion: 'des-platform.v1',
      id: 'crossing-repair',
      name: 'Crossing Repair',
      process: {
        id: 'flow',
        blocks: [
          { id: 'source', kind: 'source', scheduleAtSec: [0] },
          { id: 'move', kind: 'moveByTransporter', fleetId: 'amr', fromNodeId: 'west', toNodeId: 'east' },
          { id: 'sink', kind: 'sink' }
        ],
        connections: [
          { from: 'source', to: 'move' },
          { from: 'move', to: 'sink' }
        ]
      },
      materialHandling: {
        id: 'layout',
        nodes: [
          { id: 'west', type: 'station', x: 0, z: 5 },
          { id: 'east', type: 'station', x: 10, z: 5 },
          { id: 'south', type: 'station', x: 5, z: 0 },
          { id: 'north', type: 'station', x: 5, z: 10 }
        ],
        paths: [
          { id: 'west-east', from: 'west', to: 'east', bidirectional: true },
          { id: 'south-north', from: 'south', to: 'north', bidirectional: true }
        ],
        transporterFleets: [{ id: 'amr', count: 1, homeNodeId: 'west', speedMps: 1 }]
      },
      experiments: [{ id: 'baseline', stopTimeSec: 10 }]
    });
    const crossingRepair = crossing.diagnostics.find((diagnostic) => diagnostic.code === 'material.unmodeled-path-crossing')?.repairCandidate;

    expect(crossingRepair).toMatchObject({
      kind: 'proposal',
      requiresUserConfirmation: true
    });
    expect(crossingRepair?.patch.map((operation) => operation.op)).toEqual(['add', 'remove', 'remove', 'add', 'add', 'add', 'add']);
  });
});
