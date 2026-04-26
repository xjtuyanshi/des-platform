import { applyDesStudyRepairs, diagnoseDesStudy, draftDesStudy, planDesStudyRepairs, repairDesStudy } from './authoring.js';

describe('DES authoring API helpers', () => {
  it('drafts a runnable inline study from a brief without an LLM key', async () => {
    const result = await draftDesStudy({
      provider: 'rules',
      brief: 'Warehouse orders arrive every minute. Three AMRs move totes to picking and packing.'
    });

    expect(result.provider).toBe('rules');
    expect(result.valid).toBe(true);
    expect(result.study?.model?.process.blocks.some((block) => block.kind === 'moveByTransporter')).toBe(true);
    expect(result.study?.model?.materialHandling?.transporterFleets[0]?.parkingNodeId).toBe('parking');
    expect(result.study?.model?.materialHandling?.transporterFleets[0]?.count).toBe(3);
    expect(result.study?.model?.parameters.find((parameter) => parameter.id === 'arrival-mean-sec')?.defaultValue).toBe(60);
    expect(result.study?.model?.parameters.find((parameter) => parameter.id === 'amr-count')?.defaultValue).toBe(3);
    expect(result.study?.model?.materialHandling?.nodes.some((node) => node.id === 'bypass-a')).toBe(true);
    expect(result.study?.model?.materialHandling?.paths.some((path) => path.id === 'dock-work')).toBe(false);
  });

  it('parses high-load fleet and worker counts from natural language', async () => {
    const result = await draftDesStudy({
      provider: 'rules',
      brief: 'Orders arrive every 5 seconds. 3 AMRs move totes and three pickers work in parallel.'
    });

    expect(result.valid).toBe(true);
    expect(result.study?.model?.materialHandling?.transporterFleets[0]?.count).toBe(3);
    expect(result.study?.model?.process.resourcePools[0]?.capacity).toBe(3);
    expect(result.study?.model?.parameters.find((parameter) => parameter.id === 'arrival-mean-sec')?.defaultValue).toBe(5);
  });

  it('diagnoses invalid drafts and repairs missing study wrappers', () => {
    const brokenModel = {
      schemaVersion: 'des-platform.v1',
      id: 'broken',
      name: 'Broken',
      process: {
        id: 'flow',
        blocks: [
          { id: 'source', kind: 'source', scheduleAtSec: [0] },
          { id: 'sink', kind: 'sink' }
        ],
        connections: [{ from: 'source', to: 'sink' }]
      }
    };

    const diagnosed = diagnoseDesStudy(brokenModel);
    expect(diagnosed.valid).toBe(false);
    expect(diagnosed.diagnostics.some((diagnostic) => diagnostic.source === 'schema')).toBe(true);

    const repaired = repairDesStudy({ study: brokenModel });
    expect(repaired.repaired).toBe(true);
    expect(repaired.valid).toBe(true);
    expect(repaired.study?.runs[0]?.experimentId).toBe('baseline');
  });

  it('plans and applies selected repair candidates with audit trail', () => {
    const study = {
      schemaVersion: 'des-platform.study.v1',
      id: 'authoring-repair-loop',
      name: 'Authoring Repair Loop',
      model: {
        schemaVersion: 'des-platform.v1',
        id: 'authoring-repair-loop-model',
        name: 'Authoring Repair Loop Model',
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
      },
      runs: [{ experimentId: 'baseline' }]
    };

    const plan = planDesStudyRepairs(study);
    const deadEnd = plan.repairOptions.find((option) => option.diagnostic.code === 'process.dead-end');
    expect(deadEnd?.candidate.requiresUserConfirmation).toBe(true);

    const repaired = applyDesStudyRepairs({ study, candidateIds: [deadEnd!.id] });
    expect(repaired.valid).toBe(true);
    expect(repaired.repairAuditTrail).toHaveLength(1);
    expect(repaired.repairAuditTrail[0]).toMatchObject({
      diagnosticCode: 'process.dead-end',
      userDecision: 'accepted'
    });
    expect(repaired.repairValidation?.validAfter).toBe(true);
  });
});
