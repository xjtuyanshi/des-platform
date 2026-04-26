import {
  analyzeMaterialHandlingDefinition,
  createMaterialHandlingRuntime,
  type MaterialHandlingRuntime
} from '@des-platform/material-handling';
import { createProcessFlowSimulation, runProcessFlow, type ProcessFlowRunResult } from '@des-platform/process-flow';
import {
  AiNativeDesModelDefinitionSchema,
  type AiNativeDesModelDefinition,
  type DslLiteral,
  type ExperimentDefinition,
  type MaterialPathDefinition,
  type ModelParameterDefinition,
  type ProcessFlowBlockDefinition
} from '@des-platform/shared-schema/model-dsl';

export type GenericRunEntitySummary = {
  id: string;
  type: string;
  createdAtSec: number;
  completedAtSec: number | null;
  cycleTimeSec: number | null;
};

export type GenericResourcePoolSummary = {
  id: string;
  capacity: number;
  utilization: number;
  totalWaitTimeSec: number;
  averageWaitTimeSec: number;
  completedRequests: number;
  maxQueueLength: number;
};

export type GenericTransporterFleetSummary = {
  fleetId: string;
  moveRequests: number;
  startedMoves: number;
  completedMoves: number;
  utilization: number;
  totalWaitTimeSec: number;
  averageWaitTimeSec: number;
  totalBusyTimeSec: number;
  totalDistanceM: number;
  totalEmptyDistanceM: number;
  totalLoadedDistanceM: number;
  totalTrafficWaitTimeSec: number;
  totalPathTrafficWaitTimeSec: number;
  totalNodeTrafficWaitTimeSec: number;
  totalEmptyTrafficWaitTimeSec: number;
  totalLoadedTrafficWaitTimeSec: number;
  totalEmptyPathTrafficWaitTimeSec: number;
  totalEmptyNodeTrafficWaitTimeSec: number;
  totalLoadedPathTrafficWaitTimeSec: number;
  totalLoadedNodeTrafficWaitTimeSec: number;
  totalTravelTimeSec: number;
};

export type GenericRunSummary = {
  createdEntities: number;
  completedEntities: number;
  completionRatio: number;
  averageCycleTimeSec: number;
  maxCycleTimeSec: number;
  executedEvents: number;
  remainingEvents: number;
  stoppedBy: 'until' | 'empty' | 'max-events';
  resourcePoolCount: number;
  transporterUnitCount: number;
  storageSystemCount: number;
  conveyorCount: number;
  resourcePools: GenericResourcePoolSummary[];
  transporterFleets: GenericTransporterFleetSummary[];
  entities: GenericRunEntitySummary[];
};

export type GenericDesRunResult = {
  schemaVersion: 'des-platform.run.v1';
  modelId: string;
  modelName: string;
  experimentId: string;
  experimentName: string | null;
  seed: number;
  stopTimeSec: number;
  warmupSec: number;
  parameterValues: Record<string, DslLiteral>;
  nowSec: number;
  summary: GenericRunSummary;
  eventLog: ProcessFlowRunResult['simulation']['eventLog'];
  snapshot: ProcessFlowRunResult['snapshot'];
};

export type GenericReplicationSummary = {
  replicationIndex: number;
  seed: number;
  nowSec: number;
  stoppedBy: GenericRunSummary['stoppedBy'];
  createdEntities: number;
  completedEntities: number;
  completionRatio: number;
  averageCycleTimeSec: number;
  maxCycleTimeSec: number;
  executedEvents: number;
  remainingEvents: number;
};

export type GenericMetricStats = {
  metric: string;
  count: number;
  mean: number;
  standardDeviation: number;
  min: number;
  max: number;
  confidenceLevel: 0.95;
  halfWidth95: number;
};

export type GenericDesExperimentResult = {
  schemaVersion: 'des-platform.experiment.v1';
  modelId: string;
  modelName: string;
  experimentId: string;
  experimentName: string | null;
  baseSeed: number;
  seedStride: number;
  replications: number;
  stopTimeSec: number;
  warmupSec: number;
  parameterValues: Record<string, DslLiteral>;
  metricStats: Record<string, GenericMetricStats>;
  replicationSummaries: GenericReplicationSummary[];
};

export type GenericSweepCaseResult = {
  caseIndex: number;
  parameterValues: Record<string, DslLiteral>;
  metricStats: Record<string, GenericMetricStats>;
  replicationSummaries: GenericReplicationSummary[];
};

export type GenericDesSweepResult = {
  schemaVersion: 'des-platform.sweep.v1';
  modelId: string;
  modelName: string;
  experimentId: string;
  experimentName: string | null;
  baseSeed: number;
  seedStride: number;
  replications: number;
  stopTimeSec: number;
  warmupSec: number;
  sweepParameters: string[];
  caseCount: number;
  cases: GenericSweepCaseResult[];
};

export type ModelDiagnosticSeverity = 'error' | 'warning';

export type ModelRepairCandidate = {
  kind: 'jsonPatch' | 'proposal';
  safety: 'safeAutoApply' | 'requiresConfirmation';
  confidence: number;
  requiresUserConfirmation: boolean;
  patch: Array<{
    op: 'add' | 'replace' | 'remove';
    path: string;
    value?: unknown;
  }>;
  explanation: string;
};

export type ModelDiagnostic = {
  severity: ModelDiagnosticSeverity;
  code: string;
  path: string;
  jsonPointer: string;
  schemaPath: string;
  humanPath: string;
  message: string;
  risk: 'safe' | 'needs-confirmation';
  repairCandidate: ModelRepairCandidate | null;
  requiresUserConfirmation: boolean;
};

