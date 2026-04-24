import { createMaterialHandlingRuntime, type MaterialHandlingRuntime } from '@des-platform/material-handling';
import { createProcessFlowSimulation, runProcessFlow, type ProcessFlowRunResult } from '@des-platform/process-flow';
import {
  AiNativeDesModelDefinitionSchema,
  type AiNativeDesModelDefinition,
  type ExperimentDefinition,
  type ProcessFlowBlockDefinition
} from '@des-platform/shared-schema/model-dsl';

export type GenericRunEntitySummary = {
  id: string;
  type: string;
  createdAtSec: number;
  completedAtSec: number | null;
  cycleTimeSec: number | null;
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
  nowSec: number;
  summary: GenericRunSummary;
  eventLog: ProcessFlowRunResult['simulation']['eventLog'];
  snapshot: ProcessFlowRunResult['snapshot'];
};

export type ModelDiagnosticSeverity = 'error' | 'warning';

export type ModelDiagnostic = {
  severity: ModelDiagnosticSeverity;
  code: string;
  path: string;
  message: string;
};

export type ModelDiagnosticsReport = {
  valid: boolean;
  errors: ModelDiagnostic[];
  warnings: ModelDiagnostic[];
  diagnostics: ModelDiagnostic[];
};

export type CompiledDesModel = {
  model: AiNativeDesModelDefinition;
  defaultExperiment: ExperimentDefinition | null;
  createRuntime: () => ProcessFlowRunResult;
  createMaterialHandlingRuntime: () => MaterialHandlingRuntime | null;
  runExperiment: (experimentId?: string) => ProcessFlowRunResult;
  runExperimentToResult: (experimentId?: string) => GenericDesRunResult;
};

export function analyzeDesModel(input: unknown): ModelDiagnosticsReport {
  const parsed = AiNativeDesModelDefinitionSchema.safeParse(input);
  if (!parsed.success) {
    return buildDiagnosticsReport(parsed.error.issues.map(zodIssueToDiagnostic));
  }

  return buildDiagnosticsReport([
    ...analyzeProcessGraph(parsed.data),
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
      createProcessFlowSimulation(model.process, {
        materialHandling: model.materialHandling ? createMaterialHandlingRuntime(model.materialHandling) : null,
        seed: defaultExperiment?.seed
      }),
    createMaterialHandlingRuntime: () =>
      model.materialHandling ? createMaterialHandlingRuntime(model.materialHandling) : null,
    runExperiment: (experimentId?: string) => {
      const experiment = resolveExperiment(model, experimentId);
      return runProcessFlow(model.process, experiment.stopTimeSec, experiment.maxEvents, {
        materialHandling: model.materialHandling ? createMaterialHandlingRuntime(model.materialHandling) : null,
        seed: experiment.seed
      });
    },
    runExperimentToResult: (experimentId?: string) => {
      const experiment = resolveExperiment(model, experimentId);
      const run = runProcessFlow(model.process, experiment.stopTimeSec, experiment.maxEvents, {
        materialHandling: model.materialHandling ? createMaterialHandlingRuntime(model.materialHandling) : null,
        seed: experiment.seed
      });
      return buildGenericRunResult(model, experiment, run);
    }
  };
}

export function runDesModel(input: unknown, experimentId?: string): ProcessFlowRunResult {
  return compileDesModel(input).runExperiment(experimentId);
}

export function runDesModelToResult(input: unknown, experimentId?: string): GenericDesRunResult {
  return compileDesModel(input).runExperimentToResult(experimentId);
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
  run: ProcessFlowRunResult
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
    seed: experiment.seed,
    stopTimeSec: experiment.stopTimeSec,
    warmupSec: experiment.warmupSec,
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
      entities
    },
    eventLog: run.simulation.eventLog,
    snapshot: run.snapshot
  };
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
  return {
    severity: 'error',
    code: 'schema.invalid',
    path: issue.path.length === 0 ? '$' : issue.path.join('.'),
    message: issue.message
  };
}

