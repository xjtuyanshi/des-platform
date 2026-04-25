import { readdir } from 'node:fs/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  analyzeDesModel,
  compileDesModel,
  type GenericDesRuntime,
  type ModelDiagnosticsReport
} from '@des-platform/model-compiler';
import {
  verifyMaterialHandlingMotion,
  type MaterialMotionVerificationOptions,
  type MaterialMotionVerificationSnapshot
} from '@des-platform/motion-layer';
import type { ProcessFlowSnapshot } from '@des-platform/process-flow';
import { loadAiNativeDesModel, loadSimulationStudyCase } from '@des-platform/shared-schema/loader';
import {
  AiNativeDesModelDefinitionSchema,
  type AiNativeDesModelDefinition,
  type DslLiteral,
  type ExperimentDefinition
} from '@des-platform/shared-schema/model-dsl';
import {
  SimulationStudyCaseDefinitionSchema,
  type SimulationStudyCaseDefinition
} from '@des-platform/shared-schema/study';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(currentDir, '../../..');
const studiesDir = path.join(rootDir, 'config/studies');

export type GenericStudyCatalogItem = {
  id: string;
  name: string;
  description: string;
  modelId: string;
  modelName: string;
  experimentIds: string[];
  experiments: Array<{
    id: string;
    name?: string;
    stopTimeSec: number;
    parameterOverrides: Record<string, DslLiteral>;
  }>;
  defaultExperimentId: string | null;
  inlineModel: boolean;
  parameters: Array<{
    id: string;
    name?: string;
    description: string;
    valueType: 'number' | 'integer' | 'string' | 'boolean';
    defaultValue: DslLiteral;
    min?: number;
    max?: number;
    step?: number;
    unit?: string;
  }>;
  processBlocks: Array<{
    id: string;
    kind: string;
    label?: string;
  }>;
  processConnections: Array<{
    from: string;
    to: string;
    probability?: number;
    condition?: unknown;
  }>;
};

type GenericRuntimeSnapshot = ProcessFlowSnapshot & {
  motionVerification?: MaterialMotionVerificationSnapshot;
};

export type GenericRuntimeSessionState = {
  sessionId: string;
  studyId: string;
  studyName: string;
  modelId: string;
  modelName: string;
  experimentId: string;
  status: 'starting' | 'running' | 'paused' | 'completed' | 'error';
  speed: number;
  startTimeSec: number;
  simTimeSec: number;
  stopTimeSec: number;
  parameterOverrides: Record<string, DslLiteral>;
  effectiveParameterValues: Record<string, DslLiteral>;
  motionVerificationOptions: Required<MaterialMotionVerificationOptions>;
  progress: number;
  createdAt: string;
  updatedAt: string;
  latestSnapshot: GenericRuntimeSnapshot | null;
  recentEvents: GenericDesRuntime['simulation']['eventLog'];
  diagnostics: ModelDiagnosticsReport;
  error: string | null;
};

export type GenericRuntimeEnvelope = {
  study: GenericStudyCatalogItem;
  session: GenericRuntimeSessionState | null;
};

export type GenericRuntimeEvent =
  | { type: 'generic-runtime-meta'; studyId: string; study: GenericStudyCatalogItem; session: GenericRuntimeSessionState | null }
  | { type: 'generic-runtime-state'; studyId: string; session: GenericRuntimeSessionState | null }
  | {
      type: 'generic-runtime-snapshot';
      studyId: string;
      sessionId: string;
      snapshot: GenericRuntimeSnapshot;
      status: GenericRuntimeSessionState['status'];
      speed: number;
      progress: number;
      recentEvents: GenericRuntimeSessionState['recentEvents'];
    };

type GenericRuntimeListener = (event: GenericRuntimeEvent) => void;

type GenericStudyBundle = {
  study: SimulationStudyCaseDefinition;
  model: AiNativeDesModelDefinition;
  diagnostics: ModelDiagnosticsReport;
};

const studyBundleCache = new Map<string, Promise<GenericStudyBundle>>();
const inlineStudyBundles = new Map<string, GenericStudyBundle>();
const runtimeControllers = new Map<string, GenericRuntimeController>();

function clampSpeed(speed: number | undefined, fallback = 8): number {
  const next = Number.isFinite(speed) ? Number(speed) : fallback;
  return Math.min(240, Math.max(0.25, next));
}

function normalizeMotionVerificationOptions(
  studyId: string,
  input?: MaterialMotionVerificationOptions
): Required<MaterialMotionVerificationOptions> {
  const defaultEnabled = studyId === 'micro-fulfillment-inline' || studyId === 'fulfillment-center-mvp';
  return {
    enabled: input?.enabled ?? defaultEnabled,
    tickSec: Number.isFinite(input?.tickSec) ? Math.max(0.05, Number(input?.tickSec)) : 0.2,
    clearanceM: Number.isFinite(input?.clearanceM) ? Math.max(0, Number(input?.clearanceM)) : 0.25,
    maxLagSec: Number.isFinite(input?.maxLagSec) ? Math.max(0, Number(input?.maxLagSec)) : 2
  };
}

function cloneSession(state: GenericRuntimeSessionState | null): GenericRuntimeSessionState | null {
  return state ? structuredClone(state) : null;
}

function safeStudyFileName(studyId: string): string {
  return studyId.replace(/[^a-zA-Z0-9_.-]/g, '-');
}

async function persistStudyToConfig(study: SimulationStudyCaseDefinition): Promise<string> {
  await mkdir(studiesDir, { recursive: true });
  const studyPath = path.join(studiesDir, `${safeStudyFileName(study.id)}.study.json`);
  await writeFile(studyPath, `${JSON.stringify(study, null, 2)}\n`, 'utf8');
  return studyPath;
}

function firstStudyExperimentId(study: SimulationStudyCaseDefinition, model: AiNativeDesModelDefinition): string | null {
  return (
    study.runs[0]?.experimentId ??
    study.replications[0]?.experimentId ??
    study.sweeps[0]?.experimentId ??
    model.experiments[0]?.id ??
    null
  );
}

function toCatalogItem(bundle: GenericStudyBundle): GenericStudyCatalogItem {
  return {
    id: bundle.study.id,
    name: bundle.study.name,
    description: bundle.study.description,
    modelId: bundle.model.id,
    modelName: bundle.model.name,
    experimentIds: bundle.model.experiments.map((experiment) => experiment.id),
    experiments: bundle.model.experiments.map((experiment) => ({
      id: experiment.id,
      name: experiment.name,
      stopTimeSec: experiment.stopTimeSec,
      parameterOverrides: { ...experiment.parameterOverrides }
    })),
    defaultExperimentId: firstStudyExperimentId(bundle.study, bundle.model),
    inlineModel: Boolean(bundle.study.model),
    parameters: bundle.model.parameters.map((parameter) => ({
      id: parameter.id,
      name: parameter.name,
      description: parameter.description,
      valueType: parameter.valueType,
      defaultValue: parameter.defaultValue,
      min: parameter.min,
      max: parameter.max,
      step: parameter.step,
      unit: parameter.unit
    })),
    processBlocks: bundle.model.process.blocks.map((block) => ({
      id: block.id,
      kind: block.kind,
      label: block.label
    })),
    processConnections: bundle.model.process.connections.map((connection) => ({
      from: connection.from,
      to: connection.to,
      probability: connection.probability,
      condition: connection.condition
    }))
  };
}

async function loadStudyBundleFromPath(studyPath: string): Promise<GenericStudyBundle> {
  const study = await loadSimulationStudyCase(studyPath);
  const model = study.model ?? await loadAiNativeDesModel(path.resolve(path.dirname(studyPath), study.modelPath!));
  return {
    study,
    model,
    diagnostics: analyzeDesModel(model)
  };
}

async function getStudyPathById(studyId: string): Promise<string> {
  const entries = await readdir(studiesDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !/\.json$/i.test(entry.name)) {
      continue;
    }

    const studyPath = path.join(studiesDir, entry.name);
    const study = await loadSimulationStudyCase(studyPath);
    if (study.id === studyId || path.basename(entry.name, '.json') === studyId) {
      return studyPath;
    }
  }

  throw new Error(`Unknown DES study: ${studyId}`);
}

async function getStudyBundle(studyId: string): Promise<GenericStudyBundle> {
  const inlineBundle = inlineStudyBundles.get(studyId);
  if (inlineBundle) {
    return inlineBundle;
  }

  if (!studyBundleCache.has(studyId)) {
    studyBundleCache.set(studyId, getStudyPathById(studyId).then(loadStudyBundleFromPath));
  }
  return studyBundleCache.get(studyId)!;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('DES case input must be a JSON object');
  }
  return value as Record<string, unknown>;
}

function normalizeInlineStudy(input: unknown): SimulationStudyCaseDefinition {
  const payload = asRecord(input);
  const candidate = 'study' in payload ? payload.study : payload;
  const object = asRecord(candidate);

  if (object.schemaVersion === 'des-platform.v1') {
    const parsedModel = AiNativeDesModelDefinitionSchema.parse(object);
    const model =
      parsedModel.experiments.length > 0
        ? parsedModel
        : {
            ...parsedModel,
            experiments: [
              {
                id: 'baseline',
                name: 'Baseline',
                stopTimeSec: 3600
              }
            ]
          };
    const experimentId = model.experiments[0]!.id;
    return SimulationStudyCaseDefinitionSchema.parse({
      schemaVersion: 'des-platform.study.v1',
      id: model.id,
      name: `${model.name} Study`,
      description: model.description,
      model,
      runs: [
        {
          experimentId,
          outputName: `${experimentId}-run`,
          htmlReport: true
        }
      ],
      metadata: {
        source: 'inline-workbench'
      }
    });
  }

  const study = SimulationStudyCaseDefinitionSchema.parse(object);
  if (!study.model) {
    throw new Error('Inline DES cases must embed model instead of using modelPath');
  }
  return study;
}

