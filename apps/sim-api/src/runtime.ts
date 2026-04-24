import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { listScenarioBundles } from '@des-platform/shared-schema/loader';
import type {
  EventLogEntry,
  LayoutDefinition,
  RuntimeSessionState,
  ScenarioDefinition,
  SimulationResult,
  WorldSnapshot
} from '@des-platform/shared-schema';
import { SimulationEngine, runSimulation } from '@des-platform/simulation-core';
import { renderReport } from 'reporting';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(currentDir, '../../..');
const scenariosDir = path.join(rootDir, 'config/scenarios');
const outputDir = path.join(rootDir, 'output');

export const DEFAULT_SCENARIO_ID = 'baseline-90-uph';

const SCENARIO_ALIASES = new Map<string, string>([['baseline', DEFAULT_SCENARIO_ID]]);

type ScenarioBundle = {
  scenario: ScenarioDefinition;
  layout: LayoutDefinition;
  scenarioPath: string;
  resolvedLayoutPath: string;
};

export type SimulationSummary = Pick<SimulationResult, 'scenarioId' | 'layoutId' | 'kpis' | 'validation'>;

export type ScenarioCatalogItem = {
  id: string;
  name: string;
  description: string;
  layoutId: string;
  amrCount: number;
  amrSpeedMps: number;
  breakdownEnabled: boolean;
  breakdownMode: ScenarioDefinition['breakdown']['mode'];
  liveWindowStartSec: number;
  livePlaybackSpeed: number;
  isBaseline: boolean;
};

export type RuntimeEnvelope = {
  scenario: ScenarioDefinition;
  layout: LayoutDefinition;
  session: RuntimeSessionState | null;
};

export type RuntimeEvent =
  | {
      type: 'runtime-meta';
      scenarioId: string;
      scenario: ScenarioDefinition;
      layout: LayoutDefinition;
      session: RuntimeSessionState | null;
    }
  | { type: 'runtime-state'; scenarioId: string; session: RuntimeSessionState | null }
  | {
      type: 'runtime-snapshot';
      scenarioId: string;
      sessionId: string;
      snapshot: WorldSnapshot;
      status: RuntimeSessionState['status'];
      speed: number;
      progress: number;
      recentEvents: EventLogEntry[];
    };

type RuntimeListener = (event: RuntimeEvent) => void;

let scenarioIndexCache: Promise<Map<string, ScenarioBundle>> | null = null;

const replayCache = new Map<string, SimulationResult>();
const summaryCache = new Map<string, SimulationSummary>();
const reportCache = new Map<string, string>();
const runtimeControllers = new Map<string, ScenarioRuntimeController>();

function normalizeScenarioId(scenarioId: string | undefined): string {
  if (!scenarioId) {
    return DEFAULT_SCENARIO_ID;
  }

  return SCENARIO_ALIASES.get(scenarioId) ?? scenarioId;
}

function buildValidationText(result: SimulationResult): string {
  const { kpis, validation } = result;
  return [
    `scenario=${result.scenarioId}`,
    `steadyStateCycleSec=${kpis.steadyStateCycleSec.toFixed(4)}`,
    `steadyStateUph=${kpis.steadyStateUph.toFixed(4)}`,
    `actualAverageUph=${kpis.actualAverageUph.toFixed(4)}`,
    `lineDowntimeSec=${kpis.lineDowntimeSec.toFixed(4)}`,
    `starvationSec=${kpis.starvationSec.toFixed(4)}`,
    `completedCars=${kpis.completedCars}`,
    `totalAmrDistanceM=${kpis.totalAmrDistanceM.toFixed(4)}`,
    `baselinePass=${kpis.baselinePass}`,
    `validationPass=${validation.passed}`,
    ...validation.checks.map((check) => `${check.id}=${check.passed ? 'PASS' : 'FAIL'} ${check.detail}`)
  ].join('\n');
}

function clampSpeed(speed: number | undefined, fallback: number): number {
  const next = Number.isFinite(speed) ? Number(speed) : fallback;
  return Math.min(240, Math.max(0.25, next));
}

