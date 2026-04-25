import type { ProcessFlowDefinition } from '@des-platform/shared-schema/model-dsl';
import { createMaterialHandlingRuntime } from '@des-platform/material-handling';

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
    expect(result.snapshot.resourcePools[0]).toMatchObject({
      busyTimeSec: 30,
      totalWaitTimeSec: 30,
      completedRequests: 3,
      averageWaitTimeSec: 10
    });
  });

  it('samples stochastic interarrival and service times reproducibly by seed', () => {
    const flow: ProcessFlowDefinition = {
      id: 'stochastic-single-machine',
      resourcePools: [{ id: 'machine', capacity: 1 }],
      blocks: [
        {
          id: 'source',
          kind: 'source',
          entityType: 'job',
          startAtSec: 0,
          intervalSec: { kind: 'uniform', min: 1, max: 3 },
          maxArrivals: 5,
          attributes: {}
        },
        {
          id: 'service',
          kind: 'service',
          resourcePoolId: 'machine',
          quantity: 1,
          durationSec: { kind: 'triangular', min: 2, mode: 4, max: 8 }
        },
        { id: 'sink', kind: 'sink' }
      ],
      connections: [
        { from: 'source', to: 'service' },
        { from: 'service', to: 'sink' }
      ]
    };

    const resultA = runProcessFlow(flow, 100, undefined, { seed: 42 });
    const resultB = runProcessFlow(flow, 100, undefined, { seed: 42 });
    const resultC = runProcessFlow(flow, 100, undefined, { seed: 43 });

    const completedA = resultA.snapshot.entities.map((entity) => entity.completedAtSec);
    const completedB = resultB.snapshot.entities.map((entity) => entity.completedAtSec);
    const completedC = resultC.snapshot.entities.map((entity) => entity.completedAtSec);

    expect(resultA.snapshot.completedEntities).toBe(5);
    expect(completedA).toEqual(completedB);
    expect(completedA).not.toEqual(completedC);
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

  it('assigns attributes and routes selectOutput blocks with numeric conditions', () => {
    const flow: ProcessFlowDefinition = {
      id: 'assign-and-numeric-select',
      resourcePools: [],
      blocks: [
        { id: 'source', kind: 'source', entityType: 'order', startAtSec: 0, scheduleAtSec: [0], attributes: { score: 2 } },
        { id: 'assign', kind: 'assign', assignments: { score: 7, lane: 'fast' } },
        { id: 'select', kind: 'selectOutput' },
        { id: 'fast-sink', kind: 'sink' },
        { id: 'standard-sink', kind: 'sink' }
      ],
      connections: [
        { from: 'source', to: 'assign' },
        { from: 'assign', to: 'select' },
        { from: 'select', to: 'fast-sink', condition: { attribute: 'score', operator: 'greater-than-or-equal', value: 5 } },
        { from: 'select', to: 'standard-sink' }
      ]
    };

    const result = runProcessFlow(flow, 5);

    expect(result.snapshot.completedEntities).toBe(1);
    expect(result.snapshot.entities[0]?.attributes).toMatchObject({ score: 7, lane: 'fast' });
    expect(result.snapshot.blockStats['fast-sink']?.entered).toBe(1);
    expect(result.snapshot.blockStats['standard-sink']?.entered).toBe(0);
  });

  it('routes selectOutput probability branches with seeded randomness', () => {
    const flow: ProcessFlowDefinition = {
      id: 'probability-select',
      resourcePools: [],
      blocks: [
        { id: 'source', kind: 'source', entityType: 'order', startAtSec: 0, scheduleAtSec: [0, 1, 2, 3, 4, 5], attributes: {} },
        { id: 'select', kind: 'selectOutput' },
        { id: 'express-sink', kind: 'sink' },
        { id: 'standard-sink', kind: 'sink' }
      ],
      connections: [
        { from: 'source', to: 'select' },
        { from: 'select', to: 'express-sink', probability: 0.25 },
        { from: 'select', to: 'standard-sink' }
      ]
    };

    const resultA = runProcessFlow(flow, 10, undefined, { seed: 123 });
    const resultB = runProcessFlow(flow, 10, undefined, { seed: 123 });

    expect(resultA.snapshot.blockStats['express-sink']?.entered).toBe(resultB.snapshot.blockStats['express-sink']?.entered);
    expect(resultA.snapshot.blockStats['standard-sink']?.entered).toBe(resultB.snapshot.blockStats['standard-sink']?.entered);
    expect((resultA.snapshot.blockStats['express-sink']?.entered ?? 0) + (resultA.snapshot.blockStats['standard-sink']?.entered ?? 0)).toBe(6);
  });

  it('executes material handling blocks through a material runtime', () => {
    const materialHandling = createMaterialHandlingRuntime({
      id: 'warehouse',
      units: 'meter',
      nodes: [
        { id: 'dock', type: 'dock', x: 0, z: 0 },
        { id: 'storage', type: 'storage', x: 10, z: 0 },
        { id: 'pack', type: 'station', x: 10, z: 5 },
        { id: 'ship', type: 'dock', x: 20, z: 5 }
      ],
      paths: [{ id: 'dock-storage', from: 'dock', to: 'storage', lengthM: 10, speedLimitMps: 2, bidirectional: true, mode: 'path-guided' }],
      transporterFleets: [{ id: 'amr', vehicleType: 'amr', navigation: 'path-guided', count: 1, homeNodeId: 'dock', speedMps: 1.5, minClearanceM: 0 }],
      storageSystems: [{ id: 'rack', nodeId: 'storage', capacity: 1 }],
      conveyors: [{ id: 'pack-ship', entryNodeId: 'pack', exitNodeId: 'ship', lengthM: 6, speedMps: 1 }],
      zones: [],
      obstacles: []
    });
    const flow: ProcessFlowDefinition = {
      id: 'material-blocks',
      resourcePools: [],
      blocks: [
        { id: 'source', kind: 'source', entityType: 'pallet', startAtSec: 0, scheduleAtSec: [0], attributes: {} },
        { id: 'move', kind: 'moveByTransporter', fleetId: 'amr', fromNodeId: 'dock', toNodeId: 'storage', loadTimeSec: 1, unloadTimeSec: 2 },
        { id: 'store', kind: 'store', storageId: 'rack' },
        { id: 'retrieve', kind: 'retrieve', storageId: 'rack' },
        { id: 'convey', kind: 'convey', conveyorId: 'pack-ship' },
        { id: 'sink', kind: 'sink' }
      ],
      connections: [
        { from: 'source', to: 'move' },
        { from: 'move', to: 'store' },
        { from: 'store', to: 'retrieve' },
        { from: 'retrieve', to: 'convey' },
        { from: 'convey', to: 'sink' }
      ]
    };

    const result = runProcessFlow(flow, 20, undefined, { materialHandling });

    expect(result.snapshot.completedEntities).toBe(1);
    expect(result.snapshot.entities[0]?.completedAtSec).toBe(14);
    expect(result.snapshot.entities[0]?.attributes.locationNodeId).toBe('ship');
    expect(result.snapshot.entities[0]?.attributes.lastRouteTravelTimeSec).toBe(5);
    expect(result.snapshot.materialHandling?.transporterUnits[0]).toMatchObject({
      status: 'idle',
      currentNodeId: 'storage'
    });
    expect(result.snapshot.materialHandling?.storageSystems[0]?.slots[0]?.itemId).toBeNull();
  });

  it('includes empty transporter travel from the current vehicle node to the pickup node', () => {
    const materialHandling = createMaterialHandlingRuntime({
      id: 'empty-travel',
      units: 'meter',
      nodes: [
        { id: 'dock', type: 'dock', x: 0, z: 0 },
        { id: 'rack', type: 'storage', x: 10, z: 0 }
      ],
      paths: [{ id: 'dock-rack', from: 'dock', to: 'rack', lengthM: 10, speedLimitMps: 1, bidirectional: true, mode: 'path-guided' }],
      transporterFleets: [{ id: 'amr', vehicleType: 'amr', navigation: 'path-guided', count: 1, homeNodeId: 'dock', speedMps: 1, minClearanceM: 0 }],
      storageSystems: [],
      conveyors: [],
      zones: [],
      obstacles: []
    });
    const flow: ProcessFlowDefinition = {
      id: 'empty-travel-flow',
      resourcePools: [],
      blocks: [
        { id: 'source', kind: 'source', entityType: 'pallet', startAtSec: 0, scheduleAtSec: [0, 1], attributes: {} },
        { id: 'move', kind: 'moveByTransporter', fleetId: 'amr', fromNodeId: 'dock', toNodeId: 'rack', loadTimeSec: 0, unloadTimeSec: 0 },
        { id: 'sink', kind: 'sink' }
      ],
      connections: [
        { from: 'source', to: 'move' },
        { from: 'move', to: 'sink' }
      ]
    };

    const result = runProcessFlow(flow, 40, undefined, { materialHandling });

    expect(result.snapshot.entities.map((entity) => entity.completedAtSec)).toEqual([10, 30]);
    expect(result.snapshot.entities[0]?.attributes.lastEmptyRouteTravelTimeSec).toBe(0);
    expect(result.snapshot.entities[1]?.attributes.lastEmptyRouteTravelTimeSec).toBe(10);
    expect(result.snapshot.entities[1]?.attributes.lastRouteTravelTimeSec).toBe(20);
    expect(result.snapshot.transporterFleetStats[0]).toMatchObject({
      fleetId: 'amr',
      moveRequests: 2,
      startedMoves: 2,
      completedMoves: 2,
      totalWaitTimeSec: 9,
      averageWaitTimeSec: 4.5,
      totalBusyTimeSec: 30,
      totalEmptyDistanceM: 10,
      totalLoadedDistanceM: 20,
      totalDistanceM: 30,
      totalEmptyTravelTimeSec: 10,
      totalLoadedTravelTimeSec: 20,
      totalTravelTimeSec: 30
    });
  });
});