function analyzeProcessGraph(model: AiNativeDesModelDefinition): ModelDiagnostic[] {
  const diagnostics: ModelDiagnostic[] = [];
  const blocks = model.process.blocks;
  const blockMap = new Map(blocks.map((block) => [block.id, block]));
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
    diagnostics.push(error('process.no-source', 'process.blocks', 'Process must define at least one source block'));
  }
  if (sinkIds.length === 0) {
    diagnostics.push(error('process.no-sink', 'process.blocks', 'Process should define at least one sink block'));
  }

  const reachable = reachableFrom(sourceIds, outgoing);
  for (const block of blocks) {
    if (!reachable.has(block.id)) {
      diagnostics.push(warning('process.unreachable-block', `process.blocks.${block.id}`, `Block ${block.id} is not reachable from any source`));
    }

    if (block.kind !== 'sink' && (outgoing.get(block.id)?.length ?? 0) === 0) {
      diagnostics.push(error('process.dead-end', `process.blocks.${block.id}`, `Block ${block.id} has no outgoing connection`));
    }

    if (block.kind !== 'source' && block.kind !== 'sink' && (incoming.get(block.id)?.length ?? 0) === 0) {
      diagnostics.push(warning('process.no-incoming', `process.blocks.${block.id}`, `Block ${block.id} has no incoming connection`));
    }

    if (block.kind === 'selectOutput' && !(model.process.connections.some((connection) => connection.from === block.id && !connection.condition))) {
      diagnostics.push(warning('process.select-no-fallback', `process.blocks.${block.id}`, `SelectOutput block ${block.id} has no unconditional fallback branch`));
    }
  }

  for (const sourceId of sourceIds) {
    if (!canReachAnySink(sourceId, new Set(sinkIds), outgoing)) {
      diagnostics.push(error('process.source-cannot-reach-sink', `process.blocks.${sourceId}`, `Source ${sourceId} cannot reach any sink block`));
    }
  }

  for (const sinkId of sinkIds) {
    if ((incoming.get(sinkId)?.length ?? 0) === 0) {
      diagnostics.push(warning('process.unused-sink', `process.blocks.${sinkId}`, `Sink ${sinkId} has no incoming connection`));
    }
  }

  for (const block of blocks) {
    if (block.kind === 'release' && !hasUpstreamSeizeOrService(block, blockMap, incoming)) {
      diagnostics.push(warning('process.release-without-upstream-hold', `process.blocks.${block.id}`, `Release block ${block.id} has no upstream seize/service for ${block.resourcePoolId}`));
    }
  }

  return diagnostics;
}

function analyzeMaterialHandlingSemantics(model: AiNativeDesModelDefinition): ModelDiagnostic[] {
  const diagnostics: ModelDiagnostic[] = [];
  const materialBlocks = model.process.blocks.filter(isMaterialBlock);
  if (!model.materialHandling) {
    return diagnostics;
  }

  if (materialBlocks.length === 0) {
    diagnostics.push(warning('material.unused-layout', 'materialHandling', 'materialHandling is defined but no material handling process blocks use it'));
  }

  const runtime = createMaterialHandlingRuntime(model.materialHandling);
  for (const block of materialBlocks) {
    if (block.kind !== 'moveByTransporter') {
      continue;
    }

    try {
      runtime.findShortestRoute(block.fromNodeId, block.toNodeId, block.fleetId);
    } catch (routeError) {
      diagnostics.push(error('material.route-unreachable', `process.blocks.${block.id}`, routeError instanceof Error ? routeError.message : `MoveByTransporter block ${block.id} route is unreachable`));
    }
  }

  return diagnostics;
}

function analyzeExperimentSemantics(model: AiNativeDesModelDefinition): ModelDiagnostic[] {
  if (model.experiments.length > 0) {
    return [];
  }

  return [warning('experiment.none', 'experiments', 'Model has no experiments; runner commands need at least one experiment')];
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

function isMaterialBlock(block: ProcessFlowBlockDefinition): block is Extract<ProcessFlowBlockDefinition, { kind: 'moveByTransporter' | 'store' | 'retrieve' | 'convey' }> {
  return block.kind === 'moveByTransporter' || block.kind === 'store' || block.kind === 'retrieve' || block.kind === 'convey';
}

function error(code: string, path: string, message: string): ModelDiagnostic {
  return {
    severity: 'error',
    code,
    path,
    message
  };
}

function warning(code: string, path: string, message: string): ModelDiagnostic {
  return {
    severity: 'warning',
    code,
    path,
    message
  };
}
