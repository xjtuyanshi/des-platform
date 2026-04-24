import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  analyzeDesModel,
  runDesModelReplicationsToResult,
  runDesModelToResult,
  type GenericDesExperimentResult,
  type ModelDiagnostic,
  type ModelDiagnosticsReport
} from '@des-platform/model-compiler';
import { loadAiNativeDesModel, loadUnknownDefinition } from '@des-platform/shared-schema/loader';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(currentDir, '../../..');
const defaultModelPath = path.join(rootDir, 'config/models/single-server-process.json');

function usage(): string {
  return [
    'Usage:',
    '  pnpm run:model [modelPath] [experimentId] [outputPath]',
    '  pnpm run:experiment [modelPath] [experimentId] [outputPath]',
    '  pnpm validate:model [modelPath] [outputPath]',
    '',
    'Options:',
    '  --experiment Validate and run all replications for an experiment',
    '  --validate   Validate the model and write diagnostics without running it',
    '',
    'Examples:',
    '  pnpm run:model',
    '  pnpm run:model config/models/warehouse-material-flow.json baseline',
    '  pnpm run:experiment config/models/stochastic-single-machine.json seed-20260424',
    '  pnpm run:model config/models/single-server-process.json baseline output/single-server-run.json',
    '  pnpm validate:model config/models/warehouse-material-flow.json'
  ].join('\n');
}

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(usage());
  process.exit(0);
}

const validateOnly = args[0] === '--validate';
const experimentMode = args[0] === '--experiment';
const positionalArgs = validateOnly || experimentMode ? args.slice(1) : args;

if (validateOnly) {
  await validateModel(positionalArgs);
} else if (experimentMode) {
  await runExperiment(positionalArgs);
} else {
  await runModel(positionalArgs);
}

async function runModel(positionalArgs: string[]): Promise<void> {
  const modelPath = path.resolve(rootDir, positionalArgs[0] ?? defaultModelPath);
  const experimentId = positionalArgs[1];
  const model = await loadAiNativeDesModel(modelPath);
  const result = runDesModelToResult(model, experimentId);
  const outputPath = path.resolve(
    rootDir,
    positionalArgs[2] ?? `output/${result.modelId}-${result.experimentId}-run.json`
  );

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');

  console.log(`model=${result.modelId}`);
  console.log(`experiment=${result.experimentId}`);
  console.log(`seed=${result.seed}`);
  printParameterValues(result.parameterValues);
  console.log(`createdEntities=${result.summary.createdEntities}`);
  console.log(`completedEntities=${result.summary.completedEntities}`);
  console.log(`averageCycleTimeSec=${result.summary.averageCycleTimeSec.toFixed(4)}`);
  console.log(`stoppedBy=${result.summary.stoppedBy}`);
  console.log(`output=${outputPath}`);
}

async function runExperiment(positionalArgs: string[]): Promise<void> {
  const modelPath = path.resolve(rootDir, positionalArgs[0] ?? defaultModelPath);
  const experimentId = positionalArgs[1];
  const model = await loadAiNativeDesModel(modelPath);
  const result = runDesModelReplicationsToResult(model, experimentId);
  const outputPath = path.resolve(
    rootDir,
    positionalArgs[2] ?? `output/${result.modelId}-${result.experimentId}-experiment.json`
  );

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');

  printExperimentSummary(result);
  console.log(`output=${outputPath}`);
}

async function validateModel(positionalArgs: string[]): Promise<void> {
  const modelPath = path.resolve(rootDir, positionalArgs[0] ?? defaultModelPath);
  const modelStem = path.basename(modelPath, path.extname(modelPath));
  const outputPath = path.resolve(rootDir, positionalArgs[1] ?? `output/${modelStem}-diagnostics.json`);
  const report = await loadAndAnalyzeModel(modelPath);

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  console.log(`valid=${report.valid}`);
  console.log(`errors=${report.errors.length}`);
  console.log(`warnings=${report.warnings.length}`);
  for (const diagnostic of report.diagnostics) {
    console.log(`${diagnostic.severity.toUpperCase()} ${diagnostic.code} ${diagnostic.path} ${diagnostic.message}`);
  }
  console.log(`output=${outputPath}`);

  if (!report.valid) {
    process.exitCode = 1;
  }
}

async function loadAndAnalyzeModel(modelPath: string): Promise<ModelDiagnosticsReport> {
  try {
    return analyzeDesModel(await loadUnknownDefinition(modelPath));
  } catch (loadError) {
    return unreadableModelReport(modelPath, loadError);
  }
}

function unreadableModelReport(modelPath: string, loadError: unknown): ModelDiagnosticsReport {
  const message = loadError instanceof Error ? loadError.message : String(loadError);
  const diagnostic: ModelDiagnostic = {
    severity: 'error',
    code: 'model.unreadable',
    path: '$',
    message: `Unable to read ${modelPath}: ${message}`
  };
  return {
    valid: false,
    errors: [diagnostic],
    warnings: [],
    diagnostics: [diagnostic]
  };
}

function printExperimentSummary(result: GenericDesExperimentResult): void {
  console.log(`model=${result.modelId}`);
  console.log(`experiment=${result.experimentId}`);
  console.log(`replications=${result.replications}`);
  console.log(`baseSeed=${result.baseSeed}`);
  console.log(`seedStride=${result.seedStride}`);
  printParameterValues(result.parameterValues);
  console.log(`completedEntities.mean=${result.metricStats.completedEntities.mean.toFixed(4)}`);
  console.log(`averageCycleTimeSec.mean=${result.metricStats.averageCycleTimeSec.mean.toFixed(4)}`);
  console.log(`averageCycleTimeSec.halfWidth95=${result.metricStats.averageCycleTimeSec.halfWidth95.toFixed(4)}`);
}

function printParameterValues(parameterValues: Record<string, unknown>): void {
  if (Object.keys(parameterValues).length === 0) {
    return;
  }

  console.log(`parameters=${JSON.stringify(parameterValues)}`);
}