export type ModelDiagnosticsReport = {
  valid: boolean;
  errors: ModelDiagnostic[];
  warnings: ModelDiagnostic[];
  diagnostics: ModelDiagnostic[];
};

export type GenericDesRuntime = ProcessFlowRunResult & {
  model: AiNativeDesModelDefinition;
  experiment: ExperimentDefinition;
};

export type CompiledDesModel = {
  model: AiNativeDesModelDefinition;
  defaultExperiment: ExperimentDefinition | null;
  createRuntime: () => ProcessFlowRunResult;
  createRuntimeForExperiment: (experimentId?: string) => GenericDesRuntime;
  createMaterialHandlingRuntime: () => MaterialHandlingRuntime | null;
  runExperiment: (experimentId?: string) => ProcessFlowRunResult;
  runExperimentToResult: (experimentId?: string) => GenericDesRunResult;
  runReplicationsToResult: (experimentId?: string) => GenericDesExperimentResult;
  runSweepToResult: (experimentId?: string) => GenericDesSweepResult;
};

export function analyzeDesModel(input: unknown): ModelDiagnosticsReport {
  const parsed = AiNativeDesModelDefinitionSchema.safeParse(input);
  if (!parsed.success) {
    return buildDiagnosticsReport(parsed.error.issues.map(zodIssueToDiagnostic));
  }

  return buildDiagnosticsReport([
    ...analyzeProcessGraph(parsed.data),
    ...analyzeParameterSemantics(parsed.data),
    ...analyzeMaterialHandlingSemantics(parsed.data),
    ...analyzeExperimentSemantics(parsed.data)
  ]);
}

export function compileDesModel(input: unknown): CompiledDesModel {
  const model = AiNativeDesModelDefinitionSchema.parse(input);
  const defaultExperiment = model.experiments[0] ?? null;

  return {
    model,
    defaultExperiment,
    createRuntime: () =>
      createProcessFlowSimulation(materializeModelForExperiment(model, defaultExperiment).process, {
        materialHandling: createMaterialHandlingRuntimeForExperiment(model, defaultExperiment),
        seed: defaultExperiment?.seed
      }),
    createRuntimeForExperiment: (experimentId?: string) => {
      const experiment = resolveExperiment(model, experimentId);
      const configuredModel = materializeModelForExperiment(model, experiment);
      return {
        ...createProcessFlowSimulation(configuredModel.process, {
          materialHandling: configuredModel.materialHandling ? createMaterialHandlingRuntime(configuredModel.materialHandling) : null,
          seed: experiment.seed
        }),
        model: configuredModel,
        experiment
      };
    },
    createMaterialHandlingRuntime: () =>
      model.materialHandling ? createMaterialHandlingRuntime(model.materialHandling) : null,
    runExperiment: (experimentId?: string) => {
      const experiment = resolveExperiment(model, experimentId);
      const configuredModel = materializeModelForExperiment(model, experiment);
      return runProcessFlow(configuredModel.process, experiment.stopTimeSec, experiment.maxEvents, {
        materialHandling: configuredModel.materialHandling ? createMaterialHandlingRuntime(configuredModel.materialHandling) : null,
        seed: experiment.seed
      });
    },
    runExperimentToResult: (experimentId?: string) => {
      const experiment = resolveExperiment(model, experimentId);
      return runSingleExperimentToResult(model, experiment, experiment.seed);
    },
    runReplicationsToResult: (experimentId?: string) =>
      runReplicationsForModel(model, resolveExperiment(model, experimentId)),
    runSweepToResult: (experimentId?: string) =>
      runSweepForModel(model, resolveExperiment(model, experimentId))
  };
}

export function runDesModel(input: unknown, experimentId?: string): ProcessFlowRunResult {
  return compileDesModel(input).runExperiment(experimentId);
}

export function runDesModelToResult(input: unknown, experimentId?: string): GenericDesRunResult {
  return compileDesModel(input).runExperimentToResult(experimentId);
}

export function runDesModelReplicationsToResult(input: unknown, experimentId?: string): GenericDesExperimentResult {
  return compileDesModel(input).runReplicationsToResult(experimentId);
}

export function runDesModelSweepToResult(input: unknown, experimentId?: string): GenericDesSweepResult {
  return compileDesModel(input).runSweepToResult(experimentId);
}

function resolveExperiment(model: AiNativeDesModelDefinition, experimentId?: string): ExperimentDefinition {
  if (model.experiments.length === 0) {
    throw new Error(`Model ${model.id} does not define any experiments`);
  }

  if (!experimentId) {
    return model.experiments[0]!;
  }

  const experiment = model.experiments.find((candidate) => candidate.id === experimentId);
  if (!experiment) {
    throw new Error(`Model ${model.id} does not define experiment ${experimentId}`);
  }

  return experiment;
}

