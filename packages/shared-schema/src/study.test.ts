import { SimulationStudyCaseDefinitionSchema } from './study.js';

describe('simulation study schema', () => {
  it('validates a one-file simulation study case', () => {
    const study = SimulationStudyCaseDefinitionSchema.parse({
      schemaVersion: 'des-platform.study.v1',
      id: 'study-smoke',
      name: 'Study Smoke',
      modelPath: '../models/fulfillment-center-mvp.json',
      runs: [{ experimentId: 'baseline' }],
      replications: [{ experimentId: 'baseline', htmlReport: false }],
      sweeps: [{ experimentId: 'throughput-sweep', outputName: 'throughput' }]
    });

    expect(study.validate).toBe(true);
    expect(study.failOnValidationError).toBe(true);
    expect(study.runs[0]?.htmlReport).toBe(true);
    expect(study.replications[0]?.htmlReport).toBe(false);
    expect(study.sweeps[0]?.outputName).toBe('throughput');
  });

  it('supports an inline model for self-contained case files', () => {
    const study = SimulationStudyCaseDefinitionSchema.parse({
      schemaVersion: 'des-platform.study.v1',
      id: 'inline-study-smoke',
      name: 'Inline Study Smoke',
      model: {
        schemaVersion: 'des-platform.v1',
        id: 'inline-model-smoke',
        name: 'Inline Model Smoke',
        process: {
          id: 'flow',
          blocks: [
            { id: 'source', kind: 'source', scheduleAtSec: [0] },
            { id: 'delay', kind: 'delay', durationSec: 5 },
            { id: 'sink', kind: 'sink' }
          ],
          connections: [
            { from: 'source', to: 'delay' },
            { from: 'delay', to: 'sink' }
          ]
        },
        experiments: [{ id: 'baseline', stopTimeSec: 20 }]
      },
      runs: [{ experimentId: 'baseline' }]
    });

    expect(study.modelPath).toBeUndefined();
    expect(study.model?.id).toBe('inline-model-smoke');
  });

  it('requires exactly one model source', () => {
    expect(() =>
      SimulationStudyCaseDefinitionSchema.parse({
        schemaVersion: 'des-platform.study.v1',
        id: 'missing-model',
        name: 'Missing Model',
        runs: [{ experimentId: 'baseline' }]
      })
    ).toThrow(/modelPath or an inline model/);

    expect(() =>
      SimulationStudyCaseDefinitionSchema.parse({
        schemaVersion: 'des-platform.study.v1',
        id: 'duplicate-model-source',
        name: 'Duplicate Model Source',
        modelPath: '../models/fulfillment-center-mvp.json',
        model: {
          schemaVersion: 'des-platform.v1',
          id: 'inline-model-smoke',
          name: 'Inline Model Smoke',
          process: {
            id: 'flow',
            blocks: [
              { id: 'source', kind: 'source', scheduleAtSec: [0] },
              { id: 'sink', kind: 'sink' }
            ],
            connections: [{ from: 'source', to: 'sink' }]
          },
          experiments: [{ id: 'baseline', stopTimeSec: 20 }]
        },
        runs: [{ experimentId: 'baseline' }]
      })
    ).toThrow(/not both/);
  });

  it('requires at least one operation', () => {
    expect(() =>
      SimulationStudyCaseDefinitionSchema.parse({
        schemaVersion: 'des-platform.study.v1',
        id: 'empty',
        name: 'Empty',
        modelPath: '../models/fulfillment-center-mvp.json'
      })
    ).toThrow(/at least one run/);
  });
});
