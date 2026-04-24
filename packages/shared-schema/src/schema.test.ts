import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { listScenarioBundles, loadScenarioBundle } from './loader.js';
import { AiNativeDesModelDefinitionSchema, ScenarioDefinitionSchema, WorldSnapshotSchema, createLinearAssemblyLayout } from './index.js';

describe('shared schema', () => {
  it('validates the baseline scenario bundle and a sample snapshot', async () => {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const scenarioPath = path.resolve(currentDir, '../../../config/scenarios/baseline.yaml');
    const bundle = await loadScenarioBundle(scenarioPath);

    const sample = WorldSnapshotSchema.parse({
      simTimeSec: 0,
      line: {
        isRunning: true,
        speedMps: 0.1275,
        activeCars: 0,
        completedCars: 0,
        headCarId: null,
        tailCarId: null,
        onlineCarIds: [],
        lineWindowStartSec: 0
      },
      cars: [],
      skids: [],
      stations: bundle.layout.stations.map((station, index) => ({
        id: station.id,
        index: station.index,
        qpc: bundle.scenario.stations.qpc[index],
        currentCarId: null,
        state: 'idle',
        stateReason: 'no car at station window',
        stateColor: '#8a95a3',
        isStarved: false,
        activeBinIndex: 0,
        requestCount: 0,
        starvationCount: 0,
        bins: station.binSlots.map((slot, slotIndex) => ({
          id: slot.id,
          quantity: bundle.scenario.stations.qpc[index],
          capacity: bundle.scenario.stations.qpc[index],
          pendingRequest: false,
          isActive: slotIndex === 0
        }))
      })),
      tasks: [],
      amrs: bundle.layout.facilities.amrHomes.slice(0, bundle.scenario.amr.count).map((home, index) => ({
        id: `AMR-${index + 1}`,
        status: 'idle',
        phase: 'idle',
        taskId: null,
        x: home.x,
        y: bundle.scenario.amr.heightM / 2,
        z: home.z,
        yawRad: 0,
        speedMps: 0,
        totalDistanceM: 0,
        busyTimeSec: 0,
        currentNodeId: home.id,
        targetNodeId: null,
        routeDestinationNodeId: null,
        routeNodeIds: [],
        routeRemainingDistanceM: 0
      })),
      kpis: {
        completedCars: 0,
        releasedCars: 0,
        lineDowntimeSec: 0,
        starvationSec: 0,
        steadyStateCycleSec: 0,
        steadyStateUph: 0,
        actualAverageUph: 0,
        averageTaskWaitSec: 0,
        averageTaskCycleSec: 0,
        maxQueueLength: 0,
        amrUtilization: {},
        stationConsumption: {},
        stationDowntimeSec: {},
        stationAvailability: {},
        totalAmrDistanceM: 0,
        baselinePass: false
      },
      alerts: []
    });

    expect(bundle.scenario.id).toBe('baseline-90-uph');
    expect(sample.stations).toHaveLength(10);
  });

  it('loads every scenario bundle from the scenarios directory', async () => {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const scenariosDir = path.resolve(currentDir, '../../../config/scenarios');
    const bundles = await listScenarioBundles(scenariosDir);

    expect(bundles.length).toBeGreaterThanOrEqual(4);
    expect(new Set(bundles.map((bundle) => bundle.scenario.id)).size).toBe(bundles.length);
  });

  it('supports layout-driven station counts instead of fixed ten-station schemas', () => {
    const stationCount = 20;
    const layout = createLinearAssemblyLayout({
      id: 'twenty-station-layout',
      stationCount
    });

    expect(layout.stations).toHaveLength(stationCount);
    expect(layout.line.end.x - layout.line.start.x).toBeCloseTo(stationCount * layout.line.pitchM, 5);
    expect(layout.stations.at(-1)?.dropNodeId).toBe('drop-s20');
    expect(layout.aisleGraph.nodes.some((node) => node.id === 'drop-s20')).toBe(true);

    const scenario = ScenarioDefinitionSchema.parse({
      id: 'twenty-station-smoke',
      name: 'Twenty Station Smoke',
      description: 'Generated 20-station layout for schema-level station-count validation.',
      layoutPath: '../layouts/generated-20.json',
      durationSec: 1200,
      seed: 20260423,
      taktTimeSec: 40,
      snapshotIntervalSec: 60,
      motionDtSec: 0.1,
      line: {
        stationCount,
        pacedCycleSec: 40,
        pitchM: layout.line.pitchM,
        skidLengthM: layout.line.skidLengthM,
        skidGapM: layout.line.skidGapM,
        carLengthM: layout.line.carLengthM,
        carWidthM: layout.line.carWidthM,
        carHeightM: layout.line.carHeightM,
        conveyorSpeedMps: layout.line.speedMps
      },
      stations: {
        qpc: Array.from({ length: stationCount }, (_, index) => 160 + index * 3),
        initialBinFillRatio: 1,
        unitsPerCar: 1
      },
      amr: {
        count: 3,
        speedMps: 1.5,
        lengthM: 1.5,
        widthM: 1.5,
        heightM: 0.35,
        loadTimeSec: 8,
        unloadTimeSec: 8,
        emptyHandlingSec: 6
      },
      breakdown: {
        enabled: false,
        mode: 'periodic',
        mtbfSec: 7200,
        repairSec: 300,
        repairJitterRatio: 0
      },
      dispatch: {
        policy: 'earliest-completion-nearest-idle'
      },
      report: {
        warmupSec: 0,
        includeReplay: true,
        includeStationTables: true,
        liveWindowStartSec: 0,
        livePlaybackSpeed: 4
      }
    });

    expect(scenario.stations.qpc).toHaveLength(stationCount);
    expect(() =>
      ScenarioDefinitionSchema.parse({
        ...scenario,
        stations: {
          ...scenario.stations,
          qpc: scenario.stations.qpc.slice(0, -1)
        }
      })
    ).toThrow(/must match line\.stationCount/);
  });

  it('validates AI-native stochastic time distributions', () => {
    const model = AiNativeDesModelDefinitionSchema.parse({
      schemaVersion: 'des-platform.v1',
      id: 'stochastic-smoke',
      name: 'Stochastic Smoke',
      process: {
        id: 'flow',
        blocks: [
          { id: 'source', kind: 'source', intervalSec: { kind: 'exponential', mean: 5 } },
          { id: 'delay', kind: 'delay', durationSec: { kind: 'normal', mean: 10, sd: 2, min: 1, max: 20 } },
          { id: 'sink', kind: 'sink' }
        ],
        connections: [
          { from: 'source', to: 'delay' },
          { from: 'delay', to: 'sink' }
        ]
      },
      experiments: [{ id: 'baseline', seed: 1234, stopTimeSec: 100 }]
    });

    expect(model.experiments[0]?.seed).toBe(1234);
    expect(model.process.blocks[1]?.kind).toBe('delay');
    expect(() =>
      AiNativeDesModelDefinitionSchema.parse({
        ...model,
        process: {
          ...model.process,
          blocks: [
            { id: 'source', kind: 'source', intervalSec: { kind: 'constant', value: 0 } },
            { id: 'sink', kind: 'sink' }
          ],
          connections: [{ from: 'source', to: 'sink' }]
        }
      })
    ).toThrow(/intervalSec must be able to advance simulation time/);
  });
});
