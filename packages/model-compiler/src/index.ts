import { createProcessFlowSimulation, runProcessFlow, type ProcessFlowRunResult } from '@des-platform/process-flow';
import {
  AiNativeDesModelDefinitionSchema,
  type AiNativeDesModelDefinition,
  type ExperimentDefinition
} from '@des-platform/shared-schema/model-dsl';

export type CompiledDesModel = {
  model: AiNativeDesModelDefinition;
  defaultExperiment: ExperimentDefinition | null;
  createRuntime: () => ProcessFlowRunResult;
  runExperiment: (experimentId?: string) => ProcessFlowRunResult;
};

export function compileDesModel(input: unknown): CompiledDesModel {
  const model = AiNativeDesModelDefinitionSchema.parse(input);
  const defaultExperiment = model.experiments[0] ?? null;

  return {
    model,
    defaultExperiment,
    createRuntime: () => createProcessFlowSimulation(model.process),
    runExperiment: (experimentId?: string) => {
      const experiment = resolveExperiment(model, experimentId);
      return runProcessFlow(model.process, experiment.stopTimeSec, experiment.maxEvents);
    }
  };
}

export function runDesModel(input: unknown, experimentId?: string): ProcessFlowRunResult {
  return compileDesModel(input).runExperiment(experimentId);
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