function buildGenericRunResult(
  model: AiNativeDesModelDefinition,
  experiment: ExperimentDefinition,
  run: ProcessFlowRunResult,
  seed = experiment.seed,
  parameterValues = resolveParameterValues(model, experiment)
): GenericDesRunResult {
  const entities = run.snapshot.entities.map((entity) => ({
    id: entity.id,
    type: entity.type,
    createdAtSec: entity.createdAtSec,
    completedAtSec: entity.completedAtSec,
    cycleTimeSec: entity.completedAtSec === null ? null : entity.completedAtSec - entity.createdAtSec
  }));
  const completedCycles = entities
    .map((entity) => entity.cycleTimeSec)
    .filter((cycleTimeSec): cycleTimeSec is number => cycleTimeSec !== null);
  const completedEntities = completedCycles.length;
  const createdEntities = entities.length;
  const materialHandling = run.snapshot.materialHandling;
  const runResult = run.runResult ?? {
    nowSec: run.simulation.nowSec,
    executedEvents: run.simulation.executedEventCount,
    remainingEvents: run.simulation.pendingEvents,
    stoppedBy: 'until' as const
  };

  return {
    schemaVersion: 'des-platform.run.v1',
    modelId: model.id,
    modelName: model.name,
    experimentId: experiment.id,
    experimentName: experiment.name ?? null,
    seed,
    stopTimeSec: experiment.stopTimeSec,
    warmupSec: experiment.warmupSec,
    parameterValues,
    nowSec: run.snapshot.nowSec,
    summary: {
      createdEntities,
      completedEntities,
      completionRatio: createdEntities === 0 ? 0 : completedEntities / createdEntities,
      averageCycleTimeSec: completedCycles.length === 0 ? 0 : completedCycles.reduce((sum, value) => sum + value, 0) / completedCycles.length,
      maxCycleTimeSec: completedCycles.length === 0 ? 0 : Math.max(...completedCycles),
      executedEvents: runResult.executedEvents,
      remainingEvents: runResult.remainingEvents,
      stoppedBy: runResult.stoppedBy,
      resourcePoolCount: run.snapshot.resourcePools.length,
      transporterUnitCount: materialHandling?.transporterUnits.length ?? 0,
      storageSystemCount: materialHandling?.storageSystems.length ?? 0,
      conveyorCount: materialHandling?.conveyors.length ?? 0,
      resourcePools: run.snapshot.resourcePools.map((pool) => ({
        id: pool.id,
        capacity: pool.capacity,
        utilization: pool.utilization,
        totalWaitTimeSec: pool.totalWaitTimeSec,
        averageWaitTimeSec: pool.averageWaitTimeSec,
        completedRequests: pool.completedRequests,
        maxQueueLength: pool.maxQueueLength
      })),
      transporterFleets: run.snapshot.transporterFleetStats.map((fleet) => ({
        fleetId: fleet.fleetId,
        moveRequests: fleet.moveRequests,
        startedMoves: fleet.startedMoves,
        completedMoves: fleet.completedMoves,
        utilization: fleet.utilization,
        totalWaitTimeSec: fleet.totalWaitTimeSec,
        averageWaitTimeSec: fleet.averageWaitTimeSec,
        totalBusyTimeSec: fleet.totalBusyTimeSec,
        totalDistanceM: fleet.totalDistanceM,
        totalEmptyDistanceM: fleet.totalEmptyDistanceM,
        totalLoadedDistanceM: fleet.totalLoadedDistanceM,
        totalTrafficWaitTimeSec: fleet.totalTrafficWaitTimeSec,
        totalPathTrafficWaitTimeSec: fleet.totalPathTrafficWaitTimeSec,
        totalNodeTrafficWaitTimeSec: fleet.totalNodeTrafficWaitTimeSec,
        totalEmptyTrafficWaitTimeSec: fleet.totalEmptyTrafficWaitTimeSec,
        totalLoadedTrafficWaitTimeSec: fleet.totalLoadedTrafficWaitTimeSec,
        totalEmptyPathTrafficWaitTimeSec: fleet.totalEmptyPathTrafficWaitTimeSec,
        totalEmptyNodeTrafficWaitTimeSec: fleet.totalEmptyNodeTrafficWaitTimeSec,
        totalLoadedPathTrafficWaitTimeSec: fleet.totalLoadedPathTrafficWaitTimeSec,
        totalLoadedNodeTrafficWaitTimeSec: fleet.totalLoadedNodeTrafficWaitTimeSec,
        totalTravelTimeSec: fleet.totalTravelTimeSec
      })),
      entities
    },
    eventLog: run.simulation.eventLog,
    snapshot: run.snapshot
  };
}

function runSingleExperimentToResult(
  model: AiNativeDesModelDefinition,
  experiment: ExperimentDefinition,
  seed: number
): GenericDesRunResult {
  const configuredModel = materializeModelForExperiment(model, experiment);
  const parameterValues = resolveParameterValues(model, experiment);
  const run = runProcessFlow(configuredModel.process, experiment.stopTimeSec, experiment.maxEvents, {
    materialHandling: configuredModel.materialHandling ? createMaterialHandlingRuntime(configuredModel.materialHandling) : null,
    seed
  });
  return buildGenericRunResult(configuredModel, experiment, run, seed, parameterValues);
}

function runReplicationsForModel(
  model: AiNativeDesModelDefinition,
  experiment: ExperimentDefinition
): GenericDesExperimentResult {
  const replicationSummaries: GenericReplicationSummary[] = [];

  for (let index = 0; index < experiment.replications; index += 1) {
    const seed = experiment.seed + index * experiment.seedStride;
    const result = runSingleExperimentToResult(model, experiment, seed);
    replicationSummaries.push({
      replicationIndex: index + 1,
      seed,
      nowSec: result.nowSec,
      stoppedBy: result.summary.stoppedBy,
      createdEntities: result.summary.createdEntities,
      completedEntities: result.summary.completedEntities,
      completionRatio: result.summary.completionRatio,
      averageCycleTimeSec: result.summary.averageCycleTimeSec,
      maxCycleTimeSec: result.summary.maxCycleTimeSec,
      executedEvents: result.summary.executedEvents,
      remainingEvents: result.summary.remainingEvents
    });
  }

  return {
    schemaVersion: 'des-platform.experiment.v1',
    modelId: model.id,
    modelName: model.name,
    experimentId: experiment.id,
    experimentName: experiment.name ?? null,
    baseSeed: experiment.seed,
    seedStride: experiment.seedStride,
    replications: experiment.replications,
    stopTimeSec: experiment.stopTimeSec,
    warmupSec: experiment.warmupSec,
    parameterValues: resolveParameterValues(model, experiment),
    metricStats: buildMetricStats(replicationSummaries),
    replicationSummaries
  };
}

