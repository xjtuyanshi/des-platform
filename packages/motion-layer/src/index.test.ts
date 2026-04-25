import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AMR } from '@des-platform/domain-model';
import { loadLayoutDefinition } from '@des-platform/shared-schema/loader';
import { AiNativeDesModelDefinitionSchema } from '@des-platform/shared-schema/model-dsl';

import { MotionWorld, verifyMaterialHandlingMotion } from './index.js';

describe('MotionWorld', () => {
  it('finds a routed path longer than the straight-line distance when obstacles force a bypass', async () => {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const layoutPath = path.resolve(currentDir, '../../../config/layouts/baseline-layout.json');
    const layout = await loadLayoutDefinition(layoutPath);
    const motionWorld = await MotionWorld.create(layout);

    const route = motionWorld.findShortestPath('aisle-s3', 'aisle-s5');
    const directDistance = Math.hypot(40.95 - 30.75, 11.3 - 11.3);

    expect(route.distanceM).toBeGreaterThan(directDistance);
    expect(route.nodeIds).toContain('bypass-1-a');
  });

  it('uses the longer back-lane path in the obstacle stress layout', async () => {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const baselineLayoutPath = path.resolve(currentDir, '../../../config/layouts/baseline-layout.json');
    const stressLayoutPath = path.resolve(currentDir, '../../../config/layouts/obstacle-stress-layout.json');

    const baselineLayout = await loadLayoutDefinition(baselineLayoutPath);
    const stressLayout = await loadLayoutDefinition(stressLayoutPath);
    const baselineWorld = await MotionWorld.create(baselineLayout);
    const stressWorld = await MotionWorld.create(stressLayout);

    const baselineRoute = baselineWorld.findShortestPath('entry', 'drop-s9');
    const stressRoute = stressWorld.findShortestPath('entry', 'drop-s9');

    expect(stressRoute.distanceM).toBeGreaterThan(baselineRoute.distanceM);
    expect(stressRoute.nodeIds).toContain('stress-s9-route');
  });

  it('uses free-space runtime waypoints instead of only aisle graph nodes', async () => {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const layoutPath = path.resolve(currentDir, '../../../config/layouts/baseline-layout.json');
    const layout = await loadLayoutDefinition(layoutPath);
    const motionWorld = await MotionWorld.create(layout);
    const home = layout.facilities.amrHomes[0]!;
    const amr = new AMR('AMR-X', home.id, 1.5, 1.5, 0.45, 1.6, home.x, home.z);
    motionWorld.registerAmrs([amr]);

    motionWorld.routeAmrTo(amr, 'drop-s9');

    const progress = motionWorld.getRouteProgress(amr);
    expect(progress.nodeIds.some((nodeId) => nodeId.startsWith('free:'))).toBe(true);
    expect(progress.nodeIds.at(-1)).toBe('drop-s9');
  });

  it('prevents AMRs from passing through each other on conflicting runtime routes', async () => {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const layoutPath = path.resolve(currentDir, '../../../config/layouts/baseline-layout.json');
    const layout = await loadLayoutDefinition(layoutPath);
    const motionWorld = await MotionWorld.create(layout);
    const [home1, home2] = layout.facilities.amrHomes;
    const amr1 = new AMR('AMR-1', home1!.id, 1.5, 1.5, 0.45, 1.6, home1!.x, home1!.z);
    const amr2 = new AMR('AMR-2', home2!.id, 1.5, 1.5, 0.45, 1.6, home2!.x, home2!.z);
    motionWorld.registerAmrs([amr1, amr2]);
    amr1.moveToPhase('to-dropoff');
    amr2.moveToPhase('to-dropoff');
    motionWorld.routeAmrTo(amr1, 'drop-s5');
    motionWorld.routeAmrTo(amr2, 'drop-s5');

    let minSeparationM = Number.POSITIVE_INFINITY;
    for (let tick = 0; tick < 240; tick += 1) {
      const { arrivals } = motionWorld.step([amr1, amr2], 0.1);
      minSeparationM = Math.min(minSeparationM, Math.hypot(amr1.x - amr2.x, amr1.z - amr2.z));
      for (const arrival of arrivals) {
        const arrivedAmr = arrival.amrId === amr1.id ? amr1 : amr2;
        arrivedAmr.setIdle(arrival.nodeId);
      }
    }

    expect(minSeparationM).toBeGreaterThanOrEqual(1.54);
    expect(amr1.totalDistanceM + amr2.totalDistanceM).toBeGreaterThan(5);
  });

  it('flags material handling routes that cross obstacle clearance envelopes', () => {
    const model = AiNativeDesModelDefinitionSchema.parse({
      schemaVersion: 'des-platform.v1' as const,
      id: 'motion-verify',
      name: 'Motion Verify',
      process: {
        id: 'flow',
        blocks: [
          { id: 'source', kind: 'source' as const, scheduleAtSec: [0] },
          { id: 'sink', kind: 'sink' as const }
        ],
        connections: [{ from: 'source', to: 'sink' }]
      },
      materialHandling: {
        id: 'mh',
        nodes: [
          { id: 'dock', type: 'dock' as const, x: 0, z: 0 },
          { id: 'rack', type: 'storage' as const, x: 10, z: 0 }
        ],
        paths: [{ id: 'dock-rack', from: 'dock', to: 'rack', lengthM: 10 }],
        transporterFleets: [{ id: 'amr', count: 2, homeNodeId: 'dock', speedMps: 1, lengthM: 1, widthM: 1 }],
        obstacles: [{ id: 'column', x: 5, z: 0, widthM: 1, depthM: 1, heightM: 3 }]
      },
      experiments: [{ id: 'baseline', stopTimeSec: 20 }]
    });
    const materialHandling = model.materialHandling!;
    const snapshot = {
      nodes: materialHandling.nodes,
      transporterUnits: [
        { id: 'amr-1', fleetId: 'amr', status: 'busy', currentNodeId: 'dock', assignedEntityId: 'source-1' },
        { id: 'amr-2', fleetId: 'amr', status: 'idle', currentNodeId: 'dock', assignedEntityId: null }
      ],
      obstacles: materialHandling.obstacles
    };

    const verification = verifyMaterialHandlingMotion({
      model,
      snapshot,
      activeTransports: [{
        transporterUnitId: 'amr-1',
        fleetId: 'amr',
        entityId: 'source-1',
        blockId: 'move',
        endSec: 10,
        emptyRouteNodeIds: ['dock'],
        emptyTravelStartSec: 0,
        emptyTravelEndSec: 0,
        loadStartSec: 0,
        loadEndSec: 0,
        loadedRouteNodeIds: ['dock', 'rack'],
        loadedTravelStartSec: 0,
        loadedTravelEndSec: 10,
        unloadStartSec: 10,
        unloadEndSec: 10,
        loadedToNodeId: 'rack'
      }],
      nowSec: 1
    });

    expect(verification.warnings.some((warning) => warning.code === 'motion.static-obstacle-route')).toBe(true);
    expect(verification.warnings.some((warning) => warning.code === 'motion.dynamic-separation')).toBe(true);
  });

  it('checks the reserved empty route while a transporter is waiting to enter traffic', () => {
    const model = AiNativeDesModelDefinitionSchema.parse({
      schemaVersion: 'des-platform.v1' as const,
      id: 'waiting-route-verify',
      name: 'Waiting Route Verify',
      process: {
        id: 'flow',
        blocks: [
          { id: 'source', kind: 'source' as const, scheduleAtSec: [0] },
          { id: 'sink', kind: 'sink' as const }
        ],
        connections: [{ from: 'source', to: 'sink' }]
      },
      materialHandling: {
        id: 'mh',
        nodes: [
          { id: 'dock', type: 'dock' as const, x: 0, z: 0 },
          { id: 'rack', type: 'storage' as const, x: 10, z: 0 },
          { id: 'pack', type: 'station' as const, x: 10, z: 6 }
        ],
        paths: [
          { id: 'dock-rack', from: 'dock', to: 'rack', lengthM: 10 },
          { id: 'rack-pack', from: 'rack', to: 'pack', lengthM: 6 }
        ],
        transporterFleets: [{ id: 'amr', count: 1, homeNodeId: 'dock', speedMps: 1, lengthM: 1, widthM: 1 }],
        obstacles: [{ id: 'column', x: 5, z: 0, widthM: 1, depthM: 1, heightM: 3 }]
      },
      experiments: [{ id: 'baseline', stopTimeSec: 20 }]
    });
    const materialHandling = model.materialHandling!;

    const verification = verifyMaterialHandlingMotion({
      model,
      snapshot: {
        nodes: materialHandling.nodes,
        transporterUnits: [{ id: 'amr-1', fleetId: 'amr', status: 'busy', currentNodeId: 'dock', assignedEntityId: 'source-1' }],
        obstacles: materialHandling.obstacles
      },
      activeTransports: [{
        transporterUnitId: 'amr-1',
        fleetId: 'amr',
        entityId: 'source-1',
        blockId: 'move',
        endSec: 20,
        emptyRouteNodeIds: ['dock', 'rack'],
        emptyTravelStartSec: 5,
        emptyTravelEndSec: 15,
        loadStartSec: 15,
        loadEndSec: 15,
        loadedRouteNodeIds: ['rack', 'pack'],
        loadedTravelStartSec: 15,
        loadedTravelEndSec: 20,
        unloadStartSec: 20,
        unloadEndSec: 20,
        loadedToNodeId: 'pack'
      }],
      nowSec: 1
    });

    expect(verification.units[0]?.status).toBe('waiting');
    expect(verification.warnings.some((warning) => warning.code === 'motion.static-obstacle-route')).toBe(true);
  });

  it('projects near-simultaneous crossings on different path segments', () => {
    const model = AiNativeDesModelDefinitionSchema.parse({
      schemaVersion: 'des-platform.v1' as const,
      id: 'projected-crossing',
      name: 'Projected Crossing',
      process: {
        id: 'flow',
        blocks: [
          { id: 'source', kind: 'source' as const, scheduleAtSec: [0] },
          { id: 'sink', kind: 'sink' as const }
        ],
        connections: [{ from: 'source', to: 'sink' }]
      },
      materialHandling: {
        id: 'mh',
        nodes: [
          { id: 'west', type: 'dock' as const, x: 0, z: 5 },
          { id: 'east', type: 'storage' as const, x: 10, z: 5 },
          { id: 'south', type: 'dock' as const, x: 5, z: 0 },
          { id: 'north', type: 'storage' as const, x: 5, z: 10 }
        ],
        paths: [
          { id: 'west-east', from: 'west', to: 'east', bidirectional: false, trafficControl: 'reservation', capacity: 1 },
          { id: 'south-north', from: 'south', to: 'north', bidirectional: false, trafficControl: 'reservation', capacity: 1 }
        ],
        transporterFleets: [{ id: 'amr', count: 2, homeNodeId: 'west', speedMps: 1, lengthM: 1, widthM: 1 }]
      },
      experiments: [{ id: 'baseline', stopTimeSec: 20 }]
    });
    const materialHandling = model.materialHandling!;

    const verification = verifyMaterialHandlingMotion({
      model,
      snapshot: {
        nodes: materialHandling.nodes,
        transporterUnits: [
          { id: 'amr-1', fleetId: 'amr', status: 'busy', currentNodeId: 'west', assignedEntityId: 'order-1' },
          { id: 'amr-2', fleetId: 'amr', status: 'busy', currentNodeId: 'south', assignedEntityId: 'order-2' }
        ],
        obstacles: []
      },
      activeTransports: [
        {
          transporterUnitId: 'amr-1',
          fleetId: 'amr',
          entityId: 'order-1',
          blockId: 'move',
          endSec: 10,
          emptyRouteNodeIds: ['west'],
          emptyTravelStartSec: 0,
          emptyTravelEndSec: 0,
          loadStartSec: 0,
          loadEndSec: 0,
          loadedRouteNodeIds: ['west', 'east'],
          loadedTravelStartSec: 0,
          loadedTravelEndSec: 10,
          unloadStartSec: 10,
          unloadEndSec: 10,
          loadedToNodeId: 'east'
        },
        {
          transporterUnitId: 'amr-2',
          fleetId: 'amr',
          entityId: 'order-2',
          blockId: 'move',
          endSec: 10,
          emptyRouteNodeIds: ['south'],
          emptyTravelStartSec: 0,
          emptyTravelEndSec: 0,
          loadStartSec: 0,
          loadEndSec: 0,
          loadedRouteNodeIds: ['south', 'north'],
          loadedTravelStartSec: 0,
          loadedTravelEndSec: 10,
          unloadStartSec: 10,
          unloadEndSec: 10,
          loadedToNodeId: 'north'
        }
      ],
      nowSec: 1,
      options: { tickSec: 0.2 }
    });

    expect(verification.routeConflicts).toHaveLength(1);
    expect(verification.warnings.some((warning) => warning.code === 'motion.route-crossing-projection')).toBe(true);
  });
});