function normalizeParameterOverrides(
  model: AiNativeDesModelDefinition,
  input: unknown
): Record<string, DslLiteral> {
  if (input === undefined || input === null) {
    return {};
  }

  const rawOverrides = asRecord(input);
  const parametersById = new Map(model.parameters.map((parameter) => [parameter.id, parameter]));
  const overrides: Record<string, DslLiteral> = {};

  for (const [parameterId, rawValue] of Object.entries(rawOverrides)) {
    const parameter = parametersById.get(parameterId);
    if (!parameter) {
      throw new Error(`Unknown model parameter ${parameterId}`);
    }
    overrides[parameterId] = coerceParameterValue(parameter, rawValue);
  }

  return overrides;
}

function coerceParameterValue(
  parameter: AiNativeDesModelDefinition['parameters'][number],
  rawValue: unknown
): DslLiteral {
  let value: DslLiteral;

  switch (parameter.valueType) {
    case 'number':
      value = Number(rawValue);
      if (!Number.isFinite(value)) {
        throw new Error(`Parameter ${parameter.id} must be a finite number`);
      }
      break;
    case 'integer':
      value = Number(rawValue);
      if (!Number.isFinite(value) || !Number.isInteger(value)) {
        throw new Error(`Parameter ${parameter.id} must be an integer`);
      }
      break;
    case 'boolean':
      if (typeof rawValue === 'boolean') {
        value = rawValue;
      } else if (rawValue === 'true') {
        value = true;
      } else if (rawValue === 'false') {
        value = false;
      } else {
        throw new Error(`Parameter ${parameter.id} must be boolean`);
      }
      break;
    case 'string':
      value = String(rawValue);
      break;
    default:
      parameter.valueType satisfies never;
      throw new Error(`Unsupported parameter type for ${parameter.id}`);
  }

  if (typeof value === 'number') {
    if (parameter.min !== undefined && value < parameter.min) {
      throw new Error(`Parameter ${parameter.id} must be greater than or equal to ${parameter.min}`);
    }
    if (parameter.max !== undefined && value > parameter.max) {
      throw new Error(`Parameter ${parameter.id} must be less than or equal to ${parameter.max}`);
    }
  }

  return value;
}

function experimentWithParameterOverrides(
  experiment: ExperimentDefinition,
  parameterOverrides: Record<string, DslLiteral>
): ExperimentDefinition {
  if (Object.keys(parameterOverrides).length === 0) {
    return experiment;
  }

  return {
    ...experiment,
    parameterOverrides: {
      ...experiment.parameterOverrides,
      ...parameterOverrides
    }
  };
}

function effectiveParameterValues(
  model: AiNativeDesModelDefinition,
  experiment: ExperimentDefinition
): Record<string, DslLiteral> {
  return Object.fromEntries(
    model.parameters.map((parameter) => [
      parameter.id,
      experiment.parameterOverrides[parameter.id] ?? parameter.defaultValue
    ])
  );
}

function modelWithRuntimeExperiment(
  model: AiNativeDesModelDefinition,
  experiment: ExperimentDefinition
): AiNativeDesModelDefinition {
  return {
    ...model,
    experiments: model.experiments.map((candidate) => candidate.id === experiment.id ? experiment : candidate)
  };
}

function resolveExperiment(
  bundle: GenericStudyBundle,
  experimentId?: string
): ExperimentDefinition {
  const selectedExperimentId = experimentId ?? firstStudyExperimentId(bundle.study, bundle.model);
  if (!selectedExperimentId) {
    throw new Error(`Study ${bundle.study.id} does not define a runnable experiment`);
  }

  const experiment = bundle.model.experiments.find((candidate) => candidate.id === selectedExperimentId);
  if (!experiment) {
    throw new Error(`Model ${bundle.model.id} does not define experiment ${selectedExperimentId}`);
  }
  return experiment;
}

class GenericRuntimeSession {
  private readonly runtime: GenericDesRuntime;
  private readonly createdAt = new Date().toISOString();
  private state: GenericRuntimeSessionState;
  private timer: NodeJS.Timeout | null = null;
  private lastWallClockMs = 0;
  private tickInFlight = false;
  private closed = false;

  constructor(
    private readonly bundle: GenericStudyBundle,
    experiment: ExperimentDefinition,
    speed: number,
    startTimeSec: number,
    motionVerificationOptions: Required<MaterialMotionVerificationOptions>,
    private readonly emitEvent: (event: GenericRuntimeEvent) => void
  ) {
    this.runtime = compileDesModel(modelWithRuntimeExperiment(bundle.model, experiment)).createRuntimeForExperiment(experiment.id);
    this.state = {
      sessionId: `${bundle.study.id}-${Date.now()}`,
      studyId: bundle.study.id,
      studyName: bundle.study.name,
      modelId: this.runtime.model.id,
      modelName: this.runtime.model.name,
      experimentId: experiment.id,
      status: 'starting',
      speed,
      startTimeSec,
      simTimeSec: 0,
      stopTimeSec: experiment.stopTimeSec,
      parameterOverrides: { ...experiment.parameterOverrides },
      effectiveParameterValues: effectiveParameterValues(bundle.model, experiment),
      motionVerificationOptions,
      progress: 0,
      createdAt: this.createdAt,
      updatedAt: this.createdAt,
      latestSnapshot: null,
      recentEvents: [],
      diagnostics: bundle.diagnostics,
      error: null
    };
    this.state.latestSnapshot = this.snapshotAt(0);
  }

  getState(): GenericRuntimeSessionState {
    return cloneSession(this.state)!;
  }

  start(): GenericRuntimeSessionState {
    try {
      this.state.status = 'paused';
      if (this.state.startTimeSec > 0) {
        this.advanceTo(this.state.startTimeSec, false);
      } else {
        this.emitSnapshot(this.snapshotAt(this.runtime.simulation.nowSec));
      }
      return this.resume();
    } catch (error) {
      this.fail(error);
      return this.getState();
    }
  }

  pause(): GenericRuntimeSessionState {
    if (this.state.status !== 'running') {
      return this.getState();
    }
    this.clearTimer();
    this.state.status = 'paused';
    this.emitState();
    return this.getState();
  }

  resume(): GenericRuntimeSessionState {
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

  setSpeed(speed: number): GenericRuntimeSessionState {
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
      if (elapsedWallSec > 0) {
        this.advanceTo(this.runtime.simulation.nowSec + elapsedWallSec * this.state.speed, true);
      }
    } catch (error) {
      this.fail(error);
    } finally {
      this.tickInFlight = false;
    }
  }

  private advanceTo(targetSimTimeSec: number, emitSnapshot: boolean): void {
    const cappedTargetSec = Math.min(this.state.stopTimeSec, Math.max(0, targetSimTimeSec));
    const result = this.runtime.simulation.run({
      untilSec: cappedTargetSec,
      maxEvents: this.runtime.experiment.maxEvents
    });
    const snapshot = this.snapshotAt(this.runtime.simulation.nowSec);
    this.state.latestSnapshot = snapshot;
    this.state.recentEvents = this.runtime.simulation.eventLog.slice(-80);
    this.state.simTimeSec = snapshot.nowSec;
    this.state.progress = this.state.stopTimeSec <= 0 ? 1 : Math.min(1, snapshot.nowSec / this.state.stopTimeSec);
    this.touch();

    if (emitSnapshot) {
      this.emitSnapshot(snapshot);
    }

    if (result.stoppedBy === 'empty' || snapshot.nowSec >= this.state.stopTimeSec - 1e-9) {
      this.clearTimer();
      this.state.status = 'completed';
      this.state.progress = 1;
      this.emitState();
    }
  }

  private fail(error: unknown): void {
    this.clearTimer();
    this.state.status = 'error';
    this.state.error = error instanceof Error ? error.message : 'Unknown generic runtime failure';
    this.emitState();
  }

  private emitState(): void {
    this.touch();
    this.emitEvent({
      type: 'generic-runtime-state',
      studyId: this.bundle.study.id,
      session: this.getState()
    });
  }

