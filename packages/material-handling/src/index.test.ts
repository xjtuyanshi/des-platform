import type { MaterialHandlingDefinition } from '@des-platform/shared-schema/model-dsl';

import { analyzeMaterialHandlingDefinition, calculateTravelProfile, createMaterialHandlingRuntime } from './index.js';

const materialHandling: MaterialHandlingDefinition = {
  id: 'warehouse-material-handling',
  units: 'meter',
  nodes: [
    { id: 'home', type: 'home', x: 0, z: 0 },
    { id: 'dock', type: 'dock', x: 10, z: 0 },
    { id: 'storage', type: 'storage', x: 10, z: 8 },
    { id: 'pack', type: 'station', x: 18, z: 8 }
  ],
  paths: [
    { id: 'home-dock', from: 'home', to: 'dock', lengthM: 10, speedLimitMps: 2, mode: 'path-guided', bidirectional: true, trafficControl: 'reservation', capacity: 1 },
    { id: 'dock-storage', from: 'dock', to: 'storage', lengthM: 8, speedLimitMps: 1, mode: 'path-guided', bidirectional: true, trafficControl: 'reservation', capacity: 1 },
    { id: 'storage-pack', from: 'storage', to: 'pack', lengthM: 8, mode: 'path-guided', bidirectional: true, trafficControl: 'reservation', capacity: 1 }
  ],
  transporterFleets: [
    { id: 'amr', vehicleType: 'amr', navigation: 'path-guided', count: 2, homeNodeId: 'home', idlePolicy: 'stay', speedMps: 1.5, minClearanceM: 0.3 }
  ],
  storageSystems: [{ id: 'rack-a', nodeId: 'storage', capacity: 2 }],
  conveyors: [{ id: 'pack-out', entryNodeId: 'pack', exitNodeId: 'dock', lengthM: 12, speedMps: 0.5 }],
  zones: [],
  obstacles: []
};