function clampStartTime(startTimeSec: number | undefined, scenario: ScenarioDefinition): number {
  const next = Number.isFinite(startTimeSec) ? Number(startTimeSec) : scenario.report.liveWindowStartSec;
  return Math.min(scenario.durationSec, Math.max(0, next));
}

function cloneState(state: RuntimeSessionState | null): RuntimeSessionState | null {
  return state ? structuredClone(state) : null;
}

function toSummary(result: SimulationResult): SimulationSummary {
  return {
    scenarioId: result.scenarioId,
    layoutId: result.layoutId,
    kpis: result.kpis,
    validation: result.validation
  };
}

function getArtifactPrefixes(scenarioId: string): string[] {
  return scenarioId === DEFAULT_SCENARIO_ID ? [scenarioId, 'baseline'] : [scenarioId];
}

async function getScenarioIndex(): Promise<Map<string, ScenarioBundle>> {
  if (!scenarioIndexCache) {
    scenarioIndexCache = listScenarioBundles(scenariosDir).then((bundles) => {
      const index = new Map<string, ScenarioBundle>();
      for (const bundle of bundles) {
        if (index.has(bundle.scenario.id)) {
          throw new Error(`Duplicate scenario id detected: ${bundle.scenario.id}`);
        }

        index.set(bundle.scenario.id, bundle);
      }
      return index;
    });
  }

  return scenarioIndexCache;
}

async function getScenarioBundle(scenarioId: string): Promise<ScenarioBundle> {
  const resolvedScenarioId = normalizeScenarioId(scenarioId);
  const index = await getScenarioIndex();
  const bundle = index.get(resolvedScenarioId);
  if (!bundle) {
    throw new Error(`Unknown scenario: ${scenarioId}`);
  }

  return bundle;
}

async function buildReplay(scenarioId: string): Promise<SimulationResult> {
  const { scenario, layout } = await getScenarioBundle(scenarioId);
  return runSimulation(
    {
      ...scenario,
      snapshotIntervalSec: 10
    },
    layout
  );
}

async function buildSummary(scenarioId: string): Promise<SimulationSummary> {
  const normalizedScenarioId = normalizeScenarioId(scenarioId);
  const cachedReplay = replayCache.get(normalizedScenarioId);
  if (cachedReplay) {
    return toSummary(cachedReplay);
  }

  const { scenario, layout } = await getScenarioBundle(normalizedScenarioId);
  const engine = new SimulationEngine(
    {
      ...scenario,
      snapshotIntervalSec: 60
    },
    layout
  );

  await engine.initialize();
  engine.advanceTo(scenario.durationSec);
  return toSummary(engine.getResult());
}

class RuntimeSession {
  private readonly engine: SimulationEngine;
  private readonly createdAt = new Date().toISOString();
  private state: RuntimeSessionState;
  private timer: NodeJS.Timeout | null = null;
  private lastWallClockMs = 0;
  private tickInFlight = false;
  private closed = false;
  private suppressSnapshotBroadcast = false;

  constructor(
    private readonly scenario: ScenarioDefinition,
    private readonly layout: LayoutDefinition,
    speed: number,
    startTimeSec: number,
    private readonly emitEvent: (event: RuntimeEvent) => void
  ) {
    this.engine = new SimulationEngine(scenario, layout, {
      retainSnapshots: false,
      retainEvents: false,
      onEvent: (event) => {
        this.state.recentEvents = [...this.state.recentEvents, event].slice(-80);
      },
      onSnapshot: (snapshot) => {
        this.state.latestSnapshot = snapshot;
        this.state.latestKpis = snapshot.kpis;
        this.state.simTimeSec = snapshot.simTimeSec;
        this.state.progress = Math.min(1, snapshot.simTimeSec / this.state.durationSec);
        this.touch();
        if (!this.suppressSnapshotBroadcast) {
          this.emitSnapshot(snapshot);
        }
      }
    });

    this.state = {
      sessionId: `${scenario.id}-${Date.now()}`,
      scenarioId: scenario.id,
      layoutId: layout.id,
      status: 'starting',
      speed,
      startTimeSec,
      simTimeSec: 0,
      durationSec: scenario.durationSec,
      progress: 0,
      createdAt: this.createdAt,
      updatedAt: this.createdAt,
      latestSnapshot: null,
      latestKpis: null,
      recentEvents: [],
      error: null
    };
  }