  private emitSnapshot(snapshot: GenericRuntimeSnapshot): void {
    this.emitEvent({
      type: 'generic-runtime-snapshot',
      studyId: this.bundle.study.id,
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

  private snapshotAt(nowSec: number): GenericRuntimeSnapshot {
    const snapshot = this.runtime.runtime.getSnapshot(nowSec) as GenericRuntimeSnapshot;
    snapshot.motionVerification = verifyMaterialHandlingMotion({
      model: this.runtime.model,
      snapshot: snapshot.materialHandling,
      activeTransports: snapshot.activeTransports,
      nowSec,
      options: this.state?.motionVerificationOptions
    });
    return snapshot;
  }

  private clearTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

class GenericRuntimeController {
  private session: GenericRuntimeSession | null = null;
  private readonly listeners = new Set<GenericRuntimeListener>();

  constructor(private readonly studyId: string) {}

  async getEnvelope(): Promise<GenericRuntimeEnvelope> {
    const bundle = await getStudyBundle(this.studyId);
    return {
      study: toCatalogItem(bundle),
      session: this.session?.getState() ?? null
    };
  }

  subscribe(listener: GenericRuntimeListener): () => void {
    this.listeners.add(listener);
    void this.getEnvelope().then((envelope) => {
      listener({
        type: 'generic-runtime-meta',
        studyId: envelope.study.id,
        study: envelope.study,
        session: envelope.session
      });
    });

    return () => {
      this.listeners.delete(listener);
    };
  }

  async start(
    speed?: number,
    startTimeSec?: number,
    experimentId?: string,
    parameterOverrides?: unknown,
    motionVerification?: MaterialMotionVerificationOptions
  ): Promise<GenericRuntimeEnvelope> {
    const bundle = await getStudyBundle(this.studyId);
    if (!bundle.diagnostics.valid && bundle.study.failOnValidationError) {
      throw new Error(`Study ${bundle.study.id} cannot start because model diagnostics contain errors`);
    }

    const experiment = experimentWithParameterOverrides(
      resolveExperiment(bundle, experimentId),
      normalizeParameterOverrides(bundle.model, parameterOverrides)
    );
    const runtimeSpeed = clampSpeed(speed);
    const runtimeStartSec = Math.min(experiment.stopTimeSec, Math.max(0, Number.isFinite(startTimeSec) ? Number(startTimeSec) : 0));

    this.session?.close();
    const session = new GenericRuntimeSession(
      bundle,
      experiment,
      runtimeSpeed,
      runtimeStartSec,
      normalizeMotionVerificationOptions(bundle.study.id, motionVerification),
      (event) => this.broadcast(event)
    );
    this.session = session;

    this.broadcast({
      type: 'generic-runtime-meta',
      studyId: bundle.study.id,
      study: toCatalogItem(bundle),
      session: session.getState()
    });
    session.start();

    return {
      study: toCatalogItem(bundle),
      session: session.getState()
    };
  }

  async pause(): Promise<GenericRuntimeEnvelope> {
    const bundle = await getStudyBundle(this.studyId);
    return {
      study: toCatalogItem(bundle),
      session: this.session?.pause() ?? null
    };
  }

  async resume(): Promise<GenericRuntimeEnvelope> {
    if (!this.session) {
      return this.start();
    }
    const bundle = await getStudyBundle(this.studyId);
    return {
      study: toCatalogItem(bundle),
      session: this.session.resume()
    };
  }

  async restart(
    speed?: number,
    startTimeSec?: number,
    experimentId?: string,
    parameterOverrides?: unknown,
    motionVerification?: MaterialMotionVerificationOptions
  ): Promise<GenericRuntimeEnvelope> {
    return this.start(speed, startTimeSec, experimentId, parameterOverrides, motionVerification);
  }

  async setSpeed(speed: number): Promise<GenericRuntimeEnvelope> {
    if (!this.session) {
      return this.start(speed);
    }
    const bundle = await getStudyBundle(this.studyId);
    return {
      study: toCatalogItem(bundle),
      session: this.session.setSpeed(speed)
    };
  }

  reset(bundle: GenericStudyBundle): void {
    this.session?.close();
    this.session = null;
    this.broadcast({
      type: 'generic-runtime-meta',
      studyId: bundle.study.id,
      study: toCatalogItem(bundle),
      session: null
    });
  }

  private broadcast(event: GenericRuntimeEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

function getGenericRuntimeController(studyId: string): GenericRuntimeController {
  let controller = runtimeControllers.get(studyId);
  if (!controller) {
    controller = new GenericRuntimeController(studyId);
    runtimeControllers.set(studyId, controller);
  }
  return controller;
}

export async function getGenericStudyCatalog(): Promise<GenericStudyCatalogItem[]> {
  const entries = await readdir(studiesDir, { withFileTypes: true });
  const bundles = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && /\.json$/i.test(entry.name))
      .map((entry) => loadStudyBundleFromPath(path.join(studiesDir, entry.name)))
  );
  const byId = new Map<string, GenericStudyBundle>();
  for (const bundle of bundles) {
    byId.set(bundle.study.id, bundle);
  }
  for (const bundle of inlineStudyBundles.values()) {
    byId.set(bundle.study.id, bundle);
  }
  return [...byId.values()].map(toCatalogItem).sort((left, right) => left.name.localeCompare(right.name));
}

export async function registerGenericInlineStudy(
  input: unknown,
  options: { persist?: boolean } = {}
): Promise<GenericRuntimeEnvelope & { viewerUrl: string; persisted: boolean; studyPath: string | null }> {
  const study = normalizeInlineStudy(input);
  const model = study.model!;
  const bundle: GenericStudyBundle = {
    study,
    model,
    diagnostics: analyzeDesModel(model)
  };

  inlineStudyBundles.set(study.id, bundle);
  studyBundleCache.delete(study.id);
  getGenericRuntimeController(study.id).reset(bundle);
  const studyPath = options.persist ? await persistStudyToConfig(study) : null;

  return {
    study: toCatalogItem(bundle),
    session: null,
    viewerUrl: `/api/des-runtime/${encodeURIComponent(study.id)}/viewer`,
    persisted: Boolean(studyPath),
    studyPath
  };
}

export function subscribeGenericRuntime(studyId: string, listener: GenericRuntimeListener): () => void {
  return getGenericRuntimeController(studyId).subscribe(listener);
}

export async function getGenericRuntimeState(studyId: string): Promise<GenericRuntimeEnvelope> {
  return getGenericRuntimeController(studyId).getEnvelope();
}

export async function startGenericRuntime(
  studyId: string,
  speed?: number,
  startTimeSec?: number,
  experimentId?: string,
  parameterOverrides?: unknown,
  motionVerification?: MaterialMotionVerificationOptions
): Promise<GenericRuntimeEnvelope> {
  return getGenericRuntimeController(studyId).start(speed, startTimeSec, experimentId, parameterOverrides, motionVerification);
}

export async function pauseGenericRuntime(studyId: string): Promise<GenericRuntimeEnvelope> {
  return getGenericRuntimeController(studyId).pause();
}

export async function resumeGenericRuntime(studyId: string): Promise<GenericRuntimeEnvelope> {
  return getGenericRuntimeController(studyId).resume();
}

export async function restartGenericRuntime(
  studyId: string,
  speed?: number,
  startTimeSec?: number,
  experimentId?: string,
  parameterOverrides?: unknown,
  motionVerification?: MaterialMotionVerificationOptions
): Promise<GenericRuntimeEnvelope> {
  return getGenericRuntimeController(studyId).restart(speed, startTimeSec, experimentId, parameterOverrides, motionVerification);
}

export async function updateGenericRuntimeSpeed(studyId: string, speed: number): Promise<GenericRuntimeEnvelope> {
  return getGenericRuntimeController(studyId).setSpeed(speed);
}

const defaultWorkbenchCase = {
  schemaVersion: 'des-platform.study.v1',
  id: 'workbench-micro-flow',
  name: 'Workbench Micro Flow',
  description: 'Small inline DES case for live runtime validation.',
  model: {
    schemaVersion: 'des-platform.v1',
    id: 'workbench-micro-flow',
    name: 'Workbench Micro Flow',
    process: {
      id: 'workbench-flow',
      resourcePools: [
        {
          id: 'picker',
          name: 'Picker',
          capacity: 1
        }
      ],
      blocks: [
        {
          id: 'source',
          kind: 'source',
          entityType: 'order',
          startAtSec: 0,
          intervalSec: 45,
          maxArrivals: 12
        },
        {
          id: 'move-to-rack',
          kind: 'moveByTransporter',
          fleetId: 'amr',
          fromNodeId: 'dock',
          toNodeId: 'rack',
          loadTimeSec: 3,
          unloadTimeSec: 2
        },
        {
          id: 'pick',
          kind: 'service',
          resourcePoolId: 'picker',
          durationSec: {
            kind: 'triangular',
            min: 25,
            mode: 40,
            max: 70
          }
        },
        {
          id: 'move-to-pack',
          kind: 'moveByTransporter',
          fleetId: 'amr',
          fromNodeId: 'rack',
          toNodeId: 'pack',
          loadTimeSec: 2,
          unloadTimeSec: 2
        },
        {
          id: 'sink',
          kind: 'sink'
        }
      ],
      connections: [
        {
          from: 'source',
          to: 'move-to-rack'
        },
        {
          from: 'move-to-rack',
          to: 'pick'
        },
        {
          from: 'pick',
          to: 'move-to-pack'
        },
        {
          from: 'move-to-pack',
          to: 'sink'
        }
      ]
    },
    materialHandling: {
      id: 'workbench-layout',
      nodes: [
        {
          id: 'dock',
          type: 'dock',
          x: 0,
          z: 0
        },
        {
          id: 'rack',
          type: 'storage',
          x: 12,
          z: 0
        },
        {
          id: 'pack',
          type: 'station',
          x: 12,
          z: 8
        }
      ],
      paths: [
        {
          id: 'dock-rack',
          from: 'dock',
          to: 'rack',
          lengthM: 12,
          capacity: 1
        },
        {
          id: 'rack-pack',
          from: 'rack',
          to: 'pack',
          lengthM: 8,
          capacity: 1
        }
      ],
      transporterFleets: [
        {
          id: 'amr',
          vehicleType: 'amr',
          navigation: 'path-guided',
          count: 1,
          homeNodeId: 'dock',
          speedMps: 1.2,
          accelerationMps2: 0.7,
          decelerationMps2: 0.7
        }
      ]
    },
    experiments: [
      {
        id: 'baseline',
        name: 'Baseline',
        seed: 20260425,
        stopTimeSec: 900
      }
    ]
  },
  runs: [
    {
      experimentId: 'baseline',
      outputName: 'baseline-run',
      htmlReport: true
    }
  ],
  metadata: {
    source: 'workbench-template'
  }
};

export function renderGenericWorkbench(): string {
  const encodedDefaultCase = JSON.stringify(JSON.stringify(defaultWorkbenchCase, null, 2));
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>DES Workbench</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f6f8fb;
        --panel: #ffffff;
        --line: #d8e0ea;
        --ink: #17212b;
        --muted: #64748b;
        --accent: #2d6cdf;
        --danger: #a23b3b;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        background: var(--bg);
        color: var(--ink);
        font-family: Inter, "Avenir Next", "Segoe UI", sans-serif;
      }
      main {
        max-width: 1280px;
        margin: 0 auto;
        padding: 18px;
      }
      header, section {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 14px;
        margin-bottom: 12px;
      }
      h1, h2, p { margin: 0; }
      h1 { font-size: 22px; line-height: 1.15; }
      h2 { font-size: 15px; margin-bottom: 10px; }
      p { color: var(--muted); }
      .toolbar {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: center;
        margin-top: 12px;
      }
      .persist-option {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        color: var(--muted);
        min-height: 34px;
      }
      button, select {
        min-height: 34px;
        border: 1px solid var(--line);
        border-radius: 6px;
        background: #fff;
        color: var(--ink);
        font: inherit;
        padding: 6px 10px;
      }
      button.primary {
        background: var(--accent);
        border-color: var(--accent);
        color: #fff;
      }
      button:disabled {
        opacity: 0.45;
      }
      .workbench {
        display: grid;
        grid-template-columns: minmax(0, 1.4fr) minmax(300px, 0.6fr);
        gap: 12px;
      }
      .builder {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(260px, 0.45fr);
        gap: 12px;
      }
      .brief-text {
        min-height: 130px;
        font: 13px/1.45 Inter, "Avenir Next", "Segoe UI", sans-serif;
      }
      .tabs {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin-bottom: 8px;
      }
      .tabs button.active {
        background: var(--ink);
        color: #fff;
        border-color: var(--ink);
      }
      .diagnostic-list {
        display: grid;
        gap: 7px;
      }
      .diagnostic {
        border: 1px solid var(--line);
        border-radius: 6px;
        padding: 8px;
        background: #fff;
      }
      .diagnostic strong {
        display: block;
        font-size: 12px;
      }
      .diagnostic button {
        min-height: 26px;
        margin-top: 6px;
        font-size: 12px;
        padding: 3px 7px;
      }
      textarea {
        width: 100%;
        min-height: 660px;
        resize: vertical;
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 12px;
        font: 12px/1.45 "SFMono-Regular", Consolas, monospace;
        color: var(--ink);
      }
      pre {
        min-height: 180px;
        max-height: 420px;
        overflow: auto;
        margin: 0;
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 12px;
        background: #f8fafc;
        font: 12px/1.45 "SFMono-Regular", Consolas, monospace;
        white-space: pre-wrap;
      }
      pre.error {
        color: var(--danger);
        border-color: #e1a7a7;
        background: #fff7f7;
      }
      @media (max-width: 920px) {
        .builder { grid-template-columns: 1fr; }
        .workbench { grid-template-columns: 1fr; }
        textarea { min-height: 520px; }
      }
    </style>
  </head>
  <body>
    <main>
      <header>
        <h1>DES Workbench</h1>
        <div class="toolbar">
          <select id="study"></select>
          <button id="openSelected">Open Runtime</button>
        </div>
      </header>
      <section>
        <h2>Case Builder</h2>
        <div class="builder">
          <div>
            <textarea id="briefText" class="brief-text" spellcheck="false">Warehouse order picking: orders arrive every minute, an AMR moves totes from dock to rack, a picker works at the rack, then the AMR moves totes to packing. Run for 30 minutes.</textarea>
            <div class="toolbar">
              <button class="primary" id="draft">Draft From Brief</button>
              <button id="diagnose">Diagnose</button>
              <button id="repair">Repair Draft</button>
            </div>
          </div>
          <div>
            <div class="tabs">
              <button class="active" data-tab="summary">Summary</button>
              <button data-tab="process">Process</button>
              <button data-tab="layout">Layout</button>
              <button data-tab="experiments">Experiments</button>
              <button data-tab="diagnostics">Diagnostics</button>
            </div>
            <pre id="tabView">No draft loaded.</pre>
          </div>
        </div>
      </section>
      <div class="workbench">
        <section>
          <h2>Case JSON</h2>
          <textarea id="caseText" spellcheck="false"></textarea>
          <div class="toolbar">
            <button class="primary" id="register">Register Case</button>
            <button id="openRuntime" disabled>Open Registered Runtime</button>
            <label class="persist-option"><input id="persist" type="checkbox" /> Save</label>
          </div>
        </section>
        <section>
          <h2>Result</h2>
          <pre id="result">Idle</pre>
        </section>
      </div>
    </main>
    <script>
      const initialCase = ${encodedDefaultCase};
      const $ = (id) => document.getElementById(id);
      let lastViewerUrl = null;
      let lastDiagnostics = [];
      let activeTab = 'summary';

      function viewerUrlFor(studyId) {
        return '/api/des-runtime/' + encodeURIComponent(studyId) + '/viewer';
      }

      function setResult(value, error = false) {
        const result = $('result');
        result.className = error ? 'error' : '';
        result.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
      }

      function currentCase() {
        return JSON.parse($('caseText').value);
      }

      function setCase(study) {
        $('caseText').value = JSON.stringify(study, null, 2);
      }

      function tabPayload(study) {
        const model = study?.model ?? {};
        if (activeTab === 'process') {
          return {
            resourcePools: model.process?.resourcePools ?? [],
            blocks: model.process?.blocks ?? [],
            connections: model.process?.connections ?? []
          };
        }
        if (activeTab === 'layout') {
          return model.materialHandling ?? null;
        }
        if (activeTab === 'experiments') {
          return {
            parameters: model.parameters ?? [],
            experiments: model.experiments ?? [],
            runs: study?.runs ?? []
          };
        }
        if (activeTab === 'diagnostics') {
          return lastDiagnostics;
        }
        return {
          id: study?.id,
          name: study?.name,
          model: model.name,
          blocks: model.process?.blocks?.length ?? 0,
          nodes: model.materialHandling?.nodes?.length ?? 0,
          fleets: model.materialHandling?.transporterFleets?.length ?? 0,
          experiments: model.experiments?.map((experiment) => experiment.id) ?? []
        };
      }

      function renderTabs() {
        document.querySelectorAll('[data-tab]').forEach((button) => {
          button.classList.toggle('active', button.dataset.tab === activeTab);
        });
        try {
          const study = currentCase();
          if (activeTab === 'diagnostics') {
            const box = $('tabView');
            box.innerHTML = '';
            const list = document.createElement('div');
            list.className = 'diagnostic-list';
            if (lastDiagnostics.length === 0) {
              list.textContent = 'No diagnostics.';
            }
            for (const diagnostic of lastDiagnostics) {
              const item = document.createElement('div');
              item.className = 'diagnostic';
              const title = document.createElement('strong');
              title.textContent = diagnostic.severity + ' / ' + diagnostic.code;
              const body = document.createElement('small');
              body.textContent = diagnostic.path + ' - ' + diagnostic.message;
              const jump = document.createElement('button');
              jump.textContent = 'Locate';
              jump.addEventListener('click', () => locatePath(diagnostic.path));
              item.appendChild(title);
              item.appendChild(body);
              item.appendChild(jump);
              list.appendChild(item);
            }
            box.appendChild(list);
            return;
          }
          $('tabView').textContent = JSON.stringify(tabPayload(study), null, 2);
        } catch (error) {
          $('tabView').textContent = error instanceof Error ? error.message : String(error);
        }
      }

      function locatePath(path) {
        const text = $('caseText');
        const key = String(path).split('.').filter((part) => part && part !== '$').at(-1);
        if (!key) {
          text.focus();
          return;
        }
        const index = text.value.indexOf('"' + key + '"');
        text.focus();
        if (index >= 0) text.setSelectionRange(index, index + key.length + 2);
      }

      async function postJson(url, body) {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.error || JSON.stringify(data));
        }
        return data;
      }

      async function loadStudies() {
        const response = await fetch('/api/des-studies');
        const studies = await response.json();
        const select = $('study');
        const selected = select.value;
        select.innerHTML = '';
        for (const study of studies) {
          const option = document.createElement('option');
          option.value = study.id;
          option.textContent = study.name + ' (' + study.id + ')';
          select.appendChild(option);
        }
        if (selected) select.value = selected;
      }

      $('caseText').value = initialCase;
      renderTabs();
      document.querySelectorAll('[data-tab]').forEach((button) => {
        button.addEventListener('click', () => {
          activeTab = button.dataset.tab;
          renderTabs();
        });
      });
      $('draft').addEventListener('click', async () => {
        try {
          const data = await postJson('/api/des-author/draft', { brief: $('briefText').value, provider: 'auto' });
          if (data.study) setCase(data.study);
          lastDiagnostics = data.diagnostics ?? [];
          activeTab = data.valid ? 'summary' : 'diagnostics';
          renderTabs();
          setResult({ provider: data.provider, valid: data.valid, notes: data.notes, diagnostics: lastDiagnostics.length });
        } catch (error) {
          setResult(error instanceof Error ? error.message : String(error), true);
        }
      });
      $('diagnose').addEventListener('click', async () => {
        try {
          const data = await postJson('/api/des-author/diagnose', { study: currentCase() });
          lastDiagnostics = data.diagnostics ?? [];
          activeTab = 'diagnostics';
          renderTabs();
          setResult({ valid: data.valid, schemaValid: data.schemaValid, modelValid: data.modelValid, diagnostics: lastDiagnostics.length });
        } catch (error) {
          setResult(error instanceof Error ? error.message : String(error), true);
        }
      });
      $('repair').addEventListener('click', async () => {
        try {
          const data = await postJson('/api/des-author/repair', { study: currentCase(), brief: $('briefText').value });
          if (data.study) setCase(data.study);
          lastDiagnostics = data.diagnostics ?? [];
          activeTab = data.valid ? 'summary' : 'diagnostics';
          renderTabs();
          setResult({ repaired: data.repaired, valid: data.valid, notes: data.notes, diagnostics: lastDiagnostics.length });
        } catch (error) {
          setResult(error instanceof Error ? error.message : String(error), true);
        }
      });
      $('openSelected').addEventListener('click', () => {
        if ($('study').value) location.href = viewerUrlFor($('study').value);
      });
      $('register').addEventListener('click', async () => {
        try {
          const input = JSON.parse($('caseText').value);
          const response = await fetch('/api/des-studies/inline', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ study: input, persist: $('persist').checked })
          });
          const data = await response.json();
          if (!response.ok) {
            throw new Error(data.error || JSON.stringify(data));
          }
          lastViewerUrl = data.viewerUrl;
          $('openRuntime').disabled = false;
          setResult({
            registered: data.study.id,
            model: data.study.modelName,
            experiments: data.study.experimentIds,
            viewerUrl: data.viewerUrl,
            persisted: data.persisted,
            studyPath: data.studyPath
          });
          await loadStudies();
          $('study').value = data.study.id;
        } catch (error) {
          setResult(error instanceof Error ? error.message : String(error), true);
        }
      });
      $('openRuntime').addEventListener('click', () => {
        if (lastViewerUrl) location.href = lastViewerUrl;
      });

      loadStudies().catch((error) => setResult(error instanceof Error ? error.message : String(error), true));
    </script>
  </body>
