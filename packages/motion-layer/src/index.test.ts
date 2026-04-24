import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AMR } from '@des-platform/domain-model';
import { loadLayoutDefinition } from '@des-platform/shared-schema/loader';

import { MotionWorld } from './index.js';

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
});
