import { compileDesModel, runDesModel } from './index.js';

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
});