describe('MaterialHandlingRuntime', () => {
  it('calculates constant, triangular, and trapezoidal travel profiles', () => {
    expect(calculateTravelProfile(10, 2)).toMatchObject({
      kind: 'constant-speed',
      travelTimeSec: 5
    });

    const triangular = calculateTravelProfile(10, 4, 1, 1);
    expect(triangular.kind).toBe('triangular');
    expect(triangular.travelTimeSec).toBeCloseTo(2 * Math.sqrt(10), 5);

    const trapezoidal = calculateTravelProfile(20, 2, 1, 1);
    expect(trapezoidal.kind).toBe('trapezoidal');
    expect(trapezoidal.travelTimeSec).toBe(12);
  });

  it('plans shortest routes using path speed limits and fleet speed fallback', () => {
    const runtime = createMaterialHandlingRuntime(materialHandling);

    const route = runtime.findShortestRoute('home', 'pack', 'amr');

    expect(route.nodeIds).toEqual(['home', 'dock', 'storage', 'pack']);
    expect(route.pathIds).toEqual(['home-dock', 'dock-storage', 'storage-pack']);
    expect(route.distanceM).toBe(26);
    expect(route.travelTimeSec).toBeCloseTo(10 / 1.5 + 8 / 1 + 8 / 1.5, 5);
  });

  it('uses fleet acceleration and deceleration in route timing', () => {
    const runtime = createMaterialHandlingRuntime({
      ...materialHandling,
      nodes: [
        { id: 'a', type: 'home', x: 0, z: 0 },
        { id: 'b', type: 'station', x: 10, z: 0 }
      ],
      paths: [{ id: 'a-b', from: 'a', to: 'b', lengthM: 10, bidirectional: true, trafficControl: 'reservation', capacity: 1, mode: 'path-guided' }],
      transporterFleets: [{ id: 'amr', vehicleType: 'amr', navigation: 'path-guided', count: 1, homeNodeId: 'a', idlePolicy: 'stay', speedMps: 4, accelerationMps2: 1, decelerationMps2: 1, minClearanceM: 0 }],
      storageSystems: [],
      conveyors: []
    });

    const route = runtime.findShortestRoute('a', 'b', 'amr');
    const reserved = runtime.reserveRoute('a', 'b', 'amr', 0);

    expect(route.travelTimeSec).toBeCloseTo(2 * Math.sqrt(10), 5);
    expect(reserved.segments[0]?.travelProfile.kind).toBe('triangular');
    expect(reserved.travelEndSec).toBeCloseTo(route.travelTimeSec, 5);
  });

  it('reserves path-guided aisle capacity to serialize conflicting moves', () => {
    const runtime = createMaterialHandlingRuntime(materialHandling);

    const first = runtime.reserveRoute('dock', 'storage', 'amr', 0);
    const second = runtime.reserveRoute('dock', 'storage', 'amr', 0);
    const third = runtime.reserveRoute('storage', 'dock', 'amr', 4);

    expect(first.travelTimeSec).toBe(8);
    expect(first.trafficWaitSec).toBe(0);
    expect(second.trafficWaitSec).toBe(8);
    expect(second.travelEndSec).toBe(16);
    expect(third.trafficWaitSec).toBe(12);
    expect(runtime.getSnapshot().pathReservations.find((path) => path.pathId === 'dock-storage')?.reservations).toHaveLength(3);
  });

  it('seizes and releases transporter units deterministically', () => {
    const runtime = createMaterialHandlingRuntime(materialHandling);

    const first = runtime.seizeTransporter('amr', 'order-1');
    const second = runtime.seizeTransporter('amr', 'order-2');
    const none = runtime.seizeTransporter('amr', 'order-3');

    expect(first?.id).toBe('amr-1');
    expect(second?.id).toBe('amr-2');
    expect(none).toBeNull();
    expect(runtime.releaseTransporter('amr-1', 'dock')).toMatchObject({
      status: 'idle',
      currentNodeId: 'dock',
      assignedEntityId: null
    });
  });

  it('assigns the nearest idle transporter when a pickup node is provided', () => {
    const runtime = createMaterialHandlingRuntime({
      id: 'nearest-dispatch',
      units: 'meter',
      nodes: [
        { id: 'home', type: 'home', x: 0, z: 0 },
        { id: 'near', type: 'station', x: 1, z: 0 },
        { id: 'far', type: 'station', x: 100, z: 0 }
      ],
      paths: [
        { id: 'home-near', from: 'home', to: 'near', lengthM: 1, mode: 'path-guided', bidirectional: true, trafficControl: 'reservation', capacity: 1 },
        { id: 'home-far', from: 'home', to: 'far', lengthM: 100, mode: 'path-guided', bidirectional: true, trafficControl: 'reservation', capacity: 1 }
      ],
      transporterFleets: [
        { id: 'amr', vehicleType: 'amr', navigation: 'path-guided', count: 2, homeNodeId: 'home', idlePolicy: 'stay', speedMps: 1, minClearanceM: 0 }
      ],
      storageSystems: [],
      conveyors: [],
      zones: [],
      obstacles: []
    });

    expect(runtime.seizeTransporter('amr', 'order-1')?.id).toBe('amr-1');
    runtime.releaseTransporter('amr-1', 'far');

    expect(runtime.seizeTransporter('amr', 'order-2', 'near')?.id).toBe('amr-2');
  });

  it('starts fleets at parking nodes and reports path conflict diagnostics', () => {
    const runtime = createMaterialHandlingRuntime({
      ...materialHandling,
      nodes: [...materialHandling.nodes, { id: 'parking', type: 'parking', x: -4, z: 0 }],
      transporterFleets: [
        { id: 'amr', vehicleType: 'amr', navigation: 'path-guided', count: 1, homeNodeId: 'home', parkingNodeId: 'parking', idlePolicy: 'return-parking', speedMps: 1.5, minClearanceM: 0.3 }
      ]
    });

    expect(runtime.getSnapshot().transporterUnits[0]?.currentNodeId).toBe('parking');

    const diagnostics = analyzeMaterialHandlingDefinition({
      ...materialHandling,
      paths: [
        ...materialHandling.paths,
        { id: 'dock-storage-duplicate', from: 'dock', to: 'storage', lengthM: 8, bidirectional: true, trafficControl: 'reservation', capacity: 1, mode: 'path-guided' }
      ]
    });

    expect(diagnostics.some((diagnostic) => diagnostic.code === 'material.parallel-paths')).toBe(true);
  });

  it('tracks storage occupancy and conveyor travel time', () => {
    const runtime = createMaterialHandlingRuntime(materialHandling);

    expect(runtime.store('rack-a', 'pallet-1').id).toBe('rack-a-slot-1');
    expect(runtime.store('rack-a', 'pallet-2').id).toBe('rack-a-slot-2');
    expect(() => runtime.store('rack-a', 'pallet-3')).toThrow(/full/);
    expect(runtime.retrieve('rack-a', 'pallet-1')).toMatchObject({ id: 'rack-a-slot-1', itemId: null });
    expect(runtime.getConveyorTravelTimeSec('pack-out')).toBe(24);
  });
});