function runSweepForModel(
  model: AiNativeDesModelDefinition,
  experiment: ExperimentDefinition
): GenericDesSweepResult {
  const sweepParameters = Object.keys(experiment.sweep);
  const cases = buildSweepExperiments(experiment).map((sweepExperiment, index) => {
    const replicationReport = runReplicationsForModel(model, sweepExperiment);
    return {
      caseIndex: index + 1,
      parameterValues: replicationReport.parameterValues,
      metricStats: replicationReport.metricStats,
      replicationSummaries: replicationReport.replicationSummaries
    };
  });

  return {
    schemaVersion: 'des-platform.sweep.v1',
    modelId: model.id,
    modelName: model.name,
    experimentId: experiment.id,
    experimentName: experiment.name ?? null,
    baseSeed: experiment.seed,
    seedStride: experiment.seedStride,
    replications: experiment.replications,
    stopTimeSec: experiment.stopTimeSec,
    warmupSec: experiment.warmupSec,
    sweepParameters,
    caseCount: cases.length,
    cases
  };
}

function buildSweepExperiments(experiment: ExperimentDefinition): ExperimentDefinition[] {
  const entries = Object.entries(experiment.sweep);
  if (entries.length === 0) {
    return [experiment];
  }

  const cases: Array<Record<string, DslLiteral>> = [{}];
  for (const [parameterId, values] of entries) {
    const nextCases: Array<Record<string, DslLiteral>> = [];
    for (const currentCase of cases) {
      for (const value of values) {
        nextCases.push({
          ...currentCase,
          [parameterId]: value
        });
      }
    }
    cases.splice(0, cases.length, ...nextCases);
  }

  return cases.map((caseOverrides) => ({
    ...experiment,
    parameterOverrides: {
      ...experiment.parameterOverrides,
      ...caseOverrides
    }
  }));
}

function materializeModelForExperiment(
  model: AiNativeDesModelDefinition,
  experiment: ExperimentDefinition | null
): AiNativeDesModelDefinition {
  if (!experiment || model.parameters.length === 0) {
    return model;
  }

  const configuredModel = structuredClone(model) as AiNativeDesModelDefinition;
  const parameterValues = resolveParameterValues(model, experiment);
  for (const parameter of model.parameters) {
    applyParameterPath(configuredModel, parameter.path, parameterValues[parameter.id], parameter.id);
  }

  return AiNativeDesModelDefinitionSchema.parse(configuredModel);
}

function createMaterialHandlingRuntimeForExperiment(
  model: AiNativeDesModelDefinition,
  experiment: ExperimentDefinition | null
): MaterialHandlingRuntime | null {
  const configuredModel = materializeModelForExperiment(model, experiment);
  return configuredModel.materialHandling ? createMaterialHandlingRuntime(configuredModel.materialHandling) : null;
}

function resolveParameterValues(
  model: AiNativeDesModelDefinition,
  experiment: ExperimentDefinition | null
): Record<string, DslLiteral> {
  return Object.fromEntries(
    model.parameters.map((parameter) => [
      parameter.id,
      experiment?.parameterOverrides[parameter.id] ?? parameter.defaultValue
    ])
  );
}

function applyParameterPath(
  root: unknown,
  path: string,
  value: DslLiteral | undefined,
  parameterId: string
): void {
  if (value === undefined) {
    throw new Error(`Parameter ${parameterId} has no value`);
  }

  const segments = parseParameterPath(path);
  if (segments.length === 0) {
    throw new Error(`Parameter ${parameterId} cannot target the model root`);
  }

  let current = root;
  for (const segment of segments.slice(0, -1)) {
    current = getPathChild(current, segment, parameterId, path);
  }

  setPathChild(current, segments[segments.length - 1]!, value, parameterId, path);
}