  getState(): RuntimeSessionState {
    return cloneState(this.state)!;
  }

  async start(): Promise<void> {
    try {
      await this.engine.initialize();
      this.state.status = 'paused';
      this.suppressSnapshotBroadcast = true;
      this.engine.advanceTo(this.state.startTimeSec);
      this.suppressSnapshotBroadcast = false;
      if (this.state.latestSnapshot) {
        this.emitSnapshot(this.state.latestSnapshot);
      }
      this.resume();
    } catch (error) {
      this.fail(error);
    }
  }

  pause(): RuntimeSessionState {
    if (this.state.status !== 'running') {
      return this.getState();
    }

    this.clearTimer();
    this.state.status = 'paused';
    this.emitState();
    return this.getState();
  }

  resume(): RuntimeSessionState {
    if (this.state.status === 'completed' || this.state.status === 'error') {
      return this.getState();
    }

    if (this.state.status === 'running') {
      return this.getState();
    }

    this.state.status = 'running';
    this.lastWallClockMs = Date.now();
    this.emitState();
    this.timer = setInterval(() => {
      void this.tick();
    }, 100);
    this.timer.unref?.();
    return this.getState();
  }

  setSpeed(speed: number): RuntimeSessionState {
    this.state.speed = clampSpeed(speed, this.state.speed);
    this.lastWallClockMs = Date.now();
    this.emitState();
    return this.getState();
  }

  close(): void {
    this.closed = true;
    this.clearTimer();
  }

  private async tick(): Promise<void> {
    if (this.closed || this.tickInFlight || this.state.status !== 'running') {
      return;
    }

    this.tickInFlight = true;
    try {
      const nowMs = Date.now();
      const elapsedWallSec = Math.max(0, (nowMs - this.lastWallClockMs) / 1000);
      this.lastWallClockMs = nowMs;

      if (elapsedWallSec <= 0) {
        return;
      }

      const targetSimTimeSec = this.engine.simTimeSec + elapsedWallSec * this.state.speed;
      const advance = this.engine.advanceTo(targetSimTimeSec);

      if (!advance.latestSnapshot && advance.simTimeSec !== this.state.simTimeSec) {
        this.state.simTimeSec = advance.simTimeSec;
        this.state.progress = Math.min(1, advance.simTimeSec / this.state.durationSec);
        this.touch();
      }

      if (advance.finished) {
        this.clearTimer();
        this.state.status = 'completed';
        this.state.simTimeSec = this.state.durationSec;
        this.state.progress = 1;
        this.state.latestSnapshot = advance.latestSnapshot;
        this.state.latestKpis = advance.latestSnapshot?.kpis ?? this.state.latestKpis;
        this.emitState();
      }
    } catch (error) {
      this.fail(error);
    } finally {
      this.tickInFlight = false;
    }
  }

  private fail(error: unknown): void {
    this.clearTimer();
    this.state.status = 'error';
    this.state.error = error instanceof Error ? error.message : 'Unknown runtime failure';
    this.emitState();
  }

  private emitState(): void {
    this.touch();
    this.emitEvent({
      type: 'runtime-state',
      scenarioId: this.scenario.id,
      session: this.getState()
    });
  }

  private emitSnapshot(snapshot: WorldSnapshot): void {
    this.emitEvent({
      type: 'runtime-snapshot',
      scenarioId: this.scenario.id,
      sessionId: this.state.sessionId,
      snapshot,
      status: this.state.status,
      speed: this.state.speed,
      progress: this.state.progress,
      recentEvents: this.state.recentEvents
    });
  }

