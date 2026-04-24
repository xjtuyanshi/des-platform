import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLinearAssemblyLayout } from '@des-platform/shared-schema';
import { loadScenarioBundle } from '@des-platform/shared-schema/loader';

import { runSimulation, SimulationEngine } from './index.js';

describe('baseline integration', () => {
  it(
    'hits the baseline KPI targets with zero starvation and downtime',
    async () => {
      const currentDir = path.dirname(fileURLToPath(import.meta.url));
      const scenarioPath = path.resolve(currentDir, '../../../config/scenarios/baseline.yaml');
      const { scenario, layout } = await loadScenarioBundle(scenarioPath);

      const result = await runSimulation(
        {
          ...scenario,
          snapshotIntervalSec: 60
        },
        layout
      );

      expect(result.kpis.lineDowntimeSec).toBe(0);
      expect(result.kpis.starvationSec).toBe(0);
      expect(result.kpis.steadyStateCycleSec).toBeCloseTo(40, 1);
      expect(result.kpis.steadyStateUph).toBeCloseTo(90, 1);
      expect(result.kpis.completedCars).toBeGreaterThan(700);
      expect(result.kpis.totalAmrDistanceM).toBeGreaterThan(0);
      expect(result.kpis.stationConsumption.S1).toBeGreaterThan(700);
      expect(result.events.filter((event) => event.type === 'task-created').length).toBeGreaterThan(0);
      expect(result.events.filter((event) => event.type === 'station-consumed').length).toBeGreaterThan(7000);
      expect(result.validation.passed).toBe(true);
      expect(result.validation.checks.every((check) => check.passed)).toBe(true);
      expect(result.validation.checks.find((check) => check.id === 'car-skid-binding')?.passed).toBe(true);
      expect(result.validation.checks.find((check) => check.id === 'line-order-monotonicity')?.passed).toBe(true);
      expect(result.kpis.baselinePass).toBe(true);

      const lineSnapshot = result.snapshots.find((snapshot) => snapshot.cars.length >= 3);
      expect(lineSnapshot).toBeDefined();
      expect(lineSnapshot?.line.onlineCarIds).toEqual(lineSnapshot?.cars.map((car) => car.id));
      expect(lineSnapshot?.line.headCarId).toBe(lineSnapshot?.cars[0]?.id);
      expect(lineSnapshot?.line.tailCarId).toBe(lineSnapshot?.cars.at(-1)?.id);
      for (const car of lineSnapshot?.cars ?? []) {
        const skid = lineSnapshot?.skids.find((candidate) => candidate.id === car.skidId);
        expect(skid?.carId).toBe(car.id);
        expect(skid?.x).toBeCloseTo(car.x, 4);
        expect(skid?.z).toBeCloseTo(car.z, 4);
      }

      const fullLineSnapshot = result.snapshots.find((snapshot) => snapshot.cars.length >= 10);
      expect(fullLineSnapshot?.stations.some((station) => station.currentCarId !== null)).toBe(true);
      expect(new Set(fullLineSnapshot?.stations.map((station) => station.qpc)).size).toBe(10);

      const firstCarConsumes = result.events.filter(
        (event) => event.type === 'station-consumed' && event.payload.carId === 'CAR-1'
      );
      const s1Consume = firstCarConsumes.find((event) => event.payload.stationId === 'S1');
      const s10Consume = firstCarConsumes.find((event) => event.payload.stationId === 'S10');

      expect(firstCarConsumes).toHaveLength(10);
      expect(s1Consume?.simTimeSec).toBeCloseTo(20, 3);
      expect(s10Consume?.simTimeSec).toBeCloseTo(380, 3);
    },
    120000
  );

  it(
    'matches the batch result when advanced incrementally',
    async () => {
      const currentDir = path.dirname(fileURLToPath(import.meta.url));
      const scenarioPath = path.resolve(currentDir, '../../../config/scenarios/baseline.yaml');
      const { scenario, layout } = await loadScenarioBundle(scenarioPath);

      const steppedScenario = {
        ...scenario,
        durationSec: 3600,
        snapshotIntervalSec: 30
      };

      const batch = await runSimulation(steppedScenario, layout);

      const engine = new SimulationEngine(steppedScenario, layout);
      await engine.initialize();
      for (let simTimeSec = 0; simTimeSec <= steppedScenario.durationSec; simTimeSec += 300) {
        engine.advanceTo(simTimeSec);
      }
      const stepped = engine.getResult();

      expect(stepped.kpis).toEqual(batch.kpis);
      expect(stepped.validation).toEqual(batch.validation);
      expect(stepped.events).toEqual(batch.events);
      expect(stepped.snapshots.at(-1)).toEqual(batch.snapshots.at(-1));
    },
    120000
  );

  it(
    'runs a generated layout with a non-ten station count',
    async () => {
      const currentDir = path.dirname(fileURLToPath(import.meta.url));
      const scenarioPath = path.resolve(currentDir, '../../../config/scenarios/baseline.yaml');
      const { scenario } = await loadScenarioBundle(scenarioPath);
      const stationCount = 20;
      const layout = createLinearAssemblyLayout({
        id: 'twenty-station-layout',
        stationCount
      });
      const generatedScenario = {
        ...scenario,
        id: 'twenty-station-smoke',
        name: 'Twenty Station Smoke',
        durationSec: 1200,
        snapshotIntervalSec: 60,
        line: {
          ...scenario.line,
          stationCount,
          pitchM: layout.line.pitchM,
          conveyorSpeedMps: layout.line.speedMps
        },
        stations: {
          ...scenario.stations,
          qpc: Array.from({ length: stationCount }, (_, index) => 180 + index)
        },
        report: {
          ...scenario.report,
          warmupSec: 0
        }
      };

      const result = await runSimulation(generatedScenario, layout);
      const firstCarConsumes = result.events.filter(
        (event) => event.type === 'station-consumed' && event.payload.carId === 'CAR-1'
      );
      const stationSnapshot = result.snapshots.find((snapshot) => snapshot.stations.length === stationCount);

      expect(result.scenario.line.stationCount).toBe(stationCount);
      expect(result.layout.stations).toHaveLength(stationCount);
      expect(Object.keys(result.kpis.stationConsumption)).toHaveLength(stationCount);
      expect(firstCarConsumes).toHaveLength(stationCount);
      expect(firstCarConsumes.at(-1)?.payload.stationId).toBe('S20');
      expect(stationSnapshot?.stations).toHaveLength(stationCount);
      expect(stationSnapshot?.stations.every((station) => station.state && station.stateColor)).toBe(true);
    },
    120000
  );

  it(
    'reaches an eventful live window with active replenishment work by the configured baseline start',
    async () => {
      const currentDir = path.dirname(fileURLToPath(import.meta.url));
      const scenarioPath = path.resolve(currentDir, '../../../config/scenarios/baseline.yaml');
      const { scenario, layout } = await loadScenarioBundle(scenarioPath);

      const engine = new SimulationEngine(scenario, layout, {
        retainSnapshots: false,
        retainEvents: false
      });

      await engine.initialize();
      const advance = engine.advanceTo(scenario.report.liveWindowStartSec);
      const snapshot = advance.latestSnapshot;

      expect(snapshot).not.toBeNull();
      expect(snapshot?.simTimeSec).toBe(scenario.report.liveWindowStartSec);
      expect(snapshot?.tasks.length).toBeGreaterThan(0);
      expect(snapshot?.amrs.some((amr) => amr.status !== 'idle')).toBe(true);
      expect(snapshot?.amrs.some((amr) => amr.status === 'moving' && amr.routeNodeIds.length > 0)).toBe(true);
      expect(snapshot?.amrs.some((amr) => amr.routeRemainingDistanceM > 0)).toBe(true);
      expect(snapshot?.kpis.totalAmrDistanceM).toBeGreaterThan(0);
    },
    120000
  );

  it(
    'shifts line-dependent events and freezes conveyor motion during breakdown downtime',
    async () => {
      const currentDir = path.dirname(fileURLToPath(import.meta.url));
      const scenarioPath = path.resolve(currentDir, '../../../config/scenarios/baseline.yaml');
      const { scenario, layout } = await loadScenarioBundle(scenarioPath);

      const breakdownScenario = {
        ...scenario,
        durationSec: 500,
        snapshotIntervalSec: 10,
        breakdown: {
          ...scenario.breakdown,
          enabled: true,
          mtbfSec: 160,
          repairSec: 30
        },
        report: {
          ...scenario.report,
          warmupSec: 0
        }
      };

      const result = await runSimulation(breakdownScenario, layout);

      expect(result.kpis.lineDowntimeSec).toBe(60);
      expect(result.kpis.baselinePass).toBe(false);
      expect(result.validation.checks.find((check) => check.id === 'line-downtime-blackout')?.passed).toBe(true);

      const lineStops = result.events.filter((event) => event.type === 'line-stopped');
      const lineStarts = result.events.filter((event) => event.type === 'line-started');
      expect(lineStops).toHaveLength(2);
      expect(lineStarts).toHaveLength(3);

      const firstCarConsumes = result.events.filter(
        (event) => event.type === 'station-consumed' && event.payload.carId === 'CAR-1'
      );
      const s10Consume = firstCarConsumes.find((event) => event.payload.stationId === 'S10');
      const car1Exit = result.events.find((event) => event.type === 'car-exited' && event.payload.carId === 'CAR-1');
      expect(s10Consume?.simTimeSec).toBeCloseTo(440, 3);
      expect(car1Exit?.simTimeSec).toBeCloseTo(460, 3);

      const snapshotAt170 = result.snapshots.find((snapshot) => snapshot.simTimeSec === 170);
      const snapshotAt180 = result.snapshots.find((snapshot) => snapshot.simTimeSec === 180);
      const carAt170 = snapshotAt170?.cars.find((car) => car.id === 'CAR-1');
      const carAt180 = snapshotAt180?.cars.find((car) => car.id === 'CAR-1');
      expect(snapshotAt170?.line.isRunning).toBe(false);
      expect(snapshotAt180?.line.isRunning).toBe(false);
      expect(snapshotAt170?.line.speedMps).toBe(0);
      expect(snapshotAt180?.line.speedMps).toBe(0);
      expect(carAt170?.x).toBeCloseTo(carAt180?.x ?? 0, 4);
    },
    120000
  );

  it(
    'produces reproducible seeded random breakdown sequences',
    async () => {
      const currentDir = path.dirname(fileURLToPath(import.meta.url));
      const scenarioPath = path.resolve(currentDir, '../../../config/scenarios/baseline.yaml');
      const { scenario, layout } = await loadScenarioBundle(scenarioPath);

      const randomScenario = {
        ...scenario,
        durationSec: 12000,
        snapshotIntervalSec: 60,
        breakdown: {
          ...scenario.breakdown,
          enabled: true,
          mode: 'random' as const,
          mtbfSec: 1800,
          repairSec: 150,
          repairJitterRatio: 0.3
        }
      };

      const resultA = await runSimulation(randomScenario, layout);
      const resultB = await runSimulation(randomScenario, layout);
      const resultC = await runSimulation(
        {
          ...randomScenario,
          seed: randomScenario.seed + 1
        },
        layout
      );

      const sequenceA = resultA.events
        .filter((event) => event.type === 'line-stopped')
        .map((event) => ({ simTimeSec: event.simTimeSec, repairSec: event.payload.repairSec }));
      const sequenceB = resultB.events
        .filter((event) => event.type === 'line-stopped')
        .map((event) => ({ simTimeSec: event.simTimeSec, repairSec: event.payload.repairSec }));
      const sequenceC = resultC.events
        .filter((event) => event.type === 'line-stopped')
        .map((event) => ({ simTimeSec: event.simTimeSec, repairSec: event.payload.repairSec }));

      expect(sequenceA.length).toBeGreaterThan(0);
      expect(sequenceA).toEqual(sequenceB);
      expect(sequenceC).not.toEqual(sequenceA);
    },
    120000
  );

  it(
    'runs 10-piece line-side inventory with station MTBF exponential and MTTR Erlang-2',
    async () => {
      const currentDir = path.dirname(fileURLToPath(import.meta.url));
      const scenarioPath = path.resolve(currentDir, '../../../config/scenarios/logistics-availability-stress.yaml');
      const { scenario, layout } = await loadScenarioBundle(scenarioPath);

      const result = await runSimulation(
        {
          ...scenario,
          snapshotIntervalSec: 10
        },
        layout
      );
      const stationFailures = result.events.filter((event) => event.type === 'station-failed');
      const stationRepairs = result.events.filter((event) => event.type === 'station-repaired');
      const repairSamples = stationFailures.map((event) => Number(event.payload.mttrSec ?? 0));
      const stationFailureIntervals = stationFailures
        .slice(1)
        .map((event, index) => event.simTimeSec - stationFailures[index]!.simTimeSec);
      const taskCreatedCount = result.events.filter((event) => event.type === 'task-created').length;
      const averageObservedAvailability =
        Object.values(result.kpis.stationAvailability).reduce((sum, value) => sum + value, 0) /
        Object.values(result.kpis.stationAvailability).length;

      expect(scenario.stations.qpc).toEqual(Array.from({ length: scenario.line.stationCount }, () => 10));
      expect(scenario.stationBreakdown).toMatchObject({
        enabled: true,
        availability: 0.98,
        mttrSec: 300,
        mtbfDistribution: 'exponential',
        mttrDistribution: 'erlang-2'
      });
      expect(stationFailures.length).toBeGreaterThan(0);
      expect(stationRepairs.length).toBeGreaterThan(0);
      expect(new Set(repairSamples.map((sample) => sample.toFixed(3))).size).toBeGreaterThan(1);
      expect(new Set(stationFailureIntervals.map((sample) => sample.toFixed(3))).size).toBeGreaterThan(1);
      expect(result.kpis.lineDowntimeSec).toBeGreaterThan(0);
      expect(Object.values(result.kpis.stationDowntimeSec).some((downtimeSec) => downtimeSec > 0)).toBe(true);
      expect(averageObservedAvailability).toBeGreaterThan(0.9);
      expect(averageObservedAvailability).toBeLessThan(1);
      expect(taskCreatedCount).toBeGreaterThan(100);
      expect(result.kpis.totalAmrDistanceM).toBeGreaterThan(1000);
      expect(result.validation.checks.find((check) => check.id === 'single-outstanding-request')?.passed).toBe(true);
      expect(result.validation.checks.find((check) => check.id === 'task-lifecycle-order')?.passed).toBe(true);
      expect(result.validation.checks.find((check) => check.id === 'line-downtime-blackout')?.passed).toBe(true);
      expect(
        result.snapshots.some((snapshot) =>
          snapshot.stations.some((station) => station.state === 'down' || station.state === 'blocked')
        )
      ).toBe(true);
    },
    120000
  );

  it(
    'keeps station stochastic availability reproducible by seed',
    async () => {
      const currentDir = path.dirname(fileURLToPath(import.meta.url));
      const scenarioPath = path.resolve(currentDir, '../../../config/scenarios/logistics-availability-stress.yaml');
      const { scenario, layout } = await loadScenarioBundle(scenarioPath);

      const resultA = await runSimulation({ ...scenario, snapshotIntervalSec: 60 }, layout);
      const resultB = await runSimulation({ ...scenario, snapshotIntervalSec: 60 }, layout);
      const resultC = await runSimulation({ ...scenario, seed: scenario.seed + 1, snapshotIntervalSec: 60 }, layout);

      const sequenceA = resultA.events
        .filter((event) => event.type === 'station-failed')
        .map((event) => ({ stationId: event.payload.stationId, simTimeSec: event.simTimeSec, mttrSec: event.payload.mttrSec }));
      const sequenceB = resultB.events
        .filter((event) => event.type === 'station-failed')
        .map((event) => ({ stationId: event.payload.stationId, simTimeSec: event.simTimeSec, mttrSec: event.payload.mttrSec }));
      const sequenceC = resultC.events
        .filter((event) => event.type === 'station-failed')
        .map((event) => ({ stationId: event.payload.stationId, simTimeSec: event.simTimeSec, mttrSec: event.payload.mttrSec }));

      expect(sequenceA.length).toBeGreaterThan(0);
      expect(sequenceA).toEqual(sequenceB);
      expect(sequenceC).not.toEqual(sequenceA);
    },
    120000
  );
});
