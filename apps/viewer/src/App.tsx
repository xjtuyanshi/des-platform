import {
  startTransition,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState
} from 'react';

import type {
  EventLogEntry,
  KpiSummary,
  LayoutDefinition,
  RuntimeSessionState,
  ScenarioDefinition,
  SimulationResult,
  WorldSnapshot
} from '@des-platform/shared-schema';

import { FactoryCanvas, type FactoryCanvasHandle } from './components/FactoryCanvas.js';
import {
  fetchReplay,
  fetchRuntimeState,
  fetchScenarioCatalog,
  fetchScenarioSummary,
  pauseRuntimeSession,
  restartRuntimeSession,
  resumeRuntimeSession,
  startRuntimeSession,
  subscribeRuntime,
  updateRuntimeSpeed,
  type RuntimeEnvelope,
  type ScenarioCatalogItem,
  type SimulationSummary
} from './lib/api.js';

type Mode = 'live' | 'replay';
type MaterialStatus = 'healthy' | 'replenishing' | 'low' | 'starved';

type MaterialStationView = {
  id: string;
  index: number;
  qpc: number;
  currentCarId: string | null;
  totalQty: number;
  totalCapacity: number;
  fillRatio: number;
  coverageCars: number;
  coverageSec: number;
  consumedUnits: number;
  pendingBins: number;
  emptyBins: number;
  status: MaterialStatus;
  bins: WorldSnapshot['stations'][number]['bins'];
};

type RuntimeAuditCheck = {
  id: string;
  label: string;
  tone: 'pass' | 'watch' | 'fail';
  detail: string;
};

type TrendPoint = {
  simTimeSec: number;
  uph: number;
  amrUtilizationPct: number;
  completedCars: number;
};

type TrendChartProps = {
  title: string;
  unit: string;
  points: TrendPoint[];
  valueKey: 'uph' | 'amrUtilizationPct';
  target?: number;
  color: string;
};

const DEFAULT_SCENARIO_ID = 'baseline-90-uph';
const DEFAULT_RUNTIME_SPEED = 12;
const SPEED_OPTIONS = [1, 4, 12, 24, 48, 96];

function formatClock(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, '0')).join(':');
}

function formatProgress(progress: number): string {
  return `${(progress * 100).toFixed(1)}%`;
}

function formatMinutes(seconds: number): string {
  return `${(seconds / 60).toFixed(seconds >= 600 ? 0 : 1)} min`;
}

function formatMeters(value: number | null | undefined): string {
  return value === null || value === undefined ? '--' : `${value.toFixed(2)} m`;
}

function formatSpeedMultiplier(value: number): string {
  return value < 1 ? `${value.toFixed(2)}x` : `${value.toFixed(0)}x`;
}