function parseParameterPath(path: string): string[] {
  if (!path.startsWith('/')) {
    throw new Error(`Parameter path ${path} must start with /`);
  }
  return path
    .split('/')
    .slice(1)
    .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function getPathChild(container: unknown, segment: string, parameterId: string, path: string): unknown {
  if (Array.isArray(container)) {
    const byId = container.find((item) => isRecord(item) && item.id === segment);
    if (byId !== undefined) {
      return byId;
    }

    const index = Number(segment);
    if (Number.isInteger(index) && index >= 0 && index < container.length) {
      return container[index];
    }

    throw new Error(`Parameter ${parameterId} path ${path} cannot resolve array segment ${segment}`);
  }

  if (isRecord(container) && segment in container) {
    return container[segment];
  }

  throw new Error(`Parameter ${parameterId} path ${path} cannot resolve segment ${segment}`);
}

function setPathChild(container: unknown, segment: string, value: DslLiteral, parameterId: string, path: string): void {
  if (Array.isArray(container)) {
    const byIdIndex = container.findIndex((item) => isRecord(item) && item.id === segment);
    if (byIdIndex >= 0) {
      container[byIdIndex] = value;
      return;
    }

    const index = Number(segment);
    if (Number.isInteger(index) && index >= 0 && index < container.length) {
      container[index] = value;
      return;
    }

    throw new Error(`Parameter ${parameterId} path ${path} cannot set array segment ${segment}`);
  }

  if (isRecord(container) && segment in container) {
    container[segment] = value;
    return;
  }

  throw new Error(`Parameter ${parameterId} path ${path} cannot set segment ${segment}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function buildMetricStats(replications: GenericReplicationSummary[]): Record<string, GenericMetricStats> {
  const metrics = [
    'createdEntities',
    'completedEntities',
    'completionRatio',
    'averageCycleTimeSec',
    'maxCycleTimeSec',
    'executedEvents',
    'remainingEvents',
    'nowSec'
  ] as const satisfies ReadonlyArray<keyof GenericReplicationSummary>;

  return Object.fromEntries(
    metrics.map((metric) => [
      metric,
      summarizeMetric(metric, replications.map((replication) => Number(replication[metric])))
    ])
  );
}

function summarizeMetric(metric: string, values: number[]): GenericMetricStats {
  const count = values.length;
  const mean = count === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / count;
  const variance = count <= 1 ? 0 : values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (count - 1);
  const standardDeviation = Math.sqrt(variance);
  const tCritical = count <= 1 ? 0 : tCritical95(count - 1);

  return {
    metric,
    count,
    mean,
    standardDeviation,
    min: count === 0 ? 0 : Math.min(...values),
    max: count === 0 ? 0 : Math.max(...values),
    confidenceLevel: 0.95,
    halfWidth95: count <= 1 ? 0 : tCritical * standardDeviation / Math.sqrt(count)
  };
}

function tCritical95(degreesOfFreedom: number): number {
  const table = [
    12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228,
    2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086,
    2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042
  ];
  return table[degreesOfFreedom - 1] ?? 1.96;
}

function buildDiagnosticsReport(diagnostics: ModelDiagnostic[]): ModelDiagnosticsReport {
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
  const warnings = diagnostics.filter((diagnostic) => diagnostic.severity === 'warning');
  return {
    valid: errors.length === 0,
    errors,
    warnings,
    diagnostics
  };
}

function zodIssueToDiagnostic(issue: { path: Array<string | number>; message: string }): ModelDiagnostic {
  const path = issue.path.length === 0 ? '$' : issue.path.join('.');
  const jsonPointer = pathToJsonPointer(issue.path);
  const repairCandidate = schemaRepairCandidate(issue.path);
  return {
    severity: 'error',
    code: 'schema.invalid',
    path,
    jsonPointer,
    schemaPath: path,
    humanPath: path,
    message: issue.message,
    risk: repairCandidate?.requiresUserConfirmation ? 'needs-confirmation' : 'safe',
    repairCandidate,
    requiresUserConfirmation: repairCandidate?.requiresUserConfirmation ?? false
  };
}

function analyzeProcessGraph(model: AiNativeDesModelDefinition): ModelDiagnostic[] {
  const diagnostics: ModelDiagnostic[] = [];
  const blocks = model.process.blocks;
  const blockMap = new Map(blocks.map((block) => [block.id, block]));
  const blockPointer = new Map(blocks.map((block, index) => [block.id, `/process/blocks/${index}`]));
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();

  for (const block of blocks) {
    outgoing.set(block.id, []);
    incoming.set(block.id, []);
  }

  for (const connection of model.process.connections) {
    outgoing.get(connection.from)?.push(connection.to);
    incoming.get(connection.to)?.push(connection.from);
  }

  const sourceIds = blocks.filter((block) => block.kind === 'source').map((block) => block.id);
  const sinkIds = blocks.filter((block) => block.kind === 'sink').map((block) => block.id);
  if (sourceIds.length === 0) {
    diagnostics.push(error('process.no-source', 'process.blocks', 'Process must define at least one source block', {
      jsonPointer: '/process/blocks',
      repairCandidate: safePatch([{ op: 'add', path: '/process/blocks/-', value: { id: 'source', kind: 'source', entityType: 'entity', scheduleAtSec: [0] } }], 'Add a minimal source block that creates one entity at time zero.')
    }));
  }
  if (sinkIds.length === 0) {
    diagnostics.push(error('process.no-sink', 'process.blocks', 'Process should define at least one sink block', {
      jsonPointer: '/process/blocks',
      repairCandidate: safePatch([{ op: 'add', path: '/process/blocks/-', value: { id: 'sink', kind: 'sink' } }], 'Add a minimal sink block so completed entities have an explicit destination.')
    }));
  }

  const reachable = reachableFrom(sourceIds, outgoing);
  for (const block of blocks) {
    if (!reachable.has(block.id)) {
      diagnostics.push(warning('process.unreachable-block', `process.blocks.${block.id}`, `Block ${block.id} is not reachable from any source`, {
        jsonPointer: blockPointer.get(block.id)
      }));
    }

    if (block.kind !== 'sink' && (outgoing.get(block.id)?.length ?? 0) === 0) {
      diagnostics.push(error('process.dead-end', `process.blocks.${block.id}`, `Block ${block.id} has no outgoing connection`, {
        jsonPointer: blockPointer.get(block.id),
        repairCandidate: sinkIds.length === 1
          ? proposalPatch([{ op: 'add', path: '/process/connections/-', value: { from: block.id, to: sinkIds[0] } }], `Connect dead-end block ${block.id} to sink ${sinkIds[0]}. Confirm this route is intended.`)
          : null
      }));
    }

    if (block.kind !== 'source' && block.kind !== 'sink' && (incoming.get(block.id)?.length ?? 0) === 0) {
      diagnostics.push(warning('process.no-incoming', `process.blocks.${block.id}`, `Block ${block.id} has no incoming connection`, {
        jsonPointer: blockPointer.get(block.id)
      }));
    }

    if (block.kind === 'selectOutput' && !(model.process.connections.some((connection) => connection.from === block.id && !connection.condition))) {
      diagnostics.push(warning('process.select-no-fallback', `process.blocks.${block.id}`, `SelectOutput block ${block.id} has no unconditional fallback branch`, {
        jsonPointer: blockPointer.get(block.id),
        repairCandidate: sinkIds.length === 1
          ? proposalPatch([{ op: 'add', path: '/process/connections/-', value: { from: block.id, to: sinkIds[0] } }], `Add an unconditional fallback branch from ${block.id} to ${sinkIds[0]}. Confirm this fallback is the right business route.`)
          : null
      }));
    }
  }

  for (const sourceId of sourceIds) {
    if (!canReachAnySink(sourceId, new Set(sinkIds), outgoing)) {
      diagnostics.push(error('process.source-cannot-reach-sink', `process.blocks.${sourceId}`, `Source ${sourceId} cannot reach any sink block`, {
        jsonPointer: blockPointer.get(sourceId)
      }));
    }
  }

  for (const sinkId of sinkIds) {
    if ((incoming.get(sinkId)?.length ?? 0) === 0) {
      diagnostics.push(warning('process.unused-sink', `process.blocks.${sinkId}`, `Sink ${sinkId} has no incoming connection`, {
        jsonPointer: blockPointer.get(sinkId)
      }));
    }
  }

  for (const block of blocks) {
    if (block.kind === 'release' && !hasUpstreamSeizeOrService(block, blockMap, incoming)) {
      diagnostics.push(warning('process.release-without-upstream-hold', `process.blocks.${block.id}`, `Release block ${block.id} has no upstream seize/service for ${block.resourcePoolId}`, {
        jsonPointer: blockPointer.get(block.id)
      }));
    }
  }

  return diagnostics;
}

function analyzeParameterSemantics(model: AiNativeDesModelDefinition): ModelDiagnostic[] {
  const diagnostics: ModelDiagnostic[] = [];

  for (const [index, parameter] of model.parameters.entries()) {
    const pathError = validateParameterPath(model, parameter);
    if (pathError) {
      diagnostics.push(error('parameter.path-invalid', `parameters.${parameter.id}.path`, pathError.message, {
        jsonPointer: `/parameters/${index}/path`,
        repairCandidate: proposalPatch([{ op: 'remove', path: `/parameters/${index}` }], `Remove parameter ${parameter.id}. Confirm removal if this parameter is not needed, or edit the path manually.`)
      }));
    }
  }

  for (const [index, experiment] of model.experiments.entries()) {
    try {
      materializeModelForExperiment(model, experiment);
      for (const sweepExperiment of buildSweepExperiments(experiment)) {
        materializeModelForExperiment(model, sweepExperiment);
      }
    } catch (materializeError) {
      diagnostics.push(error(
        'parameter.override-invalid',
        `experiments.${experiment.id}.parameterOverrides`,
        materializeError instanceof Error ? materializeError.message : `Experiment ${experiment.id} has invalid parameter overrides`,
        { jsonPointer: `/experiments/${index}/parameterOverrides` }
      ));
    }
  }

  return diagnostics;
}

function validateParameterPath(model: AiNativeDesModelDefinition, parameter: ModelParameterDefinition): Error | null {
  try {
    const configuredModel = structuredClone(model) as AiNativeDesModelDefinition;
    applyParameterPath(configuredModel, parameter.path, parameter.defaultValue, parameter.id);
    return null;
  } catch (pathError) {
    return pathError instanceof Error ? pathError : new Error(String(pathError));
  }
}

function analyzeMaterialHandlingSemantics(model: AiNativeDesModelDefinition): ModelDiagnostic[] {
  const diagnostics: ModelDiagnostic[] = [];
  const materialBlocks = model.process.blocks.filter(isMaterialBlock);
  if (!model.materialHandling) {
    return diagnostics;
  }
  const blockPointer = new Map(model.process.blocks.map((block, index) => [block.id, `/process/blocks/${index}`]));
  const nodeById = new Map(model.materialHandling.nodes.map((node) => [node.id, node]));
  const pathIndexById = new Map(model.materialHandling.paths.map((path, index) => [path.id, index]));

  if (materialBlocks.length === 0) {
    diagnostics.push(warning('material.unused-layout', 'materialHandling', 'materialHandling is defined but no material handling process blocks use it', {
      jsonPointer: '/materialHandling'
    }));
  }

  diagnostics.push(
    ...analyzeMaterialHandlingDefinition(model.materialHandling).map((diagnostic) => {
      const repairCandidate = materialDiagnosticRepairCandidate(diagnostic, model, pathIndexById);
      return {
        severity: diagnostic.severity,
        code: diagnostic.code,
        path: diagnostic.path,
        jsonPointer: materialDiagnosticPointer(diagnostic.path, pathIndexById),
        schemaPath: diagnostic.path,
        humanPath: diagnostic.path,
        message: diagnostic.message,
        risk: diagnostic.code === 'material.unmodeled-path-crossing' || diagnostic.code === 'material.path-obstacle-clearance'
          ? 'needs-confirmation' as const
          : 'safe' as const,
        repairCandidate,
        requiresUserConfirmation: repairCandidate?.requiresUserConfirmation ?? (diagnostic.code === 'material.unmodeled-path-crossing' || diagnostic.code === 'material.path-obstacle-clearance')
      };
    })
  );

  const runtime = createMaterialHandlingRuntime(model.materialHandling);
  for (const block of materialBlocks) {
    if (block.kind !== 'moveByTransporter') {
      continue;
    }

    try {
      runtime.findShortestRoute(block.fromNodeId, block.toNodeId, block.fleetId);
    } catch (routeError) {
      const fromNode = nodeById.get(block.fromNodeId);
      const toNode = nodeById.get(block.toNodeId);
      diagnostics.push(error('material.route-unreachable', `process.blocks.${block.id}`, routeError instanceof Error ? routeError.message : `MoveByTransporter block ${block.id} route is unreachable`, {
        jsonPointer: blockPointer.get(block.id),
        repairCandidate: fromNode && toNode
          ? proposalPatch([
            {
              op: 'add',
              path: '/materialHandling/paths/-',
              value: {
                id: `${block.fromNodeId}-${block.toNodeId}`,
                from: block.fromNodeId,
                to: block.toNodeId,
                lengthM: Number(distance2dForRepair(fromNode, toNode).toFixed(4)),
                bidirectional: true,
                trafficControl: 'reservation',
                capacity: 1,
                mode: 'path-guided'
              }
            }
          ], `Add a direct path between ${block.fromNodeId} and ${block.toNodeId}. Confirm the aisle exists in the real layout before applying.`)
          : null
      }));
    }
  }

  return diagnostics;
}

function analyzeExperimentSemantics(model: AiNativeDesModelDefinition): ModelDiagnostic[] {
  if (model.experiments.length > 0) {
    return [];
  }

  return [warning('experiment.none', 'experiments', 'Model has no experiments; runner commands need at least one experiment', {
    jsonPointer: '/experiments',
    repairCandidate: safePatch([{ op: 'add', path: '/experiments/-', value: { id: 'baseline', stopTimeSec: 3600, seed: 1 } }], 'Add a default baseline experiment with one hour stop time and deterministic seed.')
  })];
}

function reachableFrom(startIds: string[], outgoing: Map<string, string[]>): Set<string> {
  const visited = new Set<string>();
  const queue = [...startIds];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);
    for (const next of outgoing.get(current) ?? []) {
      queue.push(next);
    }
  }
  return visited;
}

function canReachAnySink(startId: string, sinkIds: Set<string>, outgoing: Map<string, string[]>): boolean {
  return [...reachableFrom([startId], outgoing)].some((blockId) => sinkIds.has(blockId));
}

function hasUpstreamSeizeOrService(
  block: Extract<ProcessFlowBlockDefinition, { kind: 'release' }>,
  blockMap: Map<string, ProcessFlowBlockDefinition>,
  incoming: Map<string, string[]>
): boolean {
  const visited = new Set<string>();
  const queue = [...(incoming.get(block.id) ?? [])];
  while (queue.length > 0) {
    const currentId = queue.shift()!;
    if (visited.has(currentId)) {
      continue;
    }
    visited.add(currentId);
    const current = blockMap.get(currentId);
    if ((current?.kind === 'seize' || current?.kind === 'service') && current.resourcePoolId === block.resourcePoolId) {
      return true;
    }
    queue.push(...(incoming.get(currentId) ?? []));
  }
  return false;
}

function isMaterialBlock(
  block: ProcessFlowBlockDefinition
): block is Extract<ProcessFlowBlockDefinition, { kind: 'moveByTransporter' | 'pickup' | 'dropoff' | 'store' | 'retrieve' | 'convey' }> {
  return (
    block.kind === 'moveByTransporter' ||
    block.kind === 'pickup' ||
    block.kind === 'dropoff' ||
    block.kind === 'store' ||
    block.kind === 'retrieve' ||
    block.kind === 'convey'
  );
}

type DiagnosticOptions = {
  jsonPointer?: string;
  schemaPath?: string;
  humanPath?: string;
  repairCandidate?: ModelRepairCandidate | null;
  risk?: 'safe' | 'needs-confirmation';
};

function error(code: string, path: string, message: string, options: DiagnosticOptions = {}): ModelDiagnostic {
  const repairCandidate = options.repairCandidate ?? null;
  return {
    severity: 'error',
    code,
    path,
    jsonPointer: options.jsonPointer ?? diagnosticPathToPointer(path),
    schemaPath: options.schemaPath ?? path,
    humanPath: options.humanPath ?? path,
    message,
    risk: options.risk ?? (repairCandidate?.requiresUserConfirmation ? 'needs-confirmation' : 'safe'),
    repairCandidate,
    requiresUserConfirmation: repairCandidate?.requiresUserConfirmation ?? false
  };
}

function warning(code: string, path: string, message: string, options: DiagnosticOptions = {}): ModelDiagnostic {
  const repairCandidate = options.repairCandidate ?? null;
  return {
    severity: 'warning',
    code,
    path,
    jsonPointer: options.jsonPointer ?? diagnosticPathToPointer(path),
    schemaPath: options.schemaPath ?? path,
    humanPath: options.humanPath ?? path,
    message,
    risk: options.risk ?? (repairCandidate?.requiresUserConfirmation ? 'needs-confirmation' : 'safe'),
    repairCandidate,
    requiresUserConfirmation: repairCandidate?.requiresUserConfirmation ?? false
  };
}

function safePatch(patch: ModelRepairCandidate['patch'], explanation: string, confidence = 0.95): ModelRepairCandidate {
  return {
    kind: 'jsonPatch',
    safety: 'safeAutoApply',
    confidence,
    requiresUserConfirmation: false,
    patch,
    explanation
  };
}

function proposalPatch(patch: ModelRepairCandidate['patch'], explanation: string, confidence = 0.72): ModelRepairCandidate {
  return {
    kind: 'proposal',
    safety: 'requiresConfirmation',
    confidence,
    requiresUserConfirmation: true,
    patch,
    explanation
  };
}

function pathToJsonPointer(path: Array<string | number>): string {
  if (path.length === 0) {
    return '';
  }
  return `/${path.map((part) => String(part).replace(/~/g, '~0').replace(/\//g, '~1')).join('/')}`;
}

function schemaRepairCandidate(path: Array<string | number>): ModelRepairCandidate | null {
  const pointer = pathToJsonPointer(path);
  const field = String(path.at(-1) ?? '');
  if (field === 'discipline') {
    return safePatch([{ op: 'replace', path: pointer, value: 'fifo' }], 'Queue discipline P0 supports FIFO only; replace the unsupported discipline with fifo.');
  }
  if (field === 'capacity' || field === 'queueCapacity') {
    return safePatch([{ op: 'replace', path: pointer, value: 1 }], 'Replace invalid capacity with the smallest valid positive capacity.');
  }
  if (field === 'reservationDurationSec') {
    return safePatch([{ op: 'replace', path: pointer, value: 0.5 }], 'Replace invalid node reservation duration with the default 0.5 second occupancy window.');
  }
  if (field === 'speedMps') {
    return safePatch([{ op: 'replace', path: pointer, value: 1 }], 'Replace invalid speed with a conservative 1 m/s default.');
  }
  return null;
}

function materialDiagnosticPointer(path: string, pathIndexById: Map<string, number>): string {
  const parts = path.split('.');
  if (parts[0] !== 'materialHandling') {
    return diagnosticPathToPointer(path);
  }
  if (parts[1] === 'paths' && parts[2]) {
    const pathIndex = pathIndexById.get(parts[2]);
    if (pathIndex !== undefined) {
      return `/materialHandling/paths/${pathIndex}${parts.slice(3).map((part) => `/${part.replace(/~/g, '~0').replace(/\//g, '~1')}`).join('')}`;
    }
  }
  return diagnosticPathToPointer(path);
}

function materialDiagnosticRepairCandidate(
  diagnostic: { code: string; message: string },
  model: AiNativeDesModelDefinition,
  pathIndexById: Map<string, number>
): ModelRepairCandidate | null {
  if (diagnostic.code !== 'material.unmodeled-path-crossing' || !model.materialHandling) {
    return null;
  }

  const match = /^Paths (?<left>.+?) and (?<right>.+?) cross geometrically/.exec(diagnostic.message);
  const leftId = match?.groups?.left;
  const rightId = match?.groups?.right;
  if (!leftId || !rightId) {
    return null;
  }

  const left = model.materialHandling.paths.find((path) => path.id === leftId);
  const right = model.materialHandling.paths.find((path) => path.id === rightId);
  const leftIndex = pathIndexById.get(leftId);
  const rightIndex = pathIndexById.get(rightId);
  if (!left || !right || leftIndex === undefined || rightIndex === undefined) {
    return null;
  }

  const nodesById = new Map(model.materialHandling.nodes.map((node) => [node.id, node]));
  const leftFrom = nodesById.get(left.from);
  const leftTo = nodesById.get(left.to);
  const rightFrom = nodesById.get(right.from);
  const rightTo = nodesById.get(right.to);
  if (!leftFrom || !leftTo || !rightFrom || !rightTo) {
    return null;
  }

  const intersection = lineIntersectionForRepair(leftFrom, leftTo, rightFrom, rightTo);
  if (!intersection) {
    return null;
  }

  const intersectionId = `${left.id}-${right.id}-intersection`;
  const leftSplit = splitPathForRepair(left, leftFrom, leftTo, intersectionId, intersection);
  const rightSplit = splitPathForRepair(right, rightFrom, rightTo, intersectionId, intersection);
  const removeIndexes = [leftIndex, rightIndex].sort((a, b) => b - a);
  return proposalPatch([
    {
      op: 'add',
      path: '/materialHandling/nodes/-',
      value: {
        id: intersectionId,
        type: 'intersection',
        x: Number(intersection.x.toFixed(4)),
        z: Number(intersection.z.toFixed(4)),
        capacity: 1,
        reservationDurationSec: 0.5,
        waitAllowed: false
      }
    },
    ...removeIndexes.map((index) => ({ op: 'remove' as const, path: `/materialHandling/paths/${index}` })),
    ...[...leftSplit, ...rightSplit].map((path) => ({ op: 'add' as const, path: '/materialHandling/paths/-', value: path }))
  ], `Split crossing paths ${left.id} and ${right.id} at a proposed intersection node. Confirm the geometry before applying.`, 0.72);
}

function diagnosticPathToPointer(path: string): string {
  if (path === '$') {
    return '';
  }
  return `/${path.replace(/^\$\.?/, '').split('.').filter(Boolean).map((part) => part.replace(/~/g, '~0').replace(/\//g, '~1')).join('/')}`;
}

function distance2dForRepair(
  left: { x: number; z: number },
  right: { x: number; z: number }
): number {
  return Math.hypot(right.x - left.x, right.z - left.z);
}

function lineIntersectionForRepair(
  a: { x: number; z: number },
  b: { x: number; z: number },
  c: { x: number; z: number },
  d: { x: number; z: number }
): { x: number; z: number } | null {
  const denominator = (a.x - b.x) * (c.z - d.z) - (a.z - b.z) * (c.x - d.x);
  if (Math.abs(denominator) < 1e-9) {
    return null;
  }
  const leftCross = a.x * b.z - a.z * b.x;
  const rightCross = c.x * d.z - c.z * d.x;
  return {
    x: (leftCross * (c.x - d.x) - (a.x - b.x) * rightCross) / denominator,
    z: (leftCross * (c.z - d.z) - (a.z - b.z) * rightCross) / denominator
  };
}

function splitPathForRepair(
  path: MaterialPathDefinition,
  fromNode: { x: number; z: number },
  toNode: { x: number; z: number },
  intersectionId: string,
  intersection: { x: number; z: number }
): MaterialPathDefinition[] {
  const common = {
    bidirectional: path.bidirectional,
    speedLimitMps: path.speedLimitMps,
    trafficControl: path.trafficControl,
    capacity: path.capacity,
    mode: path.mode
  };
  return [
    {
      ...common,
      id: `${path.id}-to-${intersectionId}`,
      from: path.from,
      to: intersectionId,
      lengthM: Number(distance2dForRepair(fromNode, intersection).toFixed(4))
    },
    {
      ...common,
      id: `${intersectionId}-to-${path.to}`,
      from: intersectionId,
      to: path.to,
      lengthM: Number(distance2dForRepair(intersection, toNode).toFixed(4))
    }
  ];
}
