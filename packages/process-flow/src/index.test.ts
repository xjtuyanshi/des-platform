import type { ProcessFlowDefinition } from '@des-platform/shared-schema/model-dsl';

import { runProcessFlow } from './index.js';

describe('ProcessFlowRuntime', () => {
  it('runs a source-delay-sink flow deterministically', () => {
    const flow: ProcessFlowDefinition = {
      id: 'source-delay-sink',
      resourcePools: [],
      blocks: [
        { id: 'source', kind: 'source', entityType: 'part', startAtSec: 0, intervalSec: 5, maxArrivals: 3, attributes: {} },
        { id: 'delay', kind: 'delay', durationSec: 2 },
        { id: 'sink', kind: 'sink' }
      ],
      connections: [
        { from: 'source', to: 'delay' },
        { from: 'delay', to: 'sink' }
      ]
    };

    const result = runProcessFlow(flow, 20);

    expect(result.snapshot.completedEntities).toBe(3);
    expect(result.snapshot.entities.map((entity) => entity.completedAtSec)).toEqual([2, 7, 12]);
    expect(result.snapshot.blockStats.sink?.entered).toBe(3);
  });

  it('queues service requests against constrained resource pools', () => {
    const flow: ProcessFlowDefinition = {
      id: 'single-machine',
      resourcePools: [{ id: 'machine', capacity: 1 }],
      blocks: [
        { id: 'source', kind: 'source', entityType: 'job', startAtSec: 0, scheduleAtSec: [0, 0, 0], attributes: {} },
        { id: 'service', kind: 'service', resourcePoolId: 'machine', quantity: 1, durationSec: 10 },
        { id: 'sink', kind: 'sink' }
      ],
      connections: [
        { from: 'source', to: 'service' },
        { from: 'service', to: 'sink' }
      ]
    };

    const result = runProcessFlow(flow, 35);

    expect(result.snapshot.completedEntities).toBe(3);
    expect(result.snapshot.entities.map((entity) => entity.completedAtSec)).toEqual([10, 20, 30]);
    expect(result.snapshot.resourcePools[0]?.maxQueueLength).toBe(2);
  });

  it('supports explicit seize and release blocks for held resources', () => {
    const flow: ProcessFlowDefinition = {
      id: 'held-operator',
      resourcePools: [{ id: 'operator', capacity: 1 }],
      blocks: [
        { id: 'source', kind: 'source', entityType: 'case', startAtSec: 0, scheduleAtSec: [0, 0], attributes: {} },
        { id: 'seize', kind: 'seize', resourcePoolId: 'operator', quantity: 1 },
        { id: 'work', kind: 'delay', durationSec: 4 },
        { id: 'release', kind: 'release', resourcePoolId: 'operator', quantity: 1 },
        { id: 'sink', kind: 'sink' }
      ],
      connections: [
        { from: 'source', to: 'seize' },
        { from: 'seize', to: 'work' },
        { from: 'work', to: 'release' },
        { from: 'release', to: 'sink' }
      ]
    };

    const result = runProcessFlow(flow, 10);

    expect(result.snapshot.entities.map((entity) => entity.completedAtSec)).toEqual([4, 8]);
    expect(result.snapshot.resourcePools[0]?.available).toBe(1);
  });

  it('routes selectOutput blocks by entity attributes with a fallback branch', () => {
    const flow: ProcessFlowDefinition = {
      id: 'select-output',
      resourcePools: [],
      blocks: [
        { id: 'vip-source', kind: 'source', entityType: 'order', startAtSec: 0, scheduleAtSec: [0], attributes: { priority: 'vip' } },
        { id: 'std-source', kind: 'source', entityType: 'order', startAtSec: 0, scheduleAtSec: [1], attributes: { priority: 'standard' } },
        { id: 'select', kind: 'selectOutput' },
        { id: 'vip-sink', kind: 'sink' },
        { id: 'standard-sink', kind: 'sink' }
      ],
      connections: [
        { from: 'vip-source', to: 'select' },
        { from: 'std-source', to: 'select' },
        { from: 'select', to: 'standard-sink' },
        { from: 'select', to: 'vip-sink', condition: { attribute: 'priority', operator: 'equals', value: 'vip' } }
      ]
    };

    const result = runProcessFlow(flow, 5);

    expect(result.snapshot.completedEntities).toBe(2);
    expect(result.snapshot.blockStats['vip-sink']?.entered).toBe(1);
    expect(result.snapshot.blockStats['standard-sink']?.entered).toBe(1);
  });
});
