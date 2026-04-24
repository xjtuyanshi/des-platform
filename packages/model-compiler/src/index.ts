import { createMaterialHandlingRuntime, type MaterialHandlingRuntime } from '@des-platform/material-handling';
import { createProcessFlowSimulation, runProcessFlow, type ProcessFlowRunResult } from '@des-platform/process-flow';
import {
  AiNativeDesModelDefinitionSchema,
  type AiNativeDesModelDefinition,
  type ExperimentDefinition
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
  stopTimeSec: number;
  warmupSec: number;
  nowSec: number;
  summary: GenericRunSummary;
  eventLog: ProcessFlowRunResult['simulation']['eventLog'];
  snapshot: ProcessFlowRunResult['snapshot'];
};

export type CompiledDesModel = {
  model: AiNativeDesModelDefinition;
  defaultExperiment: ExperimentDefinition | null;
  createRuntime: () => ProcessFlowRunResult;
  createMaterialHandlingRuntime: () => MaterialHandlingRuntime | null;
  runExperiment: (experimentId?: string) => ProcessFlowRunResult;
  runExperimentToResult: (experimentId?: string) => GenericDesRunResult;
};

export function compileDesModel(input: unknown): CompiledDesModel {
  const model = AiNativeDesModelDefinitionSchema.parse(input);
  const defaultExperiment = model.experiments[0] ?? null;

  return {
    model,
    defaultExperiment,
    createRuntime: () =>
      createProcessFlowSimulation(model.process, {
        materialHandling: model.materialHandling ? createMaterialHandlingRuntime(model.materialHandling) : null
      }),
    createMaterialHandlingRuntime: () =>
      model.materialHandling ? createMaterialHandlingRuntime(model.materialHandling) : null,
    runExperiment: (experimentId?: string) => {
      const experiment = resolveExperiment(model, experimentId);
      return runProcessFlow(model.process, experiment.stopTimeSec, experiment.maxEvents, {
        materialHandling: model.materialHandling ? createMaterialHandlingRuntime(model.materialHandling) : null
      });
    },
    runExperimentToResult: (experimentId?: string) => {
      const experiment = resolveExperiment(model, experimentId);
      const run = runProcessFlow(model.process, experiment.stopTimeSec, experiment.maxEvents, {
        materialHandling: model.materialHandling ? createMaterialHandlingRuntime(model.materialHandling) : null
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
