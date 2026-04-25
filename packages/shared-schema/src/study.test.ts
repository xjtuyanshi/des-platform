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
