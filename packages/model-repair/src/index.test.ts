import { analyzeDesModel, compileDesModel } from '@des-platform/model-compiler';

import { analyzeRepairOptions, applySelectedRepairs, stableHash, validateRepair } from './index.js';

function optionIdFor(model: unknown, code: string): string {
  const option = analyzeRepairOptions(model).options.find((candidate) => candidate.diagnostic.code === code);
  if (!option) {
    throw new Error(`Expected repair option for ${code}`);
  }
  return option.id;
}

describe('model repair API', () => {
  it('plans repair candidates with deterministic ids and model hash', () => {
    const model = {
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

    const first = analyzeRepairOptions(model);
    const second = analyzeRepairOptions(structuredClone(model));

    expect(first.modelHash).toBe(stableHash(model));
    expect(first.options.map((option) => option.id)).toEqual(second.options.map((option) => option.id));
    expect(first.safeAutoApplyCount).toBe(2);
    expect(first.requiresConfirmationCount).toBe(0);
  });

  it('auto-applies safe schema repairs and re-diagnoses the repaired model', () => {
    const model = {
      schemaVersion: 'des-platform.v1',
      id: 'safe-schema-repair',
      name: 'Safe Schema Repair',
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

    const repaired = applySelectedRepairs(model);

    expect(repaired.auditTrail).toHaveLength(2);
    expect(repaired.auditTrail.every((entry) => entry.userDecision === 'autoApplied')).toBe(true);
    expect(repaired.diagnosticsAfter.valid).toBe(true);
    expect(repaired.diagnosticsAfter.diagnostics.map((diagnostic) => diagnostic.code)).not.toContain('schema.invalid');
  });

  it('applies a confirmed dead-end repair and removes the graph diagnostics', () => {
    const model = {
      schemaVersion: 'des-platform.v1',
      id: 'dead-end-repair-api',
      name: 'Dead End Repair API',
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

    const repaired = applySelectedRepairs(model, { candidateIds: [optionIdFor(model, 'process.dead-end')] });
    const codes = repaired.diagnosticsAfter.diagnostics.map((diagnostic) => diagnostic.code);

    expect(repaired.auditTrail[0]).toMatchObject({
      diagnosticCode: 'process.dead-end',
      userDecision: 'accepted'
    });
    expect(codes).not.toContain('process.dead-end');
    expect(codes).not.toContain('process.source-cannot-reach-sink');
    expect(repaired.diagnosticsAfter.valid).toBe(true);
  });

  it('repairs missing experiments and bad parameter paths through apply-and-rediagnose', () => {
    const noExperiment = {
      schemaVersion: 'des-platform.v1',
      id: 'missing-experiment',
      name: 'Missing Experiment',
      process: {
        id: 'flow',
        blocks: [
          { id: 'source', kind: 'source', scheduleAtSec: [0] },
          { id: 'sink', kind: 'sink' }
        ],
        connections: [{ from: 'source', to: 'sink' }]
      }
    };
    const repairedExperiment = applySelectedRepairs(noExperiment);
    expect(repairedExperiment.diagnosticsAfter.diagnostics.map((diagnostic) => diagnostic.code)).not.toContain('experiment.none');
    expect(repairedExperiment.diagnosticsAfter.valid).toBe(true);

    const badParameter = {
      schemaVersion: 'des-platform.v1',
      id: 'bad-param-repair-api',
      name: 'Bad Param Repair API',
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
    };
    const repairedParameter = applySelectedRepairs(badParameter, { candidateIds: [optionIdFor(badParameter, 'parameter.path-invalid')] });
    expect(repairedParameter.auditTrail[0]?.repairCandidate.kind).toBe('proposal');
    expect(repairedParameter.diagnosticsAfter.diagnostics.map((diagnostic) => diagnostic.code)).not.toContain('parameter.path-invalid');
    expect(repairedParameter.diagnosticsAfter.valid).toBe(true);
  });

  it('applies an unreachable route proposal and keeps the model runnable', () => {
    const model = {
      schemaVersion: 'des-platform.v1',
      id: 'route-repair-api',
      name: 'Route Repair API',
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
      experiments: [{ id: 'baseline', stopTimeSec: 20 }]
    };

    const repaired = applySelectedRepairs(model, { candidateIds: [optionIdFor(model, 'material.route-unreachable')] });

    expect(repaired.auditTrail[0]?.userDecision).toBe('accepted');
    expect(repaired.diagnosticsAfter.diagnostics.map((diagnostic) => diagnostic.code)).not.toContain('material.route-unreachable');
    expect(compileDesModel(repaired.model).runExperiment('baseline').snapshot.completedEntities).toBe(1);
  });

  it('applies a crossing split proposal and validates the repaired material graph', () => {
    const model = {
      schemaVersion: 'des-platform.v1',
      id: 'crossing-repair-api',
      name: 'Crossing Repair API',
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
      experiments: [{ id: 'baseline', stopTimeSec: 20 }]
    };

    expect(analyzeDesModel(model).diagnostics.map((diagnostic) => diagnostic.code)).toContain('material.unmodeled-path-crossing');
    const repaired = applySelectedRepairs(model, { candidateIds: [optionIdFor(model, 'material.unmodeled-path-crossing')] });
    const codes = repaired.diagnosticsAfter.diagnostics.map((diagnostic) => diagnostic.code);

    expect(codes).not.toContain('material.unmodeled-path-crossing');
    expect(compileDesModel(repaired.model).runExperiment('baseline').snapshot.completedEntities).toBe(1);
  });

  it('summarizes validation deltas after repair', () => {
    const model = {
      schemaVersion: 'des-platform.v1',
      id: 'validation-delta',
      name: 'Validation Delta',
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
    const repaired = applySelectedRepairs(model, { candidateIds: [optionIdFor(model, 'process.dead-end')] });
    const validation = validateRepair(model, repaired.model);

    expect(validation.validBefore).toBe(false);
    expect(validation.validAfter).toBe(true);
    expect(validation.removedDiagnosticCodes).toEqual(expect.arrayContaining(['process.dead-end', 'process.source-cannot-reach-sink']));
    expect(validation.severeDiagnosticsAfter).toHaveLength(0);
  });
});