</html>`;
}

export function renderGenericRuntimeViewer(studyId: string): string {
  const encodedStudyId = JSON.stringify(studyId);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>DES Runtime</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f6f8fb;
        --panel: #ffffff;
        --line: #d8e0ea;
        --ink: #17212b;
        --muted: #64748b;
        --accent: #2d6cdf;
        --move: #d77a2d;
        --load: #2f7d62;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: Inter, "Avenir Next", "Segoe UI", sans-serif;
        background: var(--bg);
        color: var(--ink);
      }
      main {
        max-width: 1280px;
        margin: 0 auto;
        padding: 18px;
      }
      header, section {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 14px;
        margin-bottom: 12px;
      }
      h1, h2, p { margin: 0; }
      h1 { font-size: 22px; line-height: 1.15; }
      h2 { font-size: 15px; margin-bottom: 10px; }
      p, small { color: var(--muted); }
      .toolbar {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px;
        margin-top: 12px;
      }
      .parameter-panel {
        display: none;
        margin-top: 12px;
        border-top: 1px solid var(--line);
        padding-top: 12px;
      }
      .parameter-grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 10px;
      }
      .parameter-control {
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 9px;
      }
      .parameter-control label {
        display: flex;
        justify-content: space-between;
        gap: 8px;
        color: var(--muted);
        font-size: 12px;
      }
      .parameter-inputs {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-top: 7px;
      }
      .parameter-inputs input[type="range"] {
        flex: 1;
        min-width: 0;
      }
      .parameter-inputs input[type="number"],
      .parameter-inputs input[type="text"],
      .parameter-inputs select {
        width: 112px;
      }
      button, select, input {
        border: 1px solid var(--line);
        border-radius: 6px;
        background: #fff;
        color: var(--ink);
        font: inherit;
        min-height: 34px;
        padding: 6px 10px;
      }
      button.primary {
        background: var(--accent);
        color: #fff;
        border-color: var(--accent);
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 12px;
      }
      .events-panel {
        margin-top: 12px;
      }
      .verification-panel {
        margin-top: 12px;
      }
      .verification-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 12px;
      }
      .state-card {
        border: 1px solid var(--line);
        border-radius: 8px;
        overflow: hidden;
        background: #fff;
      }
      .state-card h3 {
        margin: 0;
        padding: 10px 12px;
        border-bottom: 1px solid var(--line);
        font-size: 13px;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        table-layout: fixed;
        font-size: 12px;
      }
      th, td {
        padding: 7px 8px;
        border-bottom: 1px solid #edf1f6;
        text-align: left;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      th {
        color: var(--muted);
        font-weight: 700;
        text-transform: uppercase;
        font-size: 10px;
        letter-spacing: 0;
      }
      tr:last-child td {
        border-bottom: 0;
      }
      .empty-cell {
        color: var(--muted);
      }
      .kpis {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 8px;
        margin-top: 12px;
      }
      .kpis div {
        border: 1px solid var(--line);
        border-radius: 6px;
        padding: 10px;
      }
      .kpis span {
        display: block;
        color: var(--muted);
        font-size: 12px;
        text-transform: uppercase;
      }
      .kpis strong {
        display: block;
        margin-top: 6px;
        font-size: 18px;
      }
      svg {
        width: 100%;
        min-height: 460px;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: #101820;
      }
      #logic {
        background: #ffffff;
      }
      .event-list {
        display: grid;
        gap: 6px;
        max-height: 260px;
        overflow: auto;
        font-size: 13px;
      }
      .event {
        border-bottom: 1px solid var(--line);
        padding-bottom: 6px;
      }
      .legend {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin-top: 8px;
        color: var(--muted);
        font-size: 12px;
      }
      .legend span {
        display: inline-flex;
        align-items: center;
        gap: 5px;
      }
      .swatch {
        width: 12px;
        height: 12px;
        border-radius: 3px;
        display: inline-block;
      }
      code { font-family: "SFMono-Regular", Consolas, monospace; }
      @media (max-width: 900px) {
        .grid { grid-template-columns: 1fr; }
        .verification-grid { grid-template-columns: 1fr; }
        .parameter-grid { grid-template-columns: 1fr; }
        .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      }
    </style>
  </head>
  <body>
    <main>
      <header>
        <h1 id="title">DES Runtime</h1>
        <p id="subtitle">The simulation kernel is running on the server; this page subscribes to live snapshots.</p>
        <div class="toolbar">
          <select id="experiment"></select>
          <button class="primary" id="start">Start</button>
          <button id="pause">Pause</button>
          <button id="resume">Resume</button>
          <button id="restart">Restart</button>
          <label>Speed <input id="speed" type="number" min="0.25" max="240" step="0.25" value="8" /></label>
          <label><input id="motionEnabled" type="checkbox" checked /> Motion verify</label>
        </div>
        <div id="parameterPanel" class="parameter-panel">
          <h2>Parameters</h2>
          <div id="parameters" class="parameter-grid"></div>
        </div>
        <div class="kpis">
          <div><span>Status</span><strong id="status">idle</strong></div>
          <div><span>Sim Time</span><strong id="time">0.0s</strong></div>
          <div><span>Created</span><strong id="created">0</strong></div>
          <div><span>Completed</span><strong id="completed">0</strong></div>
        </div>
      </header>
      <div class="grid">
        <section>
          <h2>Live Material Layout</h2>
          <svg id="layout" viewBox="0 0 960 520" role="img" aria-label="Live DES layout"></svg>
        </section>
        <section>
          <h2>Process Logic</h2>
          <svg id="logic" viewBox="0 0 960 520" role="img" aria-label="Process logic diagram"></svg>
          <div class="legend">
            <span><i class="swatch" style="background:#2d6cdf"></i>active block</span>
            <span><i class="swatch" style="background:#d77a2d"></i>material move</span>
            <span><i class="swatch" style="background:#2f7d62"></i>resource/service</span>
          </div>
        </section>
      </div>
      <section class="verification-panel">
        <h2>Live Verification</h2>
        <div class="verification-grid">
          <article class="state-card">
            <h3>Resources</h3>
            <table id="resources"></table>
          </article>
          <article class="state-card">
            <h3>Active Transports</h3>
            <table id="transports"></table>
          </article>
          <article class="state-card">
            <h3>Transport Queues</h3>
            <table id="transportQueues"></table>
          </article>
          <article class="state-card">
            <h3>Transporter Units</h3>
            <table id="units"></table>
          </article>
          <article class="state-card">
            <h3>Active Entities</h3>
            <table id="entities"></table>
          </article>
          <article class="state-card">
            <h3>Motion Verification</h3>
            <table id="motion"></table>
          </article>
          <article class="state-card">
            <h3>Motion Warnings</h3>
            <table id="motionWarnings"></table>
          </article>
        </div>
      </section>
      <section class="verification-panel">
        <h2>Statistics</h2>
        <div class="verification-grid">
          <article class="state-card">
            <h3>Run KPIs</h3>
            <table id="stats"></table>
          </article>
          <article class="state-card">
            <h3>Effective Parameters</h3>
            <table id="effectiveParams"></table>
          </article>
        </div>
      </section>
      <section class="events-panel">
        <h2>Recent Runtime Events</h2>
        <div id="events" class="event-list"></div>
      </section>
    </main>
    <script>
      const studyId = ${encodedStudyId};
      let study = null;
      let session = null;
      let snapshot = null;
      let recentEvents = [];
      let socket = null;

      const $ = (id) => document.getElementById(id);
      const api = (suffix) => '/api/des-runtime/' + encodeURIComponent(studyId) + suffix;

      function fmt(value) {
        return Number.isFinite(value) ? value.toFixed(1) + 's' : '0.0s';
      }

      async function post(suffix, body = {}) {
        const response = await fetch(api(suffix), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        if (!response.ok) throw new Error(await response.text());
        return response.json();
      }

      async function refreshMeta() {
        const response = await fetch(api(''));
        const envelope = await response.json();
        applyMeta(envelope.study, envelope.session);
      }

      function applyMeta(nextStudy, nextSession) {
        study = nextStudy;
        session = nextSession;
        $('title').textContent = study.name;
        $('subtitle').textContent = study.description || study.modelName;
        const select = $('experiment');
        select.innerHTML = '';
        for (const experiment of study.experiments ?? []) {
          const option = document.createElement('option');
          option.value = experiment.id;
          option.textContent = experiment.name ? experiment.name + ' (' + experiment.id + ')' : experiment.id;
          option.selected = experiment.id === (session?.experimentId ?? study.defaultExperimentId);
          select.appendChild(option);
        }
        renderParameterControls();
        if (session?.latestSnapshot) snapshot = session.latestSnapshot;
        if (session?.recentEvents) recentEvents = session.recentEvents;
        render();
      }

      function selectedExperiment() {
        return (study?.experiments ?? []).find((experiment) => experiment.id === $('experiment').value) ?? null;
      }

      function parameterDisplayName(parameter) {
        return parameter.name || parameter.id;
      }

      function parameterValue(parameter) {
        const experiment = selectedExperiment();
        const sessionValue = session?.experimentId === experiment?.id ? session?.parameterOverrides?.[parameter.id] : undefined;
        if (sessionValue !== undefined) return sessionValue;
        if (experiment?.parameterOverrides?.[parameter.id] !== undefined) return experiment.parameterOverrides[parameter.id];
        return parameter.defaultValue;
      }

      function renderParameterControls() {
        const panel = $('parameterPanel');
        const box = $('parameters');
        const parameters = study?.parameters ?? [];
        box.innerHTML = '';
        panel.style.display = parameters.length === 0 ? 'none' : 'block';
        for (const parameter of parameters) {
          const value = parameterValue(parameter);
          const wrapper = document.createElement('div');
          wrapper.className = 'parameter-control';

          const label = document.createElement('label');
          const name = document.createElement('span');
          name.textContent = parameterDisplayName(parameter);
          const unit = document.createElement('span');
          unit.textContent = parameter.unit || parameter.valueType;
          label.appendChild(name);
          label.appendChild(unit);
          wrapper.appendChild(label);

          const inputs = document.createElement('div');
          inputs.className = 'parameter-inputs';

          if ((parameter.valueType === 'number' || parameter.valueType === 'integer') && parameter.min !== undefined && parameter.max !== undefined) {
            const range = document.createElement('input');
            range.type = 'range';
            range.min = String(parameter.min);
            range.max = String(parameter.max);
            range.step = String(parameter.step ?? (parameter.valueType === 'integer' ? 1 : 0.1));
            range.value = String(value);
            range.dataset.paramId = parameter.id;
            range.dataset.paramType = parameter.valueType;

            const number = document.createElement('input');
            number.type = 'number';
            number.min = String(parameter.min);
            number.max = String(parameter.max);
            number.step = range.step;
            number.value = String(value);
            number.dataset.paramId = parameter.id;
            number.dataset.paramType = parameter.valueType;
            range.addEventListener('input', () => { number.value = range.value; });
            number.addEventListener('input', () => { range.value = number.value; });
            inputs.appendChild(range);
            inputs.appendChild(number);
          } else if (parameter.valueType === 'boolean') {
            const select = document.createElement('select');
            select.dataset.paramId = parameter.id;
            select.dataset.paramType = parameter.valueType;
            for (const optionValue of ['true', 'false']) {
              const option = document.createElement('option');
              option.value = optionValue;
              option.textContent = optionValue;
              option.selected = String(value) === optionValue;
              select.appendChild(option);
            }
            inputs.appendChild(select);
          } else {
            const input = document.createElement('input');
            input.type = parameter.valueType === 'string' ? 'text' : 'number';
            if (parameter.min !== undefined) input.min = String(parameter.min);
            if (parameter.max !== undefined) input.max = String(parameter.max);
            if (parameter.step !== undefined) input.step = String(parameter.step);
            input.value = String(value);
            input.dataset.paramId = parameter.id;
            input.dataset.paramType = parameter.valueType;
            inputs.appendChild(input);
          }

          wrapper.appendChild(inputs);
          box.appendChild(wrapper);
        }
      }

      function collectParameterOverrides() {
        const overrides = {};
        for (const parameter of study?.parameters ?? []) {
          const input = document.querySelector('[data-param-id="' + CSS.escape(parameter.id) + '"]:not([type="range"])') ??
            document.querySelector('[data-param-id="' + CSS.escape(parameter.id) + '"]');
          if (!input) continue;
          if (parameter.valueType === 'number') {
            overrides[parameter.id] = Number(input.value);
          } else if (parameter.valueType === 'integer') {
            overrides[parameter.id] = Number(input.value);
          } else if (parameter.valueType === 'boolean') {
            overrides[parameter.id] = input.value === 'true';
          } else {
            overrides[parameter.id] = input.value;
          }
        }
        return overrides;
      }

      function motionVerificationOptions() {
        return {
          enabled: $('motionEnabled').checked,
          tickSec: 0.2,
          clearanceM: 0.25,
          maxLagSec: 2
        };
      }

      function connect() {
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        socket = new WebSocket(protocol + '//' + location.host + '/ws/des?studyId=' + encodeURIComponent(studyId));
        socket.addEventListener('message', (event) => {
          const message = JSON.parse(event.data);
          if (message.type === 'generic-runtime-meta') {
            applyMeta(message.study, message.session);
            return;
          }
          if (message.type === 'generic-runtime-state') {
            session = message.session;
            if (session?.latestSnapshot) snapshot = session.latestSnapshot;
            if (session?.recentEvents) recentEvents = session.recentEvents;
            render();
            return;
          }
          if (message.type === 'generic-runtime-snapshot') {
            snapshot = message.snapshot;
            recentEvents = message.recentEvents;
            if (session) {
              session.status = message.status;
              session.speed = message.speed;
              session.progress = message.progress;
              session.simTimeSec = snapshot.nowSec;
              session.latestSnapshot = snapshot;
            }
            render();
          }
        });
      }

      function nodeMap(material) {
        return new Map((material?.nodes ?? []).map((node) => [node.id, node]));
      }

      function scaleFor(nodes) {
        const xs = nodes.map((node) => node.x);
        const zs = nodes.map((node) => node.z);
        const minX = Math.min(...xs, 0);
        const maxX = Math.max(...xs, 1);
        const minZ = Math.min(...zs, 0);
        const maxZ = Math.max(...zs, 1);
        const pad = 54;
        const width = 960;
        const height = 520;
        const spanX = Math.max(1, maxX - minX);
        const spanZ = Math.max(1, maxZ - minZ);
        const scale = Math.min((width - pad * 2) / spanX, (height - pad * 2) / spanZ);
        return {
          x: (value) => pad + (value - minX) * scale,
          y: (value) => height - pad - (value - minZ) * scale
        };
      }

      function interpolateRoute(routeNodeIds, progress, nodesById) {
        const points = routeNodeIds.map((nodeId) => nodesById.get(nodeId)).filter(Boolean);
        if (points.length === 0) return null;
        if (points.length === 1) return points[0];
        const lengths = [];
        let total = 0;
        for (let index = 0; index < points.length - 1; index += 1) {
          const length = Math.hypot(points[index + 1].x - points[index].x, points[index + 1].z - points[index].z);
          lengths.push(length);
          total += length;
        }
        let remaining = Math.max(0, Math.min(1, progress)) * total;
        for (let index = 0; index < lengths.length; index += 1) {
          if (remaining <= lengths[index] || index === lengths.length - 1) {
            const from = points[index];
            const to = points[index + 1];
            const local = lengths[index] === 0 ? 1 : remaining / lengths[index];
            return {
              x: from.x + (to.x - from.x) * local,
              z: from.z + (to.z - from.z) * local
            };
          }
          remaining -= lengths[index];
        }
        return points.at(-1);
      }

      function transportPosition(transport, nowSec, nodesById) {
        if (nowSec < transport.emptyTravelStartSec) {
          return { point: nodesById.get(transport.emptyFromNodeId), loaded: false, waiting: true };
        }
        if (nowSec < transport.emptyTravelEndSec && transport.emptyTravelEndSec > transport.emptyTravelStartSec) {
          return {
            point: interpolateRoute(
              transport.emptyRouteNodeIds,
              (nowSec - transport.emptyTravelStartSec) / (transport.emptyTravelEndSec - transport.emptyTravelStartSec),
              nodesById
            ),
            loaded: false,
            waiting: false
          };
        }
        if (nowSec < transport.loadEndSec) {
          return { point: nodesById.get(transport.loadedFromNodeId), loaded: false, waiting: false };
        }
        if (nowSec < transport.loadedTravelStartSec) {
          return { point: nodesById.get(transport.loadedFromNodeId), loaded: true, waiting: true };
        }
        if (nowSec < transport.loadedTravelEndSec && transport.loadedTravelEndSec > transport.loadedTravelStartSec) {
          return {
            point: interpolateRoute(
              transport.loadedRouteNodeIds,
              (nowSec - transport.loadedTravelStartSec) / (transport.loadedTravelEndSec - transport.loadedTravelStartSec),
              nodesById
            ),
            loaded: true,
            waiting: false
          };
        }
        return { point: nodesById.get(transport.loadedToNodeId), loaded: true, waiting: false };
      }

      function svgEl(name, attrs = {}) {
        const element = document.createElementNS('http://www.w3.org/2000/svg', name);
        for (const [key, value] of Object.entries(attrs)) {
          element.setAttribute(key, String(value));
        }
        return element;
      }

      function blockTone(kind) {
        if (kind === 'moveByTransporter' || kind === 'convey') return '#fff4e8';
        if (kind === 'service' || kind === 'seize' || kind === 'release') return '#eaf7f0';
        if (kind === 'source') return '#eef4ff';
        if (kind === 'sink') return '#f1f5f9';
        return '#ffffff';
      }

      function computeLogicLayout(blocks, connections) {
        const blockIds = new Set(blocks.map((block) => block.id));
        const incoming = new Map(blocks.map((block) => [block.id, []]));
        for (const connection of connections) {
          if (incoming.has(connection.to)) incoming.get(connection.to).push(connection.from);
        }
        const levels = new Map();
        blocks.forEach((block, index) => {
          if (block.kind === 'source' || (incoming.get(block.id)?.length ?? 0) === 0) {
            levels.set(block.id, 0);
          } else if (!blockIds.has(block.id)) {
            levels.set(block.id, index);
          }
        });
        for (let pass = 0; pass < blocks.length + connections.length; pass += 1) {
          for (const connection of connections) {
            if (!levels.has(connection.from)) continue;
            const next = (levels.get(connection.from) ?? 0) + 1;
            levels.set(connection.to, Math.max(levels.get(connection.to) ?? 0, next));
          }
        }
        blocks.forEach((block, index) => {
          if (!levels.has(block.id)) levels.set(block.id, index);
        });

        const groups = new Map();
        for (const block of blocks) {
          const level = levels.get(block.id) ?? 0;
          groups.set(level, [...(groups.get(level) ?? []), block]);
        }
        const maxLevel = Math.max(...Array.from(groups.keys()), 0);
        const positions = new Map();
        for (const [level, group] of groups.entries()) {
          const x = 48 + level * (820 / Math.max(1, maxLevel));
          group.forEach((block, index) => {
            const y = 46 + (index + 1) * (404 / (group.length + 1));
            positions.set(block.id, { x, y, width: 146, height: 66 });
          });
        }
        return positions;
      }

      function activeBlockIds() {
        const ids = new Set();
        for (const entity of snapshot?.entities ?? []) {
          if (entity.completedAtSec === null && entity.currentBlockId) ids.add(entity.currentBlockId);
        }
        for (const transport of snapshot?.activeTransports ?? []) {
          ids.add(transport.blockId);
        }
        const latestEnter = [...recentEvents].reverse().find((event) => event.type === 'process.entity.enter');
        if (latestEnter?.payload?.blockId) ids.add(String(latestEnter.payload.blockId));
        return ids;
      }

      function connectionLabel(connection) {
        if (typeof connection.probability === 'number') {
          return Math.round(connection.probability * 100) + '%';
        }
        if (connection.condition) {
          return 'condition';
        }
        return '';
      }

      function transportPhase(transport, nowSec) {
        if (nowSec < transport.emptyTravelStartSec) return 'waiting for empty route';
        if (nowSec < transport.emptyTravelEndSec) return 'empty travel';
        if (nowSec < transport.loadEndSec) return 'load';
        if (nowSec < transport.loadedTravelStartSec) return 'waiting for loaded route';
        if (nowSec < transport.loadedTravelEndSec) return 'loaded travel';
        if (nowSec < transport.unloadEndSec) return 'unload';
        return 'done';
      }

      function rounded(value, digits = 1) {
        return Number.isFinite(value) ? Number(value).toFixed(digits) : '-';
      }

      function percent(value) {
        return Number.isFinite(value) ? Math.round(value * 100) + '%' : '-';
      }

      function setTableRows(tableId, headers, rows, emptyText) {
        const table = $(tableId);
        table.innerHTML = '';
        const thead = document.createElement('thead');
        const headRow = document.createElement('tr');
        for (const header of headers) {
          const th = document.createElement('th');
          th.textContent = header;
          headRow.appendChild(th);
        }
        thead.appendChild(headRow);
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        if (rows.length === 0) {
          const row = document.createElement('tr');
          const cell = document.createElement('td');
          cell.colSpan = headers.length;
          cell.className = 'empty-cell';
          cell.textContent = emptyText;
          row.appendChild(cell);
          tbody.appendChild(row);
        } else {
          for (const values of rows) {
            const row = document.createElement('tr');
            for (const value of values) {
              const cell = document.createElement('td');
              cell.title = value == null ? '' : String(value);
              cell.textContent = value == null || value === '' ? '-' : String(value);
              row.appendChild(cell);
            }
            tbody.appendChild(row);
          }
        }
        table.appendChild(tbody);
      }

      function renderVerification() {
        const nowSec = snapshot?.nowSec ?? 0;
        const resources = snapshot?.resourcePools ?? [];
        setTableRows(
          'resources',
          ['Pool', 'Avail', 'Queue', 'Util', 'Avg Wait'],
          resources.map((pool) => [
            pool.id,
            pool.available + '/' + pool.capacity,
            pool.waiting.length + ' / max ' + pool.maxQueueLength,
            percent(pool.utilization),
            rounded(pool.averageWaitTimeSec) + 's'
          ]),
          'No resources'
        );

        const transports = snapshot?.activeTransports ?? [];
        setTableRows(
          'transports',
          ['Unit', 'Entity', 'Phase', 'From', 'To', 'Dispatch Wait', 'Traffic Wait', 'ETA'],
          transports.map((transport) => [
            transport.transporterUnitId,
            transport.entityId,
            transportPhase(transport, nowSec),
            transport.loadedFromNodeId,
            transport.loadedToNodeId,
            rounded(transport.dispatchWaitSec ?? 0) + 's',
            rounded(transport.trafficWaitSec ?? 0) + 's',
            rounded(Math.max(0, (transport.endSec ?? nowSec) - nowSec)) + 's'
          ]),
          'No active transports'
        );

        const transportWaits = snapshot?.transporterWaits ?? [];
        setTableRows(
          'transportQueues',
          ['Fleet', 'Entity', 'Block', 'Pickup', 'Dropoff', 'Wait'],
          transportWaits.map((request) => [
            request.fleetId,
            request.entityId,
            request.blockId,
            request.fromNodeId,
            request.toNodeId,
            rounded(nowSec - request.queuedAtSec) + 's'
          ]),
          'No queued transport requests'
        );

        const units = snapshot?.materialHandling?.transporterUnits ?? [];
        setTableRows(
          'units',
          ['Unit', 'Fleet', 'Status', 'Node', 'Entity'],
          units.map((unit) => [unit.id, unit.fleetId, unit.status, unit.currentNodeId, unit.assignedEntityId ?? '-']),
          'No transporter units'
        );

        const activeEntities = (snapshot?.entities ?? [])
          .filter((entity) => entity.completedAtSec === null)
          .slice(-10)
          .reverse();
        setTableRows(
          'entities',
          ['Entity', 'Type', 'Block', 'Age', 'Visits'],
          activeEntities.map((entity) => [
            entity.id,
            entity.type,
            entity.currentBlockId ?? '-',
            rounded(nowSec - entity.createdAtSec) + 's',
            entity.visitedBlockIds.length
          ]),
          'No active entities'
        );

        const motion = snapshot?.motionVerification;
        const warningCount = motion?.warnings?.length ?? 0;
        setTableRows(
          'motion',
          ['Unit', 'State', 'Sep', 'Warnings', 'Lag'],
          (motion?.units ?? []).map((unit) => [
            unit.unitId,
            unit.avoidanceStatus + ' / ' + unit.status,
            unit.minSeparationM === null ? '-' : rounded(unit.minSeparationM) + 'm',
            warningCount,
            rounded(unit.lagSec) + 's'
          ]),
          motion?.enabled === false ? 'Motion verification disabled' : 'No motion state'
        );
        setTableRows(
          'motionWarnings',
          ['Code', 'Severity', 'Unit', 'Message'],
          (motion?.warnings ?? []).map((warning) => [
            warning.code,
            warning.severity,
            warning.unitId ?? '-',
            warning.message
          ]),
          'No motion warnings'
        );
      }

      function renderStatistics() {
        const nowSec = snapshot?.nowSec ?? 0;
        const entities = snapshot?.entities ?? [];
        const completed = entities.filter((entity) => entity.completedAtSec !== null);
        const cycleTimes = completed.map((entity) => entity.completedAtSec - entity.createdAtSec);
        const avgCycle = cycleTimes.length === 0 ? 0 : cycleTimes.reduce((sum, value) => sum + value, 0) / cycleTimes.length;
        const throughputPerHour = nowSec <= 0 ? 0 : completed.length / nowSec * 3600;
        const wip = entities.length - completed.length;
        const resourceUtil = (snapshot?.resourcePools ?? []).length === 0 ? 0 :
          (snapshot.resourcePools.reduce((sum, pool) => sum + pool.utilization, 0) / snapshot.resourcePools.length);
        const fleetUtil = (snapshot?.transporterFleetStats ?? []).length === 0 ? 0 :
          (snapshot.transporterFleetStats.reduce((sum, fleet) => sum + fleet.utilization, 0) / snapshot.transporterFleetStats.length);
        const trafficWait = (snapshot?.transporterFleetStats ?? []).reduce((sum, fleet) => sum + fleet.totalTrafficWaitTimeSec, 0);
        setTableRows(
          'stats',
          ['Metric', 'Value'],
          [
            ['Throughput', rounded(throughputPerHour) + '/h'],
            ['WIP', wip],
            ['Average cycle', rounded(avgCycle) + 's'],
            ['Completion ratio', entities.length === 0 ? '0%' : percent(completed.length / entities.length)],
            ['Resource util', percent(resourceUtil)],
            ['AMR util', percent(fleetUtil)],
            ['Traffic wait', rounded(trafficWait) + 's']
          ],
          'No statistics'
        );

        const params = session?.effectiveParameterValues ?? {};
        setTableRows(
          'effectiveParams',
          ['Parameter', 'Value'],
          Object.entries(params).map(([key, value]) => [key, value]),
          'No model parameters'
        );
      }

      function renderLogic() {
        const svg = $('logic');
        svg.innerHTML = '';
        const blocks = study?.processBlocks ?? [];
        const connections = study?.processConnections ?? [];
        if (blocks.length === 0) {
          const text = svgEl('text', { x: 36, y: 58, fill: '#64748b' });
          text.textContent = 'No process logic loaded yet.';
          svg.appendChild(text);
          return;
        }

        const positions = computeLogicLayout(blocks, connections);
        const active = activeBlockIds();
        const defs = svgEl('defs');
        const marker = svgEl('marker', {
          id: 'arrow',
          markerWidth: 10,
          markerHeight: 10,
          refX: 8,
          refY: 3,
          orient: 'auto',
          markerUnits: 'strokeWidth'
        });
        marker.appendChild(svgEl('path', { d: 'M0,0 L0,6 L9,3 z', fill: '#8aa0b8' }));
        defs.appendChild(marker);
        svg.appendChild(defs);

        for (const connection of connections) {
          const from = positions.get(connection.from);
          const to = positions.get(connection.to);
          if (!from || !to) continue;
          const startX = from.x + from.width;
          const startY = from.y + from.height / 2;
          const endX = to.x;
          const endY = to.y + to.height / 2;
          const mid = Math.max(24, (endX - startX) / 2);
          const pathEl = svgEl('path', {
            d: 'M' + startX + ',' + startY + ' C' + (startX + mid) + ',' + startY + ' ' + (endX - mid) + ',' + endY + ' ' + endX + ',' + endY,
            fill: 'none',
            stroke: '#8aa0b8',
            'stroke-width': 2,
            'marker-end': 'url(#arrow)'
          });
          svg.appendChild(pathEl);
          const label = connectionLabel(connection);
          if (label) {
            const text = svgEl('text', {
              x: (startX + endX) / 2,
              y: (startY + endY) / 2 - 8,
              fill: '#64748b',
              'font-size': 11,
              'text-anchor': 'middle'
            });
            text.textContent = label;
            svg.appendChild(text);
          }
        }

        for (const block of blocks) {
          const pos = positions.get(block.id);
          const stats = snapshot?.blockStats?.[block.id];
          const isActive = active.has(block.id);
          const rect = svgEl('rect', {
            x: pos.x,
            y: pos.y,
            width: pos.width,
            height: pos.height,
            rx: 8,
            fill: isActive ? '#e7f0ff' : blockTone(block.kind),
            stroke: isActive ? '#2d6cdf' : '#ccd6e2',
            'stroke-width': isActive ? 3 : 1.4
          });
          svg.appendChild(rect);

          const title = svgEl('text', {
            x: pos.x + 12,
            y: pos.y + 22,
            fill: '#17212b',
            'font-size': 13,
            'font-weight': 700
          });
          title.textContent = block.label || block.id;
          svg.appendChild(title);

          const kind = svgEl('text', {
            x: pos.x + 12,
            y: pos.y + 40,
            fill: block.kind === 'moveByTransporter' ? '#b45f18' : '#64748b',
            'font-size': 11
          });
          kind.textContent = block.kind;
          svg.appendChild(kind);

          const stat = svgEl('text', {
            x: pos.x + 12,
            y: pos.y + 57,
            fill: '#64748b',
            'font-size': 11
          });
          stat.textContent = stats ? 'in ' + stats.entered + ' / done ' + stats.completed + ' / q ' + stats.maxQueueLength : 'not entered';
          svg.appendChild(stat);
        }
      }

      function renderLayout() {
        const svg = $('layout');
        svg.innerHTML = '';
        const material = snapshot?.materialHandling;
        const nodes = material?.nodes ?? [];
        if (!snapshot || nodes.length === 0) {
          svg.innerHTML = '<text x="40" y="60" fill="#d8e0ea">No live snapshot yet. Press Start.</text>';
          return;
        }
        const s = scaleFor(nodes);
        const nodesById = nodeMap(material);

        for (const path of material.paths ?? []) {
          const from = nodesById.get(path.from);
          const to = nodesById.get(path.to);
          if (!from || !to) continue;
          const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
          line.setAttribute('x1', s.x(from.x));
          line.setAttribute('y1', s.y(from.z));
          line.setAttribute('x2', s.x(to.x));
          line.setAttribute('y2', s.y(to.z));
          line.setAttribute('stroke', '#6f86a1');
          line.setAttribute('stroke-width', '5');
          line.setAttribute('stroke-linecap', 'round');
          svg.appendChild(line);
        }

        for (const obstacle of material.obstacles ?? []) {
          const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
          rect.setAttribute('x', s.x(obstacle.x) - 9);
          rect.setAttribute('y', s.y(obstacle.z) - 9);
          rect.setAttribute('width', 18);
          rect.setAttribute('height', 18);
          rect.setAttribute('fill', '#8b4f4f');
          rect.setAttribute('opacity', '0.85');
          svg.appendChild(rect);
        }

        for (const node of nodes) {
          const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
          const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
          circle.setAttribute('cx', s.x(node.x));
          circle.setAttribute('cy', s.y(node.z));
          circle.setAttribute('r', 12);
          circle.setAttribute('fill', node.type === 'storage' ? '#2f7d62' : node.type === 'dock' ? '#4976b8' : '#556274');
          const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
          text.setAttribute('x', s.x(node.x));
          text.setAttribute('y', s.y(node.z) - 18);
          text.setAttribute('text-anchor', 'middle');
          text.setAttribute('fill', '#d8e0ea');
          text.setAttribute('font-size', '13');
          text.textContent = node.id;
          group.appendChild(circle);
          group.appendChild(text);
          svg.appendChild(group);
        }

        const activeUnitIds = new Set((snapshot.activeTransports ?? []).map((transport) => transport.transporterUnitId));
        for (const unit of material.transporterUnits ?? []) {
          if (activeUnitIds.has(unit.id)) continue;
          const node = nodesById.get(unit.currentNodeId);
          if (!node) continue;
          drawVehicle(svg, s.x(node.x), s.y(node.z), unit.id, false);
        }

        for (const transport of snapshot.activeTransports ?? []) {
          const state = transportPosition(transport, snapshot.nowSec, nodesById);
          if (!state?.point) continue;
          drawVehicle(svg, s.x(state.point.x), s.y(state.point.z), transport.transporterUnitId, state.loaded, transport.entityId, state.waiting);
        }
      }

      function drawVehicle(svg, x, y, id, loaded, entityId = '', waiting = false) {
        const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect.setAttribute('x', x - 13);
        rect.setAttribute('y', y + 16);
        rect.setAttribute('width', 26);
        rect.setAttribute('height', 18);
        rect.setAttribute('rx', 4);
        rect.setAttribute('fill', waiting ? '#8a98a8' : loaded ? 'var(--load)' : 'var(--move)');
        const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        text.setAttribute('x', x);
        text.setAttribute('y', y + 50);
        text.setAttribute('text-anchor', 'middle');
        text.setAttribute('fill', '#ffffff');
        text.setAttribute('font-size', '12');
        text.textContent = entityId ? id + ' / ' + entityId + (waiting ? ' wait' : '') : id;
        group.appendChild(rect);
        group.appendChild(text);
        svg.appendChild(group);
      }

      function renderEvents() {
        const box = $('events');
        box.innerHTML = '';
        for (const event of [...recentEvents].slice(-16).reverse()) {
          const div = document.createElement('div');
          div.className = 'event';
          div.innerHTML = '<code>' + fmt(event.simTimeSec) + '</code> ' + event.type +
            '<br><small>' + JSON.stringify(event.payload) + '</small>';
          box.appendChild(div);
        }
      }

      function render() {
        $('status').textContent = session?.status ?? 'idle';
        $('time').textContent = fmt(snapshot?.nowSec ?? session?.simTimeSec ?? 0);
        $('created').textContent = snapshot?.createdEntities ?? 0;
        $('completed').textContent = snapshot?.completedEntities ?? 0;
        renderLayout();
        renderLogic();
        renderVerification();
        renderStatistics();
        renderEvents();
      }

      $('start').addEventListener('click', () => post('/start', {
        speed: Number($('speed').value),
        experimentId: $('experiment').value,
        parameterOverrides: collectParameterOverrides(),
        motionVerification: motionVerificationOptions()
      }).then((envelope) => applyMeta(envelope.study, envelope.session)));
      $('pause').addEventListener('click', () => post('/pause').then((envelope) => applyMeta(envelope.study, envelope.session)));
      $('resume').addEventListener('click', () => post('/resume').then((envelope) => applyMeta(envelope.study, envelope.session)));
      $('restart').addEventListener('click', () => post('/restart', {
        speed: Number($('speed').value),
        experimentId: $('experiment').value,
        parameterOverrides: collectParameterOverrides(),
        motionVerification: motionVerificationOptions()
      }).then((envelope) => applyMeta(envelope.study, envelope.session)));
      $('speed').addEventListener('change', () => post('/speed', { speed: Number($('speed').value) }).catch(console.error));
      $('experiment').addEventListener('change', () => renderParameterControls());

      refreshMeta().catch(console.error);
      connect();
    </script>
  </body>
</html>`;
}
