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
      experiments: [{ id: 'baseline', stopTimeSec: 30 }]
    };

    const compiled = compileDesModel(model);
    const result = compiled.runExperiment('baseline');

    expect(compiled.model.id).toBe('mm1-smoke');
    expect(result.snapshot.completedEntities).toBe(4);
    expect(result.snapshot.entities.map((entity) => entity.completedAtSec)).toEqual([5, 10, 15, 20]);
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
