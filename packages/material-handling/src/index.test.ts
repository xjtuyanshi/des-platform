import type { MaterialHandlingDefinition } from '@des-platform/shared-schema/model-dsl';

import { createMaterialHandlingRuntime } from './index.js';

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
    { id: 'home-dock', from: 'home', to: 'dock', lengthM: 10, speedLimitMps: 2, mode: 'path-guided', bidirectional: true },
    { id: 'dock-storage', from: 'dock', to: 'storage', lengthM: 8, speedLimitMps: 1, mode: 'path-guided', bidirectional: true },
    { id: 'storage-pack', from: 'storage', to: 'pack', lengthM: 8, mode: 'path-guided', bidirectional: true }
  ],
  transporterFleets: [
    { id: 'amr', vehicleType: 'amr', navigation: 'path-guided', count: 2, homeNodeId: 'home', speedMps: 1.5, minClearanceM: 0.3 }
  ],
  storageSystems: [{ id: 'rack-a', nodeId: 'storage', capacity: 2 }],
  conveyors: [{ id: 'pack-out', entryNodeId: 'pack', exitNodeId: 'dock', lengthM: 12, speedMps: 0.5 }],
  zones: [],
  obstacles: []
};

describe('MaterialHandlingRuntime', () => {
  it('plans shortest routes using path speed limits and fleet speed fallback', () => {
    const runtime = createMaterialHandlingRuntime(materialHandling);

    const route = runtime.findShortestRoute('home', 'pack', 'amr');

    expect(route.nodeIds).toEqual(['home', 'dock', 'storage', 'pack']);
    expect(route.pathIds).toEqual(['home-dock', 'dock-storage', 'storage-pack']);
    expect(route.distanceM).toBe(26);
    expect(route.travelTimeSec).toBeCloseTo(10 / 2 + 8 / 1 + 8 / 1.5, 5);
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

  it('tracks storage occupancy and conveyor travel time', () => {
    const runtime = createMaterialHandlingRuntime(materialHandling);

    expect(runtime.store('rack-a', 'pallet-1').id).toBe('rack-a-slot-1');
    expect(runtime.store('rack-a', 'pallet-2').id).toBe('rack-a-slot-2');
    expect(() => runtime.store('rack-a', 'pallet-3')).toThrow(/full/);
    expect(runtime.retrieve('rack-a', 'pallet-1')).toMatchObject({ id: 'rack-a-slot-1', itemId: null });
    expect(runtime.getConveyorTravelTimeSec('pack-out')).toBe(24);
  });
});