function formatQuantity(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function getMaterialStatusLabel(status: MaterialStatus): string {
  if (status === 'starved') {
    return 'STARVED';
  }
  if (status === 'replenishing') {
    return 'REPLENISHING';
  }
  if (status === 'low') {
    return 'LOW';
  }
  return 'HEALTHY';
}

function getStationStateLabel(state: WorldSnapshot['stations'][number]['state']): string {
  switch (state) {
    case 'running':
      return 'RUNNING';
    case 'down':
      return 'DOWN';
    case 'upstream-starved':
      return 'NO UPSTREAM';
    case 'material-starved':
      return 'NO MATERIAL';
    case 'blocked':
      return 'BLOCKED';
    case 'idle':
      return 'IDLE';
  }
}

function getOverallAmrUtilizationPct(snapshot: WorldSnapshot): number {
  const values = Object.values(snapshot.kpis.amrUtilization);
  if (values.length === 0) {
    return 0;
  }

  return (values.reduce((sum, value) => sum + value, 0) / values.length) * 100;
}

function buildTrendPoints(snapshots: WorldSnapshot[], taktTimeSec: number): TrendPoint[] {
  const chronological = [...snapshots].sort((left, right) => left.simTimeSec - right.simTimeSec);
  const points: TrendPoint[] = [];
  const rollingWindowSec = Math.max(600, taktTimeSec * 10);

  for (const [index, snapshot] of chronological.entries()) {
    const windowStartTimeSec = Math.max(0, snapshot.simTimeSec - rollingWindowSec);
    const windowStart =
      [...chronological]
        .slice(0, index + 1)
        .reverse()
        .find((candidate) => candidate.simTimeSec <= windowStartTimeSec) ?? chronological[0];
    const deltaSec = Math.max(0, snapshot.simTimeSec - (windowStart?.simTimeSec ?? snapshot.simTimeSec));
    const deltaCars = Math.max(0, snapshot.kpis.completedCars - (windowStart?.kpis.completedCars ?? 0));
    const hasEnoughRollingSamples = deltaSec >= Math.min(rollingWindowSec, taktTimeSec * 5);
    const rollingUph =
      hasEnoughRollingSamples
        ? (deltaCars * 3600) / deltaSec
        : snapshot.kpis.steadyStateUph || snapshot.kpis.actualAverageUph || 0;

    points.push({
      simTimeSec: snapshot.simTimeSec,
      uph: rollingUph,
      amrUtilizationPct: getOverallAmrUtilizationPct(snapshot),
      completedCars: snapshot.kpis.completedCars
    });
  }

  return points;
}

function buildTrendPath(
  points: TrendPoint[],
  valueKey: TrendChartProps['valueKey'],
  width: number,
  height: number,
  yMin: number,
  yMax: number
): string {
  if (points.length === 0) {
    return '';
  }

  const minTime = points[0]!.simTimeSec;
  const maxTime = points.at(-1)!.simTimeSec;
  const timeSpan = Math.max(1, maxTime - minTime);
  const valueSpan = Math.max(1, yMax - yMin);

  return points
    .map((point) => {
      const x = ((point.simTimeSec - minTime) / timeSpan) * width;
      const y = height - ((point[valueKey] - yMin) / valueSpan) * height;
      return `${x.toFixed(1)},${Math.max(0, Math.min(height, y)).toFixed(1)}`;
    })
    .join(' ');
}

function TrendChart({ title, unit, points, valueKey, target, color }: TrendChartProps) {
  const width = 360;
  const height = 118;
  const latest = points.at(-1);
  const values = points.map((point) => point[valueKey]);
  const targetValues = target === undefined ? [] : [target];
  const yMin = Math.min(0, ...values, ...targetValues);
  const yMax = Math.max(1, ...values, ...targetValues) * 1.08;
  const path = buildTrendPath(points, valueKey, width, height, yMin, yMax);
  const targetY =
    target === undefined ? null : height - ((target - yMin) / Math.max(1, yMax - yMin)) * height;

  return (
    <div className="trend-card">
      <header>
        <span>{title}</span>
        <strong>
          {latest ? latest[valueKey].toFixed(valueKey === 'uph' ? 1 : 1) : '--'} {unit}
        </strong>
      </header>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${title} trend`}>
        <line x1="0" x2={width} y1={height - 1} y2={height - 1} className="trend-axis" />
        {targetY !== null ? (
          <line x1="0" x2={width} y1={targetY} y2={targetY} className="trend-target" />
        ) : null}
        {path ? <polyline points={path} fill="none" stroke={color} strokeWidth="3.2" strokeLinecap="round" /> : null}
      </svg>
      <footer>
        <span>{points[0] ? formatClock(points[0].simTimeSec) : '--'}</span>
        <span>{points.length} samples</span>
        <span>{latest ? formatClock(latest.simTimeSec) : '--'}</span>
      </footer>
    </div>
  );
}

function getEventLabel(type: EventLogEntry['type']): string {
  return type
    .split('-')
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(' ');
}

function getEventPrimaryPayload(event: EventLogEntry): string {
  const stationId = typeof event.payload.stationId === 'string' ? event.payload.stationId : null;
  const carId = typeof event.payload.carId === 'string' ? event.payload.carId : null;
  const taskId = typeof event.payload.taskId === 'string' ? event.payload.taskId : null;
  const binId = typeof event.payload.binId === 'string' ? event.payload.binId : null;
  const amrId = typeof event.payload.amrId === 'string' ? event.payload.amrId : null;

  return [stationId, binId, taskId, amrId, carId].filter(Boolean).join(' · ') || '--';
}

function buildRuntimeStartOptions(speed: number | undefined, startTimeSec: number | undefined) {
  return {
    ...(speed === undefined ? {} : { speed }),
    ...(startTimeSec === undefined ? {} : { startTimeSec })
  };
}

function getScenarioTone(item: ScenarioCatalogItem | null): 'baseline' | 'stress' | 'breakdown' {
  if (!item) {
    return 'stress';
  }

  if (item.isBaseline) {
    return 'baseline';
  }

  return item.breakdownEnabled ? 'breakdown' : 'stress';
}

function getScenarioTag(item: ScenarioCatalogItem | null): string {
  if (!item) {
    return 'SCENARIO';
  }

  if (item.isBaseline) {
    return 'BASELINE';
  }

  return item.breakdownEnabled ? 'BREAKDOWN' : 'STRESS';
}

function formatDispatchLabel(policy: ScenarioDefinition['dispatch']['policy'] | undefined): string {
  if (!policy) {
    return '--';
  }

  return 'Earliest completion / nearest idle';
}

function formatBreakdownLabel(scenario: ScenarioDefinition | null, item: ScenarioCatalogItem | null): string {
  if (scenario) {
    if (!scenario.breakdown.enabled) {
      return 'Disabled';
    }

    const jitterText =
      scenario.breakdown.mode === 'random' && scenario.breakdown.repairJitterRatio > 0
        ? ` / jitter +- ${(scenario.breakdown.repairJitterRatio * 100).toFixed(0)}%`
        : '';

    return `${scenario.breakdown.mode} / MTBF ${formatMinutes(scenario.breakdown.mtbfSec)} / repair ${scenario.breakdown.repairSec.toFixed(0)} s${jitterText}`;
  }

  if (!item || !item.breakdownEnabled) {
    return 'Disabled';
  }

  return `${item.breakdownMode} enabled`;
}

export function App() {
  const [mode, setMode] = useState<Mode>('live');
  const [scenarioCatalog, setScenarioCatalog] = useState<ScenarioCatalogItem[]>([]);
  const [selectedScenarioId, setSelectedScenarioId] = useState(DEFAULT_SCENARIO_ID);
  const [replay, setReplay] = useState<SimulationResult | null>(null);
  const [scenarioSummary, setScenarioSummary] = useState<SimulationSummary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [replayLoading, setReplayLoading] = useState(false);
  const [layout, setLayout] = useState<LayoutDefinition | null>(null);
  const [scenario, setScenario] = useState<ScenarioDefinition | null>(null);
  const [runtimeSession, setRuntimeSession] = useState<RuntimeSessionState | null>(null);
  const [currentSnapshot, setCurrentSnapshot] = useState<WorldSnapshot | null>(null);
  const [runtimeHistory, setRuntimeHistory] = useState<WorldSnapshot[]>([]);
  const [replayIndex, setReplayIndex] = useState(0);
  const [cameraId, setCameraId] = useState('line-follow');
  const [selectedLineCarId, setSelectedLineCarId] = useState<string | null>(null);
  const [selectedMaterialStationId, setSelectedMaterialStationId] = useState<string | null>(null);
  const [showSceneHud, setShowSceneHud] = useState(false);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const autoStartedScenarioIdsRef = useRef(new Set<string>());
  const lastCameraSessionRef = useRef<string | null>(null);
  const runtimeHistorySessionRef = useRef<string | null>(null);
  const sceneCanvasRef = useRef<FactoryCanvasHandle | null>(null);
  const deferredSnapshot = useDeferredValue(currentSnapshot);

  const selectedCatalogItem = useMemo(
    () => scenarioCatalog.find((item) => item.id === selectedScenarioId) ?? null,
    [scenarioCatalog, selectedScenarioId]
  );
  const isBaselineScenario = (scenario?.id ?? selectedScenarioId) === DEFAULT_SCENARIO_ID;
  const activeScenarioId = scenario?.id ?? selectedScenarioId;

  const resetScenarioState = useEffectEvent(() => {
    lastCameraSessionRef.current = null;
    startTransition(() => {
      setReplay(null);
      setScenarioSummary(null);
      setReplayIndex(0);
      setLayout(null);
      setScenario(null);
      setRuntimeSession(null);
      setCurrentSnapshot(null);
      setRuntimeHistory([]);
      setSelectedLineCarId(null);
      setSelectedMaterialStationId(null);
    });
  });

  const applyRuntimeEnvelope = useEffectEvent((envelope: RuntimeEnvelope) => {
    if (envelope.scenario.id !== selectedScenarioId) {
      return;
    }

    startTransition(() => {
      setLayout(envelope.layout);
      setScenario(envelope.scenario);
      setRuntimeSession(envelope.session);
        if (mode === 'live') {
          setCurrentSnapshot(envelope.session?.latestSnapshot ?? null);
        }
    });
  });

  const runRuntimeAction = useEffectEvent(async (label: string, action: () => Promise<RuntimeEnvelope>) => {
    setPendingAction(label);
    setErrorMessage(null);

    try {
      const envelope = await action();
      applyRuntimeEnvelope(envelope);
      setMode('live');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Runtime action failed');
    } finally {
      setPendingAction(null);
    }
  });

  const ensureLiveSession = useEffectEvent(async (scenarioId: string, speed?: number, startTimeSec?: number) => {
    await runRuntimeAction('start', () =>
      startRuntimeSession(scenarioId, buildRuntimeStartOptions(speed, startTimeSec))
    );
  });

  const handleRuntimeMeta = useEffectEvent((envelope: RuntimeEnvelope) => {
    applyRuntimeEnvelope(envelope);
  });

  const handleRuntimeState = useEffectEvent((sessionState: RuntimeSessionState | null) => {
    startTransition(() => {
      setRuntimeSession(sessionState);
      if (mode === 'live') {
        setCurrentSnapshot(sessionState?.latestSnapshot ?? null);
      }
    });
  });

  const handleRuntimeSnapshot = useEffectEvent(
    (message: {
      sessionId: string;
      snapshot: WorldSnapshot;
      status: RuntimeSessionState['status'];
      speed: number;
      progress: number;
      recentEvents?: RuntimeSessionState['recentEvents'];
    }) => {
      startTransition(() => {
        setRuntimeSession((current) => {
          if (!current || current.sessionId !== message.sessionId) {
            return current;
          }

          return {
            ...current,
            status: message.status,
            speed: message.speed,
            simTimeSec: message.snapshot.simTimeSec,
            progress: message.progress,
            latestSnapshot: message.snapshot,
            latestKpis: message.snapshot.kpis,
            recentEvents: message.recentEvents ?? current.recentEvents,
            updatedAt: new Date().toISOString()
          };
        });

        if (mode === 'live') {
          setCurrentSnapshot(message.snapshot);
        }
        setRuntimeHistory((current) => {
          const next =
            current.at(-1)?.simTimeSec === message.snapshot.simTimeSec
              ? current
              : [...current, message.snapshot].filter((snapshot, index, snapshots) => {
                  return snapshots.findIndex((candidate) => candidate.simTimeSec === snapshot.simTimeSec) === index;
                });
          return next.slice(-900);
        });
      });
    }
  );

  useEffect(() => {
    let cancelled = false;

    fetchScenarioCatalog()
      .then((catalog) => {
        if (cancelled) {
          return;
        }

        startTransition(() => {
          setScenarioCatalog(catalog);
          setSelectedScenarioId((current) => {
            if (catalog.some((item) => item.id === current)) {
              return current;
            }

            return catalog.find((item) => item.id === DEFAULT_SCENARIO_ID)?.id ?? catalog[0]?.id ?? current;
          });
        });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setErrorMessage(error instanceof Error ? error.message : 'Failed to load scenario catalog');
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    resetScenarioState();
    setErrorMessage(null);
  }, [selectedScenarioId]);

  useEffect(() => {
    if (!selectedScenarioId) {
      return;
    }

    let cancelled = false;
    setSummaryLoading(true);

    fetchScenarioSummary(selectedScenarioId)
      .then((summary) => {
        if (!cancelled) {
          startTransition(() => {
            setScenarioSummary(summary);
          });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setErrorMessage((current) => current ?? (error instanceof Error ? error.message : 'Failed to load scenario summary'));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setSummaryLoading(false);
        }
      });

    fetchRuntimeState(selectedScenarioId)
      .then((envelope) => {
        if (!cancelled) {
          applyRuntimeEnvelope(envelope);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setErrorMessage((current) => current ?? (error instanceof Error ? error.message : 'Failed to load runtime state'));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedScenarioId]);

  useEffect(() => {
    if (!selectedScenarioId) {
      return;
    }

    return subscribeRuntime(selectedScenarioId, {
      onMeta: handleRuntimeMeta,
      onState: handleRuntimeState,
      onSnapshot: handleRuntimeSnapshot
    });
  }, [selectedScenarioId]);

  useEffect(() => {
    if (
      mode !== 'live' ||
      !scenario ||
      runtimeSession ||
      autoStartedScenarioIdsRef.current.has(selectedScenarioId)
    ) {
      return;
    }

    autoStartedScenarioIdsRef.current.add(selectedScenarioId);
    void ensureLiveSession(selectedScenarioId, DEFAULT_RUNTIME_SPEED, 0);
  }, [mode, runtimeSession, scenario, selectedScenarioId]);

  useEffect(() => {
    if (mode !== 'replay' || replay || replayLoading || !selectedScenarioId) {
      return;
    }

    let cancelled = false;
    setReplayLoading(true);

    fetchReplay(selectedScenarioId)
      .then((result) => {
        if (cancelled) {
          return;
        }

        startTransition(() => {
          setReplay(result);
          setLayout(result.layout);
          setScenario(result.scenario);
        });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setErrorMessage(error instanceof Error ? error.message : 'Failed to load replay');
        }
      })
      .finally(() => {
        if (!cancelled) {
          setReplayLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [mode, replay, replayLoading, selectedScenarioId]);

  useEffect(() => {
    if (mode === 'live') {
      return;
    }

    if (!replay) {
      startTransition(() => {
        setCurrentSnapshot(null);
      });
      return;
    }

    const snapshot = replay.snapshots[replayIndex] ?? replay.snapshots.at(-1) ?? null;
    startTransition(() => {
      setCurrentSnapshot(snapshot);
    });
  }, [mode, replay, replayIndex]);

  useEffect(() => {
    if (mode !== 'live' || !runtimeSession || lastCameraSessionRef.current === runtimeSession.sessionId) {
      return;
    }

    lastCameraSessionRef.current = runtimeSession.sessionId;
    startTransition(() => {
      setCameraId('line-follow');
    });
  }, [mode, runtimeSession]);

  useEffect(() => {
    if (mode !== 'live' || !runtimeSession || runtimeHistorySessionRef.current === runtimeSession.sessionId) {
      return;
    }

    runtimeHistorySessionRef.current = runtimeSession.sessionId;
    startTransition(() => {
      setRuntimeHistory(runtimeSession.latestSnapshot ? [runtimeSession.latestSnapshot] : []);
    });
  }, [mode, runtimeSession]);

  const advanceReplay = useEffectEvent(() => {
    if (!replay || mode !== 'replay') {
      return;
    }

    startTransition(() => {
      setReplayIndex((current) => {
        const next = current + 1;
        return next >= replay.snapshots.length ? 0 : next;
      });
    });
  });

  useEffect(() => {
    if (!replay || mode !== 'replay') {
      return;
    }

    const timer = window.setInterval(() => {
      advanceReplay();
    }, 75);

    return () => window.clearInterval(timer);
  }, [mode, replay]);

  const displayKpis: KpiSummary | null =
    mode === 'live'
      ? runtimeSession?.latestKpis ?? deferredSnapshot?.kpis ?? replay?.kpis ?? null
      : deferredSnapshot?.kpis ?? replay?.kpis ?? runtimeSession?.latestKpis ?? null;

  const stationRows = useMemo(() => deferredSnapshot?.stations ?? [], [deferredSnapshot]);
  const activeTasks = deferredSnapshot?.tasks ?? [];
  const amrRows = deferredSnapshot?.amrs ?? [];
  const taskById = useMemo(() => new Map(activeTasks.map((task) => [task.id, task])), [activeTasks]);
  const activeAmr = deferredSnapshot?.amrs.find((amr) => amr.status !== 'idle') ?? null;
  const trendSourceSnapshots = useMemo(() => {
    if (mode === 'live') {
      return runtimeHistory.length > 0 ? runtimeHistory : deferredSnapshot ? [deferredSnapshot] : [];
    }

    if (!replay || !deferredSnapshot) {
      return [];
    }

    return replay.snapshots.filter((snapshot) => snapshot.simTimeSec <= deferredSnapshot.simTimeSec);
  }, [deferredSnapshot, mode, replay, runtimeHistory]);
  const trendPoints = useMemo(
    () => buildTrendPoints(trendSourceSnapshots, scenario?.taktTimeSec ?? 40),
    [scenario, trendSourceSnapshots]
  );
  const expectedUph = scenario ? 3600 / scenario.taktTimeSec : 90;
  const stationStateCounts = useMemo(() => {
    const counts = new Map<WorldSnapshot['stations'][number]['state'], number>();
    for (const station of stationRows) {
      counts.set(station.state, (counts.get(station.state) ?? 0) + 1);
    }
    return counts;
  }, [stationRows]);
  const fleetSummary = useMemo(() => {
    const moving = amrRows.filter((amr) => amr.status === 'moving').length;
    const handling = amrRows.filter((amr) => amr.status === 'handling').length;
    const idle = amrRows.filter((amr) => amr.status === 'idle').length;
    const totalDistance = amrRows.reduce((sum, amr) => sum + amr.totalDistanceM, 0);
    const utilization = deferredSnapshot ? getOverallAmrUtilizationPct(deferredSnapshot) : 0;
    return { moving, handling, idle, totalDistance, utilization };
  }, [amrRows, deferredSnapshot]);
  const materialRows = useMemo<MaterialStationView[]>(() => {
    const unitsPerCar = scenario?.stations.unitsPerCar ?? 1;
    const taktTimeSec = scenario?.taktTimeSec ?? 40;

    return stationRows.map((station) => {
      const totalQty = station.bins.reduce((sum, bin) => sum + bin.quantity, 0);
      const totalCapacity = station.bins.reduce((sum, bin) => sum + bin.capacity, 0);
      const fillRatio = totalCapacity > 0 ? totalQty / totalCapacity : 0;
      const pendingBins = station.bins.filter((bin) => bin.pendingRequest).length;
      const emptyBins = station.bins.filter((bin) => bin.quantity <= 0).length;
      const coverageCars = unitsPerCar > 0 ? totalQty / unitsPerCar : totalQty;
      const status: MaterialStatus = station.isStarved
        ? 'starved'
        : pendingBins > 0
          ? 'replenishing'
          : fillRatio <= 0.2
            ? 'low'
            : 'healthy';

      return {
        id: station.id,
        index: station.index,
        qpc: station.qpc,
        currentCarId: station.currentCarId,
        totalQty,
        totalCapacity,
        fillRatio,
        coverageCars,
        coverageSec: coverageCars * taktTimeSec,
        consumedUnits: displayKpis?.stationConsumption[station.id] ?? 0,
        pendingBins,
        emptyBins,
        status,
        bins: station.bins
      };
    });
  }, [displayKpis, scenario, stationRows]);
  const lineCars = useMemo(
    () => [...(deferredSnapshot?.cars ?? [])].sort((left, right) => left.lineOrder - right.lineOrder),
    [deferredSnapshot]
  );
  const selectedMaterialStation =
    materialRows.find((station) => station.id === selectedMaterialStationId) ?? materialRows[0] ?? null;
  const materialTotals = useMemo(() => {
    const totalQty = materialRows.reduce((sum, station) => sum + station.totalQty, 0);
    const totalCapacity = materialRows.reduce((sum, station) => sum + station.totalCapacity, 0);
    const pendingBins = materialRows.reduce((sum, station) => sum + station.pendingBins, 0);
    const emptyBins = materialRows.reduce((sum, station) => sum + station.emptyBins, 0);
    const minCoverageCars =
      materialRows.length > 0 ? Math.min(...materialRows.map((station) => station.coverageCars)) : 0;

    return {
      totalQty,
      totalCapacity,
      fillRatio: totalCapacity > 0 ? totalQty / totalCapacity : 0,
      pendingBins,
      emptyBins,
      minCoverageCars
    };
  }, [materialRows]);
  const selectedLineCar =
    lineCars.find((car) => car.id === selectedLineCarId) ?? lineCars[Math.floor(lineCars.length / 2)] ?? null;
  const selectedLineSkid = selectedLineCar
    ? deferredSnapshot?.skids.find((skid) => skid.id === selectedLineCar.skidId || skid.carId === selectedLineCar.id) ?? null
    : null;
  const runtimeAuditChecks = useMemo<RuntimeAuditCheck[]>(() => {
    if (!deferredSnapshot || !scenario) {
      return [];
    }

    const bins = deferredSnapshot.stations.flatMap((station) => station.bins);
    const invalidBins = bins.filter((bin) => bin.quantity < 0 || bin.quantity > bin.capacity);
    const pendingBins = bins.filter((bin) => bin.pendingRequest).length;
    const duplicateTaskBins = activeTasks.length - new Set(activeTasks.map((task) => task.binId)).size;
    const qpcMismatches = deferredSnapshot.stations.filter(
      (station, index) => station.qpc !== scenario.stations.qpc[index]
    );
    const skidById = new Map(deferredSnapshot.skids.map((skid) => [skid.id, skid]));
    const missingSkids = deferredSnapshot.cars.filter((car) => !skidById.has(car.skidId)).length;
    const maxCarSkidOffset = deferredSnapshot.cars.reduce((maxOffset, car) => {
      const skid = skidById.get(car.skidId);
      if (!skid) {
        return maxOffset;
      }

      return Math.max(maxOffset, Math.hypot(car.x - skid.x, car.z - skid.z));
    }, 0);
    const orderedCars = [...deferredSnapshot.cars].sort((left, right) => left.lineOrder - right.lineOrder);
    const pitchErrors: number[] = [];
    for (let index = 1; index < orderedCars.length; index += 1) {
      const previous = orderedCars[index - 1]!;
      const current = orderedCars[index]!;
      pitchErrors.push(Math.abs(previous.distanceM - current.distanceM - scenario.line.pitchM));
    }
    const maxPitchError = pitchErrors.length > 0 ? Math.max(...pitchErrors) : 0;
    const expectedSpeed = scenario.line.conveyorSpeedMps;
    const lineSpeedError = Math.abs(deferredSnapshot.line.speedMps - expectedSpeed);
    const movingAmrs = deferredSnapshot.amrs.filter((amr) => amr.status === 'moving');
    const routeViolations = movingAmrs.filter(
      (amr) => !amr.targetNodeId || amr.routeNodeIds.length === 0 || amr.routeRemainingDistanceM <= 0
    ).length;

    return [
      {
        id: 'line-clock',
        label: 'Line Clock',
        tone:
          deferredSnapshot.kpis.lineDowntimeSec > 0 || deferredSnapshot.kpis.starvationSec > 0 || lineSpeedError > 0.001
            ? 'fail'
            : 'pass',
        detail: `speed ${deferredSnapshot.line.speedMps.toFixed(4)} m/s, starvation ${deferredSnapshot.kpis.starvationSec.toFixed(1)} s, downtime ${deferredSnapshot.kpis.lineDowntimeSec.toFixed(1)} s`
      },
      {
        id: 'station-qpc',
        label: 'Station QPC',
        tone: qpcMismatches.length === 0 ? 'pass' : 'fail',
        detail:
          qpcMismatches.length === 0
            ? `${deferredSnapshot.stations.length} station QPC values match scenario config`
            : `${qpcMismatches.length} station QPC mismatches`
      },
      {
        id: 'two-bin',
        label: '2-Bin FSM',
        tone: invalidBins.length > 0 || duplicateTaskBins > 0 ? 'fail' : pendingBins > 0 ? 'watch' : 'pass',
        detail: `${bins.length} bins, ${pendingBins} pending, duplicate task bins ${duplicateTaskBins}`
      },
      {
        id: 'car-skid',
        label: 'Car / Skid',
        tone: missingSkids > 0 || maxCarSkidOffset > 0.05 ? 'fail' : 'pass',
        detail: `${deferredSnapshot.cars.length} cars bound, missing ${missingSkids}, max offset ${maxCarSkidOffset.toFixed(3)} m`
      },
      {
        id: 'pitch-order',
        label: 'Pitch / Order',
        tone: maxPitchError > 0.05 ? 'fail' : orderedCars.length < 2 ? 'watch' : 'pass',
        detail: `${orderedCars.length} online cars, pitch error ${maxPitchError.toFixed(3)} m`
      },
      {
        id: 'amr-route',
        label: 'AMR Route',
        tone: routeViolations > 0 ? 'fail' : movingAmrs.length === 0 ? 'watch' : 'pass',
        detail:
          movingAmrs.length === 0
            ? 'no AMR currently moving'
            : `${movingAmrs.length} moving, route violations ${routeViolations}`
      }
    ];
  }, [activeTasks, deferredSnapshot, scenario]);
  const currentAlerts = deferredSnapshot?.alerts ?? [];
  const runtimeEvents = useMemo(() => {
    if (mode === 'live') {
      return (runtimeSession?.recentEvents ?? []).slice(-14).reverse();
    }

    if (!replay || !deferredSnapshot) {
      return [];
    }

    return replay.events
      .filter((event) => event.simTimeSec <= deferredSnapshot.simTimeSec)
      .slice(-14)
      .reverse();
  }, [deferredSnapshot, mode, replay, runtimeSession]);
  const referenceValidation = replay?.validation ?? scenarioSummary?.validation ?? null;
  const progress =
    mode === 'live'
      ? runtimeSession?.progress ?? 0
      : replay && deferredSnapshot
        ? Math.min(1, deferredSnapshot.simTimeSec / replay.scenario.durationSec)
        : 0;
  const runtimeSpeed = runtimeSession?.speed ?? DEFAULT_RUNTIME_SPEED;
  const runtimeStatus = runtimeSession?.status ?? 'paused';
  const liveWindowStartSec = scenario?.report.liveWindowStartSec ?? selectedCatalogItem?.liveWindowStartSec ?? 0;
  const runtimeStartLabel = formatClock(runtimeSession?.startTimeSec ?? liveWindowStartSec);
  const selectedScenarioName = scenario?.name ?? selectedCatalogItem?.name ?? 'Scenario';
  const selectedScenarioDescription =
    scenario?.description ??
    selectedCatalogItem?.description ??
    'Runtime DES study for automotive assembly replenishment.';

  const validationGate =
    !referenceValidation
      ? { label: summaryLoading || replayLoading ? 'LOADING' : '--', tone: 'muted' as const }
      : referenceValidation.passed
        ? { label: 'PASS', tone: 'good' as const }
        : { label: 'FAIL', tone: 'warn' as const };

  const baselineGate =
    !displayKpis || !scenario
      ? { label: '--', tone: 'muted' as const }
      : mode === 'live' &&
            isBaselineScenario &&
            runtimeStatus !== 'completed' &&
            ((runtimeSession?.simTimeSec ?? 0) < scenario.report.warmupSec || displayKpis.steadyStateCycleSec <= 0)
        ? { label: 'PENDING', tone: 'neutral' as const }
        : displayKpis.baselinePass
          ? { label: 'PASS', tone: 'good' as const }
          : { label: 'FAIL', tone: 'warn' as const };

  useEffect(() => {
    if (lineCars.length === 0) {
      if (selectedLineCarId !== null) {
        startTransition(() => setSelectedLineCarId(null));
      }
      return;
    }

    if (selectedLineCarId && lineCars.some((car) => car.id === selectedLineCarId)) {
      return;
    }

    const middleCar = lineCars[Math.floor(lineCars.length / 2)]!;
    startTransition(() => setSelectedLineCarId(middleCar.id));
  }, [lineCars, selectedLineCarId]);

  useEffect(() => {
    if (materialRows.length === 0) {
      if (selectedMaterialStationId !== null) {
        startTransition(() => setSelectedMaterialStationId(null));
      }
      return;
    }

    if (selectedMaterialStationId && materialRows.some((station) => station.id === selectedMaterialStationId)) {
      return;
    }

    startTransition(() => setSelectedMaterialStationId(materialRows[0]!.id));
  }, [materialRows, selectedMaterialStationId]);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div>
          <div className="eyebrow">DES Platform</div>
          <h1 className="brand">Automotive Runtime Console</h1>
          <p className="support-copy">
            Scenario-switched DES runtime for layout-driven assembly lines, with conveyor flow, station state propagation,
            two-bin logic, AMR travel, queue growth, and KPI checks running on the simulation core.
          </p>
        </div>

        <div className="mode-toggle">
          <button className={mode === 'live' ? 'active' : ''} onClick={() => setMode('live')}>
            Live Runtime
          </button>
          <button className={mode === 'replay' ? 'active' : ''} onClick={() => setMode('replay')}>
            Replay
          </button>
          <a href={`/api/report/${encodeURIComponent(activeScenarioId)}`} target="_blank" rel="noreferrer">
            Report
          </a>
        </div>

        <section className="scenario-section">
          <div className="section-header">
            <span>Experiment Library</span>
          </div>
          <div className="scenario-list">
            {scenarioCatalog.map((item) => {
              const tone = getScenarioTone(item);
              return (
                <button
                  key={item.id}
                  className={`scenario-card ${item.id === selectedScenarioId ? 'active' : ''}`}
                  onClick={() => setSelectedScenarioId(item.id)}
                >
                  <div className="scenario-title-row">
                    <strong>{item.name}</strong>
                    <span className={`scenario-tag ${tone}`}>{getScenarioTag(item)}</span>
                  </div>
                  <p>{item.description}</p>
                  <div className="scenario-meta">
                    <span>{item.layoutId}</span>
                    <span>{item.amrCount} AMRs</span>
                    <span>{item.breakdownEnabled ? item.breakdownMode : 'No breakdown'}</span>
                  </div>
                </button>
              );
            })}
          </div>
        </section>

        <section className="rail-section">
          <div className="section-header">
            <span>Scenario Brief</span>
          </div>
          <div className="scenario-brief">
            <div className="scenario-brief-header">
              <strong>{selectedScenarioName}</strong>
              <span className={`scenario-tag ${getScenarioTone(selectedCatalogItem)}`}>{getScenarioTag(selectedCatalogItem)}</span>
            </div>
            <p className="scenario-description">{selectedScenarioDescription}</p>
            <div className="rows">
              <div className="row">
                <span>Layout</span>
                <b>{layout?.name ?? selectedCatalogItem?.layoutId ?? '--'}</b>
              </div>
              <div className="row">
                <span>AMR fleet</span>
                <b>
                  {scenario
                    ? `${scenario.amr.count} @ ${scenario.amr.speedMps.toFixed(2)} m/s`
                    : selectedCatalogItem
                      ? `${selectedCatalogItem.amrCount} @ ${selectedCatalogItem.amrSpeedMps.toFixed(2)} m/s`
                      : '--'}
                </b>
              </div>
              <div className="row">
                <span>Dispatch</span>
                <b>{formatDispatchLabel(scenario?.dispatch.policy)}</b>
              </div>
              <div className="row">
                <span>Breakdown</span>
                <b>{formatBreakdownLabel(scenario, selectedCatalogItem)}</b>
              </div>
              <div className="row">
                <span>Warmup</span>
                <b>{scenario ? formatClock(scenario.report.warmupSec) : '--'}</b>
              </div>
              <div className="row">
                <span>Live window</span>
                <b>{formatClock(liveWindowStartSec)}</b>
              </div>
            </div>
          </div>
        </section>

        <section className="control-panel">
          <div className="section-header">
            <span>Runtime Control</span>
          </div>
          <div className="runtime-actions">
            <button
              className="primary"
              onClick={() =>
                void runRuntimeAction(runtimeSession ? 'restart-t0' : 'start-t0', () =>
                  runtimeSession
                    ? restartRuntimeSession(selectedScenarioId, buildRuntimeStartOptions(runtimeSpeed, 0))
                    : startRuntimeSession(selectedScenarioId, buildRuntimeStartOptions(DEFAULT_RUNTIME_SPEED, 0))
                )
              }
              disabled={pendingAction !== null || !selectedScenarioId}
            >
              {runtimeSession ? 'Restart From T0' : 'Start From T0'}
            </button>
            <button
              onClick={() =>
                void runRuntimeAction(runtimeStatus === 'running' ? 'pause' : 'resume', () =>
                  runtimeStatus === 'running'
                    ? pauseRuntimeSession(selectedScenarioId)
                    : resumeRuntimeSession(selectedScenarioId)
                )
              }
              disabled={pendingAction !== null || !runtimeSession}
            >
              {runtimeStatus === 'running' ? 'Pause' : 'Resume'}
            </button>
          </div>
          <div className="runtime-alt-actions">
            <div className="runtime-note">
              <span>Live Window</span>
              <strong>{formatClock(liveWindowStartSec)}</strong>
            </div>
            <button
              onClick={() =>
                void runRuntimeAction(runtimeSession ? 'restart-window' : 'start-window', () =>
                  runtimeSession
                    ? restartRuntimeSession(selectedScenarioId, buildRuntimeStartOptions(runtimeSpeed, liveWindowStartSec))
                    : startRuntimeSession(selectedScenarioId, buildRuntimeStartOptions(scenario?.report.livePlaybackSpeed, liveWindowStartSec))
                )
              }
              disabled={pendingAction !== null || !selectedScenarioId}
            >
              {runtimeSession ? 'Restart Live Window' : 'Start Live Window'}
            </button>
          </div>
          <div className="control-note">
            Live mode now defaults to T0 at 12x so the first car, skid, station arrivals, and replenishment requests are visible
            without waiting. The live window shortcut jumps to the later AMR-heavy period.
          </div>
          <div className="speed-strip">
            {SPEED_OPTIONS.map((speed) => (
              <button
                key={speed}
                className={Math.abs(runtimeSpeed - speed) < 0.001 ? 'active' : ''}
                onClick={() => void runRuntimeAction(`speed-${speed}`, () => updateRuntimeSpeed(selectedScenarioId, speed))}
                disabled={pendingAction !== null || !selectedScenarioId}
              >
                {speed}x
              </button>
            ))}
          </div>
          <div className="status-grid">
            <div>
              <span>Status</span>
              <strong className={`pill ${runtimeStatus}`}>{runtimeStatus}</strong>
            </div>
            <div>
              <span>Speed</span>
              <strong>{formatSpeedMultiplier(runtimeSpeed)}</strong>
            </div>
            <div>
              <span>Sim Clock</span>
              <strong>{formatClock(runtimeSession?.simTimeSec ?? 0)}</strong>
            </div>
            <div>
              <span>View Start</span>
              <strong>{runtimeStartLabel}</strong>
            </div>
          </div>
          <div className="progress-track" aria-hidden="true">
            <i style={{ width: `${Math.max(0, progress * 100)}%` }} />
          </div>
          <div className="progress-meta">
            <span>Progress</span>
            <strong>{formatProgress(progress)}</strong>
          </div>
          {pendingAction ? (
            <div className="muted small-copy" aria-live="polite">
              Applying `{pendingAction}`...
            </div>
          ) : null}
          {errorMessage ? (
            <div className="error-banner" aria-live="polite">
              {errorMessage}
            </div>
          ) : null}
        </section>

        {displayKpis ? (
          <>
            <section className="metric-strip">
              <div>
                <span>Steady cycle</span>
                <strong>{displayKpis.steadyStateCycleSec.toFixed(2)} s</strong>
              </div>
              <div>
                <span>Steady UPH</span>
                <strong>{displayKpis.steadyStateUph.toFixed(2)}</strong>
              </div>
              <div>
                <span>Validation</span>
                <strong className={validationGate.tone}>{validationGate.label}</strong>
              </div>
            </section>

            <section className="rail-section">
              <div className="section-header">
                <span>Line State</span>
              </div>
              <div className="rows">
                <div className="row">
                  <span>Completed cars</span>
                  <b>{displayKpis.completedCars}</b>
                </div>
                <div className="row">
                  <span>Starvation</span>
                  <b>{displayKpis.starvationSec.toFixed(1)} s</b>
                </div>
                <div className="row">
                  <span>Downtime</span>
                  <b>{displayKpis.lineDowntimeSec.toFixed(1)} s</b>
                </div>
                <div className="row">
                  <span>Total AMR distance</span>
                  <b>{displayKpis.totalAmrDistanceM.toFixed(1)} m</b>
                </div>
                <div className="row">
                  <span>{isBaselineScenario ? 'Baseline gate' : 'Scenario mode'}</span>
                  <b className={isBaselineScenario ? baselineGate.tone : 'neutral'}>
                    {isBaselineScenario ? baselineGate.label : getScenarioTag(selectedCatalogItem)}
                  </b>
                </div>
              </div>
            </section>

            <section className="rail-section">
              <div className="section-header">
                <span>Line-Side Material</span>
              </div>
              <div className="material-summary-mini">
                <div>
                  <span>On hand</span>
                  <strong>
                    {formatQuantity(materialTotals.totalQty)} / {formatQuantity(materialTotals.totalCapacity)}
                  </strong>
                </div>
                <div>
                  <span>Pending bins</span>
                  <strong>{materialTotals.pendingBins}</strong>
                </div>
              </div>
              <div className="station-list">
                {materialRows.map((stationState) => (
                  <button
                    className={`station-row station-row-button ${selectedMaterialStation?.id === stationState.id ? 'active' : ''}`}
                    key={stationState.id}
                    onClick={() => {
                      setSelectedMaterialStationId(stationState.id);
                      const stationLayout = layout?.stations.find((station) => station.id === stationState.id);
                      if (stationLayout) {
                        sceneCanvasRef.current?.focusPoint(stationLayout.lineX, stationLayout.stationZ);
                      }
                    }}
                  >
                    <div>
                      <strong>{stationState.id}</strong>
                      <span>
                        QPC {stationState.qpc} · {formatQuantity(stationState.totalQty)}/{formatQuantity(stationState.totalCapacity)} pcs ·{' '}
                        {stationState.currentCarId ?? 'no car'}
                      </span>
                      <i className="station-material-bar">
                        <em style={{ width: `${Math.max(3, stationState.fillRatio * 100)}%` }} />
                      </i>
                    </div>
                    <div className="station-bins">
                      {stationState.bins.map((bin) => (
                        <span
                          key={bin.id}
                          className={`bin-indicator ${
                            bin.quantity <= 0 ? (bin.pendingRequest ? 'pending' : 'empty') : bin.isActive ? 'active' : ''
                          }`}
                        >
                          {bin.quantity}/{bin.capacity}
                        </span>
                      ))}
                    </div>
                  </button>
                ))}
              </div>
            </section>

            <section className="rail-section">
              <div className="section-header">
                <span>Alerts</span>
              </div>
              <div className="task-list">
                {currentAlerts.length === 0 ? (
                  <span className="muted">No active alerts.</span>
                ) : (
                  currentAlerts.map((alert) => (
                    <div className={`task-row alert-row ${alert.severity}`} key={alert.code}>
                      <span>{alert.code}</span>
                      <strong>{alert.message}</strong>
                    </div>
                  ))
                )}
              </div>
            </section>

            <section className="rail-section">
              <div className="section-header">
                <span>Validation Reference</span>
              </div>
              <div className="task-list">
                {referenceValidation ? (
                  referenceValidation.checks.map((check) => (
                    <div className="task-row" key={check.id}>
                      <span>{check.label}</span>
                      <strong className={check.passed ? 'good' : 'warn'}>{check.passed ? 'PASS' : 'FAIL'}</strong>
                    </div>
                  ))
                ) : (
                  <span className="muted">
                    {summaryLoading ? 'Loading scenario validation summary...' : 'Loading final validation summary...'}
                  </span>
                )}
              </div>
            </section>
          </>
        ) : null}
      </aside>

      <main className="workspace">
        <header className="workspace-header">
          <div>
            <div className="eyebrow">3D Scene</div>
            <h2>{selectedScenarioName}</h2>
            <p className="scene-hint">
              {selectedScenarioDescription} Wheel to zoom, right-drag to pan, left-drag to orbit. Use the fit controls for
              full floor, main line, or AMR aisle framing.
            </p>
          </div>
          <div className="scene-toolbar">
            <div className="camera-switch">
              <button className={cameraId === 'line-follow' ? 'active' : ''} onClick={() => setCameraId('line-follow')}>
                Line Follow
              </button>
              <button className={cameraId === 'line-overview' ? 'active' : ''} onClick={() => setCameraId('line-overview')}>
                Line Overview
              </button>
              <button className={cameraId === 'station-close' ? 'active' : ''} onClick={() => setCameraId('station-close')}>
                Station
              </button>
              <button className={cameraId === 'amr-aisle' ? 'active' : ''} onClick={() => setCameraId('amr-aisle')}>
                AMR
              </button>
            </div>
            <div className="scene-tools">
              <button onClick={() => sceneCanvasRef.current?.fitFactory()}>Fit Floor</button>
              <button onClick={() => sceneCanvasRef.current?.focusLine()}>Fit Line</button>
              <button onClick={() => sceneCanvasRef.current?.focusAisle()}>Fit Aisle</button>
              <button
                className={activeAmr ? 'active' : ''}
                onClick={() => activeAmr && sceneCanvasRef.current?.focusPoint(activeAmr.x, activeAmr.z)}
                disabled={!activeAmr}
              >
                Track AMR
              </button>
              <button onClick={() => sceneCanvasRef.current?.zoomIn()}>+</button>
              <button onClick={() => sceneCanvasRef.current?.zoomOut()}>-</button>
              <button className={showSceneHud ? 'active' : ''} onClick={() => setShowSceneHud((current) => !current)}>
                HUD
              </button>
            </div>
          </div>
        </header>

        <section className="scene-panel">
          <FactoryCanvas ref={sceneCanvasRef} layout={layout} snapshot={deferredSnapshot} cameraId={cameraId} />
          {showSceneHud ? (
            <div className="scene-overlay">
              <div>
                <span>Scenario</span>
                <strong>{selectedScenarioName}</strong>
              </div>
              <div>
                <span>Mode</span>
                <strong>{mode === 'live' ? 'Runtime session' : replayLoading ? 'Loading replay' : 'Replay timeline'}</strong>
              </div>
              <div>
                <span>Sim time</span>
                <strong>{deferredSnapshot ? formatClock(deferredSnapshot.simTimeSec) : 'loading'}</strong>
              </div>
              <div>
                <span>Session</span>
                <strong>{mode === 'live' ? runtimeStatus : 'replay'}</strong>
              </div>
              <div>
                <span>Open tasks</span>
                <strong>{activeTasks.length}</strong>
              </div>
              <div>
                <span>Progress</span>
                <strong>{formatProgress(progress)}</strong>
              </div>
            </div>
          ) : null}
        </section>

        <section className="runtime-audit-strip" aria-label="Runtime logic audit">
          {runtimeAuditChecks.length === 0 ? (
            <div className="audit-card watch">
              <span>Runtime Audit</span>
              <strong>WAITING</strong>
              <small>No snapshot has been received yet.</small>
            </div>
          ) : (
            runtimeAuditChecks.map((check) => (
              <div className={`audit-card ${check.tone}`} key={check.id}>
                <span>{check.label}</span>
                <strong>{check.tone === 'pass' ? 'PASS' : check.tone === 'watch' ? 'WATCH' : 'FAIL'}</strong>
                <small>{check.detail}</small>
              </div>
            ))
          )}
        </section>

        <section className="line-diagnostics">
          <div className="bottom-panel">
            <div className="section-header">
              <span>Main Line Occupancy</span>
            </div>
            <div className="line-strip">
              {lineCars.length === 0 ? (
                <span className="muted">Waiting for first car release.</span>
              ) : (
                lineCars.map((car) => (
                  <button
                    key={car.id}
                    className={`line-car-chip ${selectedLineCar?.id === car.id ? 'active' : ''}`}
                    onClick={() => {
                      setSelectedLineCarId(car.id);
                      sceneCanvasRef.current?.focusPoint(car.x, car.z);
                    }}
                  >
                    <strong>{car.id}</strong>
                    <span>{car.skidId}</span>
                    <small>{formatMeters(car.distanceM)}</small>
                  </button>
                ))
              )}
            </div>
          </div>
          <div className="bottom-panel line-object-panel">
            <div className="section-header">
              <span>Car / Skid Trace</span>
            </div>
            {selectedLineCar ? (
              <div className="trace-grid">
                <div>
                  <span>Car</span>
                  <strong>{selectedLineCar.id}</strong>
                </div>
                <div>
                  <span>Skid</span>
                  <strong>{selectedLineSkid?.id ?? selectedLineCar.skidId}</strong>
                </div>
                <div>
                  <span>Line order</span>
                  <strong>#{selectedLineCar.lineOrder + 1}</strong>
                </div>
                <div>
                  <span>Next station</span>
                  <strong>{selectedLineCar.nextStationId ?? 'Exit'}</strong>
                </div>
                <div>
                  <span>Distance to next</span>
                  <strong>{formatMeters(selectedLineCar.distanceToNextStationM)}</strong>
                </div>
                <div>
                  <span>Exit ETA</span>
                  <strong>{selectedLineCar.timeToExitSec.toFixed(1)} s</strong>
                </div>
              </div>
            ) : (
              <span className="muted">No active car on the line yet.</span>
            )}
          </div>
        </section>

        <section className="performance-dashboard">
          <div className="bottom-panel trend-board">
            <div className="section-header">
              <span>Throughput / Fleet Trends</span>
            </div>
            <div className="trend-grid">
              <TrendChart
                title="Rolling UPH"
                unit="uph"
                points={trendPoints}
                valueKey="uph"
                target={expectedUph}
                color="#4ecbff"
              />
              <TrendChart
                title="AMR Utilization"
                unit="%"
                points={trendPoints}
                valueKey="amrUtilizationPct"
                color="#63d36f"
              />
            </div>
            <div className="fleet-summary">
              <div>
                <span>Moving</span>
                <strong>{fleetSummary.moving}</strong>
              </div>
              <div>
                <span>Handling</span>
                <strong>{fleetSummary.handling}</strong>
              </div>
              <div>
                <span>Idle</span>
                <strong>{fleetSummary.idle}</strong>
              </div>
              <div>
                <span>Fleet util.</span>
                <strong>{fleetSummary.utilization.toFixed(1)}%</strong>
              </div>
              <div>
                <span>Total travel</span>
                <strong>{fleetSummary.totalDistance.toFixed(1)} m</strong>
              </div>
            </div>
          </div>

          <div className="bottom-panel station-state-board">
            <div className="section-header">
              <span>Station State Board</span>
            </div>
            <div className="station-state-legend">
              {(['running', 'down', 'upstream-starved', 'material-starved', 'blocked', 'idle'] as const).map((state) => (
                <span key={state} className={`station-state-pill ${state}`}>
                  <i />
                  {getStationStateLabel(state)} {stationStateCounts.get(state) ?? 0}
                </span>
              ))}
            </div>
            <div className="station-state-grid">
              {stationRows.map((station) => (
                <button
                  key={station.id}
                  className={`station-state-card ${station.state}`}
                  onClick={() => {
                    setSelectedMaterialStationId(station.id);
                    const stationLayout = layout?.stations.find((candidate) => candidate.id === station.id);
                    if (stationLayout) {
                      sceneCanvasRef.current?.focusPoint(stationLayout.lineX, stationLayout.stationZ);
                    }
                  }}
                >
                  <header>
                    <strong>{station.id}</strong>
                    <span>{getStationStateLabel(station.state)}</span>
                  </header>
                  <p>{station.stateReason}</p>
                  <footer>
                    <span>{station.currentCarId ?? 'no car'}</span>
                    <span>
                      {displayKpis ? `${((displayKpis.stationAvailability[station.id] ?? 1) * 100).toFixed(1)}% · ` : ''}
                      {formatQuantity(station.bins.reduce((sum, bin) => sum + bin.quantity, 0))} /{' '}
                      {formatQuantity(station.bins.reduce((sum, bin) => sum + bin.capacity, 0))}
                    </span>
                  </footer>
                </button>
              ))}
            </div>
          </div>
        </section>

        <section className="amr-compact-panel">
          <div className="bottom-panel">
            <div className="section-header">
              <span>Open AMR Work</span>
            </div>
            <div className="amr-work-list">
              {amrRows.filter((amr) => amr.status !== 'idle').length === 0 ? (
                <span className="muted">No active AMR movement.</span>
              ) : (
                amrRows
                  .filter((amr) => amr.status !== 'idle')
                  .map((amr) => {
                    const task = amr.taskId ? taskById.get(amr.taskId) : null;
                    return (
                      <button
                        key={amr.id}
                        className={`amr-work-row ${amr.status}`}
                        onClick={() => sceneCanvasRef.current?.focusPoint(amr.x, amr.z)}
                      >
                        <strong>{amr.id}</strong>
                        <span>{task ? `${task.stationId} · ${task.binId}` : amr.phase}</span>
                        <span>{amr.phase}</span>
                        <span>{formatMeters(amr.routeRemainingDistanceM)}</span>
                      </button>
                    );
                  })
              )}
            </div>
          </div>
          <div className="bottom-panel">
            <div className="section-header">
              <span>State Color Semantics</span>
            </div>
            <div className="state-semantics">
              <div>
                <span className="legend-dot running" />
                <strong>Green</strong>
                <small>Station running / processing a car</small>
              </div>
              <div>
                <span className="legend-dot down" />
                <strong>Red</strong>
                <small>Availability downtime / repair</small>
              </div>
              <div>
                <span className="legend-dot upstream-starved" />
                <strong>Yellow</strong>
                <small>Waiting for upstream car/material flow</small>
              </div>
              <div>
                <span className="legend-dot material-starved" />
                <strong>Orange-red</strong>
                <small>Line-side 2-bin inventory starved</small>
              </div>
              <div>
                <span className="legend-dot blocked" />
                <strong>Blue</strong>
                <small>Reserved for downstream blocking</small>
              </div>
              <div>
                <span className="legend-dot idle" />
                <strong>Gray</strong>
                <small>No car in station window</small>
              </div>
            </div>
          </div>
        </section>

        <section className="material-diagnostics">
          <div className="bottom-panel material-board">
            <div className="section-header">
              <span>Line-Side Inventory Matrix</span>
            </div>
            <div className="material-kpi-row">
              <div>
                <span>Total remaining</span>
                <strong>
                  {formatQuantity(materialTotals.totalQty)} / {formatQuantity(materialTotals.totalCapacity)} pcs
                </strong>
              </div>
              <div>
                <span>Fill level</span>
                <strong>{(materialTotals.fillRatio * 100).toFixed(1)}%</strong>
              </div>
              <div>
                <span>Lowest coverage</span>
                <strong>{materialTotals.minCoverageCars.toFixed(0)} cars</strong>
              </div>
              <div>
                <span>Empty / pending</span>
                <strong>
                  {materialTotals.emptyBins} / {materialTotals.pendingBins}
                </strong>
              </div>
            </div>
            <div className="material-grid">
              {materialRows.map((station) => (
                <button
                  key={station.id}
                  className={`material-card ${station.status} ${selectedMaterialStation?.id === station.id ? 'active' : ''}`}
                  onClick={() => {
                    setSelectedMaterialStationId(station.id);
                    const stationLayout = layout?.stations.find((candidate) => candidate.id === station.id);
                    if (stationLayout) {
                      sceneCanvasRef.current?.focusPoint(stationLayout.lineX, stationLayout.stationZ);
                    }
                  }}
                >
                  <header>
                    <strong>{station.id}</strong>
                    <span>{getMaterialStatusLabel(station.status)}</span>
                  </header>
                  <div className="material-total">
                    <b>{formatQuantity(station.totalQty)}</b>
                    <span>/ {formatQuantity(station.totalCapacity)} pcs</span>
                  </div>
                  <i className="material-fill-track">
                    <em style={{ width: `${Math.max(3, station.fillRatio * 100)}%` }} />
                  </i>
                  <footer>
                    <span>{station.coverageCars.toFixed(0)} cars cover</span>
                    <span>{formatMinutes(station.coverageSec)}</span>
                  </footer>
                </button>
              ))}
            </div>
          </div>
          <div className="bottom-panel material-detail-panel">
            <div className="section-header">
              <span>Selected Station Material</span>
            </div>
            {selectedMaterialStation ? (
              <>
                <div className="selected-material-header">
                  <strong>{selectedMaterialStation.id}</strong>
                  <span className={`material-status ${selectedMaterialStation.status}`}>
                    {getMaterialStatusLabel(selectedMaterialStation.status)}
                  </span>
                </div>
                <div className="trace-grid material-trace-grid">
                  <div>
                    <span>QPC / bin cap</span>
                    <strong>{selectedMaterialStation.qpc}</strong>
                  </div>
                  <div>
                    <span>Remaining</span>
                    <strong>{formatQuantity(selectedMaterialStation.totalQty)}</strong>
                  </div>
                  <div>
                    <span>Total capacity</span>
                    <strong>{formatQuantity(selectedMaterialStation.totalCapacity)}</strong>
                  </div>
                  <div>
                    <span>Coverage</span>
                    <strong>{selectedMaterialStation.coverageCars.toFixed(0)} cars</strong>
                  </div>
                  <div>
                    <span>Consumed</span>
                    <strong>{selectedMaterialStation.consumedUnits}</strong>
                  </div>
                  <div>
                    <span>Current car</span>
                    <strong>{selectedMaterialStation.currentCarId ?? '--'}</strong>
                  </div>
                </div>
                <div className="bin-detail-list">
                  {selectedMaterialStation.bins.map((bin) => (
                    <div className="bin-detail-row" key={bin.id}>
                      <div>
                        <strong>{bin.id}</strong>
                        <span>{bin.isActive ? 'active' : bin.pendingRequest ? 'pending request' : 'standby'}</span>
                      </div>
                      <b>
                        {bin.quantity} / {bin.capacity}
                      </b>
                      <i>
                        <em style={{ width: `${Math.max(3, (bin.quantity / bin.capacity) * 100)}%` }} />
                      </i>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <span className="muted">No station material state available.</span>
            )}
          </div>
        </section>

        <section className="bottom-rail">
          <div className="bottom-panel">
            <div className="section-header">
              <span>Active Tasks</span>
            </div>
            <div className="task-list">
              {activeTasks.length === 0 ? (
                <span className="muted">No open replenishment tasks.</span>
              ) : (
                activeTasks.map((task) => (
                  <div className="task-row" key={task.id}>
                    <span>
                      {task.stationId} · {task.binId}
                    </span>
                    <strong>{task.status}</strong>
                    <span>{task.assignedAmrId ?? 'queue'}</span>
                    <small>{formatClock(Math.max(0, (deferredSnapshot?.simTimeSec ?? 0) - task.requestTimeSec))}</small>
                  </div>
                ))
              )}
            </div>
          </div>
          <div className="bottom-panel">
            <div className="section-header">
              <span>Recent Domain Events</span>
            </div>
            <div className="event-list">
              {runtimeEvents.length === 0 ? (
                <span className="muted">No domain events observed yet.</span>
              ) : (
                runtimeEvents.map((event) => (
                  <div className="event-row" key={event.id}>
                    <span>{formatClock(event.simTimeSec)}</span>
                    <strong>{getEventLabel(event.type)}</strong>
                    <small>{getEventPrimaryPayload(event)}</small>
                  </div>
                ))
              )}
            </div>
          </div>
          <div className="bottom-panel">
            <div className="section-header">
              <span>AMR Utilization</span>
            </div>
            <div className="util-list">
              {displayKpis
                ? Object.entries(displayKpis.amrUtilization).map(([amrId, utilization]) => (
                    <div key={amrId} className="util-row">
                      <span>{amrId}</span>
                      <div className="util-bar">
                        <i style={{ width: `${Math.max(8, utilization * 100)}%` }} />
                      </div>
                      <strong>{(utilization * 100).toFixed(1)}%</strong>
                    </div>
                  ))
                : null}
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