  private touch(): void {
    this.state.updatedAt = new Date().toISOString();
  }

  private clearTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

class ScenarioRuntimeController {
  private session: RuntimeSession | null = null;
  private readonly listeners = new Set<RuntimeListener>();

  constructor(private readonly scenarioId: string) {}

  async getEnvelope(): Promise<RuntimeEnvelope> {
    const bundle = await getScenarioBundle(this.scenarioId);
    return {
      scenario: bundle.scenario,
      layout: bundle.layout,
      session: this.session?.getState() ?? null
    };
  }

  subscribe(listener: RuntimeListener): () => void {
    this.listeners.add(listener);
    void this.getEnvelope().then((envelope) => {
      listener({
        type: 'runtime-meta',
        scenarioId: envelope.scenario.id,
        layout: envelope.layout,
        scenario: envelope.scenario,
        session: envelope.session
      });
    });

    return () => {
      this.listeners.delete(listener);
    };
  }

  async start(speed?: number, startTimeSec?: number): Promise<RuntimeEnvelope> {
    const { scenario, layout } = await getScenarioBundle(this.scenarioId);
    const runtimeSpeed = clampSpeed(speed, scenario.report.livePlaybackSpeed);
    const runtimeStartSec = clampStartTime(startTimeSec, scenario);

    this.session?.close();
    const session = new RuntimeSession(scenario, layout, runtimeSpeed, runtimeStartSec, (event) => this.broadcast(event));
    this.session = session;

    this.broadcast({
      type: 'runtime-meta',
      scenarioId: scenario.id,
      scenario,
      layout,
      session: session.getState()
    });

    await session.start();

    return {
      scenario,
      layout,
      session: session.getState()
    };
  }

  async pause(): Promise<RuntimeEnvelope> {
    const { scenario, layout } = await getScenarioBundle(this.scenarioId);
    if (!this.session) {
      return { scenario, layout, session: null };
    }

    return {
      scenario,
      layout,
      session: this.session.pause()
    };
  }

  async resume(): Promise<RuntimeEnvelope> {
    const { scenario, layout } = await getScenarioBundle(this.scenarioId);
    if (!this.session) {
      return this.start();
    }

    return {
      scenario,
      layout,
      session: this.session.resume()
    };
  }

  async restart(speed?: number, startTimeSec?: number): Promise<RuntimeEnvelope> {
    return this.start(speed, startTimeSec);
  }

  async setSpeed(speed: number): Promise<RuntimeEnvelope> {
    const { scenario, layout } = await getScenarioBundle(this.scenarioId);
    if (!this.session) {
      return this.start(speed);
    }

    return {
      scenario,
      layout,
      session: this.session.setSpeed(speed)
    };
  }

  private broadcast(event: RuntimeEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

function getRuntimeController(scenarioId: string): ScenarioRuntimeController {
  const normalizedScenarioId = normalizeScenarioId(scenarioId);
  let controller = runtimeControllers.get(normalizedScenarioId);
  if (!controller) {
    controller = new ScenarioRuntimeController(normalizedScenarioId);
    runtimeControllers.set(normalizedScenarioId, controller);
  }

  return controller;
}

export async function getScenarioCatalog(): Promise<ScenarioCatalogItem[]> {
  const index = await getScenarioIndex();
  return [...index.values()]
    .sort((left, right) => {
      const leftScore = left.scenario.id === DEFAULT_SCENARIO_ID ? -1 : 0;
      const rightScore = right.scenario.id === DEFAULT_SCENARIO_ID ? -1 : 0;
      return leftScore - rightScore || left.scenario.name.localeCompare(right.scenario.name);
    })
    .map(({ scenario, layout }) => ({
      id: scenario.id,
      name: scenario.name,
      description: scenario.description,
      layoutId: layout.id,
      amrCount: scenario.amr.count,
      amrSpeedMps: scenario.amr.speedMps,
      breakdownEnabled: scenario.breakdown.enabled,
      breakdownMode: scenario.breakdown.mode,
      liveWindowStartSec: scenario.report.liveWindowStartSec,
      livePlaybackSpeed: scenario.report.livePlaybackSpeed,
      isBaseline: scenario.id === DEFAULT_SCENARIO_ID
    }));
}

export async function getScenarioReplay(scenarioId: string, forceRefresh = false): Promise<SimulationResult> {
  const normalizedScenarioId = normalizeScenarioId(scenarioId);
  if (replayCache.has(normalizedScenarioId) && !forceRefresh) {
    return replayCache.get(normalizedScenarioId)!;
  }

  const result = await buildReplay(normalizedScenarioId);
  replayCache.set(normalizedScenarioId, result);
  summaryCache.set(normalizedScenarioId, toSummary(result));
  reportCache.set(normalizedScenarioId, renderReport(result));
  return result;
}

export async function getScenarioReport(scenarioId: string, forceRefresh = false): Promise<string> {
  const normalizedScenarioId = normalizeScenarioId(scenarioId);
  if (reportCache.has(normalizedScenarioId) && !forceRefresh) {
    return reportCache.get(normalizedScenarioId)!;
  }

  const result = await getScenarioReplay(normalizedScenarioId, forceRefresh);
  const report = renderReport(result);
  reportCache.set(normalizedScenarioId, report);
  return report;
}

export async function getScenarioSummary(scenarioId: string, forceRefresh = false): Promise<SimulationSummary> {
  const normalizedScenarioId = normalizeScenarioId(scenarioId);
  if (summaryCache.has(normalizedScenarioId) && !forceRefresh) {
    return summaryCache.get(normalizedScenarioId)!;
  }

  const summary = await buildSummary(normalizedScenarioId);
  summaryCache.set(normalizedScenarioId, summary);
  return summary;
}

export async function persistScenarioArtifacts(scenarioId = DEFAULT_SCENARIO_ID): Promise<void> {
  const normalizedScenarioId = normalizeScenarioId(scenarioId);
  const result = await getScenarioReplay(normalizedScenarioId, true);
  const report = await getScenarioReport(normalizedScenarioId);
  const summary = await getScenarioSummary(normalizedScenarioId);
  await mkdir(outputDir, { recursive: true });

  for (const artifactPrefix of getArtifactPrefixes(result.scenarioId)) {
    await writeFile(path.join(outputDir, `${artifactPrefix}-replay.json`), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    await writeFile(path.join(outputDir, `${artifactPrefix}-report.html`), report, 'utf8');
    await writeFile(path.join(outputDir, `${artifactPrefix}-summary.json`), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    await writeFile(path.join(outputDir, `${artifactPrefix}-validation.txt`), `${buildValidationText(result)}\n`, 'utf8');
  }
}

export function subscribeScenarioRuntime(scenarioId: string, listener: RuntimeListener): () => void {
  return getRuntimeController(scenarioId).subscribe(listener);
}

export async function getScenarioRuntimeState(scenarioId: string): Promise<RuntimeEnvelope> {
  return getRuntimeController(scenarioId).getEnvelope();
}

export async function startScenarioRuntime(
  scenarioId: string,
  speed?: number,
  startTimeSec?: number
): Promise<RuntimeEnvelope> {
  return getRuntimeController(scenarioId).start(speed, startTimeSec);
}

export async function pauseScenarioRuntime(scenarioId: string): Promise<RuntimeEnvelope> {
  return getRuntimeController(scenarioId).pause();
}

export async function resumeScenarioRuntime(scenarioId: string): Promise<RuntimeEnvelope> {
  return getRuntimeController(scenarioId).resume();
}

export async function restartScenarioRuntime(
  scenarioId: string,
  speed?: number,
  startTimeSec?: number
): Promise<RuntimeEnvelope> {
  return getRuntimeController(scenarioId).restart(speed, startTimeSec);
}

export async function updateScenarioRuntimeSpeed(scenarioId: string, speed: number): Promise<RuntimeEnvelope> {
  return getRuntimeController(scenarioId).setSpeed(speed);
}
