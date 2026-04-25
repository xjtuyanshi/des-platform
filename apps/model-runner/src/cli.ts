import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  analyzeDesModel,
  runDesModelReplicationsToResult,
  runDesModelSweepToResult,
  runDesModelToResult,
  type GenericDesExperimentResult,
  type GenericDesSweepResult,
  type ModelDiagnostic,
  type ModelDiagnosticsReport
} from '@des-platform/model-compiler';
import type { AiNativeDesModelDefinition } from '@des-platform/shared-schema/model-dsl';
import type { StudyOperationDefinition, SimulationStudyCaseDefinition } from '@des-platform/shared-schema/study';
import { loadAiNativeDesModel, loadSimulationStudyCase, loadUnknownDefinition } from '@des-platform/shared-schema/loader';
import { renderGenericDesReport, type GenericDesReportInput } from 'reporting/generic';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(currentDir, '../../..');
const defaultModelPath = path.join(rootDir, 'config/models/single-server-process.json');
const defaultStudyPath = path.join(rootDir, 'config/studies/fulfillment-center-mvp.study.json');

type StudyArtifactKind = 'model' | 'diagnostics' | 'run' | 'experiment' | 'sweep' | 'html-report' | 'manifest';

type StudyArtifact = {
  kind: StudyArtifactKind;
  path: string;
  experimentId?: string;
};

type StudyManifest = {
  schemaVersion: 'des-platform.study-result.v1';
  studyId: string;
  studyName: string;
  modelPath: string;
  outputDir: string;
  valid: boolean;
  errors: number;
  warnings: number;
  artifacts: StudyArtifact[];
};

type PreparedStudyModel = {
  modelPath: string;
  inlineModel: AiNativeDesModelDefinition | null;
};

function usage(): string {
  return [
    'Usage:',
    '  pnpm run:model [modelPath] [experimentId] [outputPath]',
    '  pnpm run:experiment [modelPath] [experimentId] [outputPath]',
    '  pnpm run:sweep [modelPath] [experimentId] [outputPath]',
    '  pnpm run:study [studyPath] [outputDir]',
    '  pnpm validate:model [modelPath] [outputPath]',
    '',
    'Options:',
    '  --experiment Validate and run all replications for an experiment',
    '  --sweep      Run every parameter sweep case and replication for an experiment',
    '  --study      Run one study case end-to-end and write a manifest',
    '  --validate   Validate the model and write diagnostics without running it',
    '',
    'Examples:',
    '  pnpm run:model',
    '  pnpm run:model config/models/warehouse-material-flow.json baseline',
    '  pnpm run:experiment config/models/stochastic-single-machine.json seed-20260424',
    '  pnpm run:sweep config/models/stochastic-single-machine.json arrival-service-sweep',
    '  pnpm run:study config/studies/fulfillment-center-mvp.study.json',
    '  pnpm run:study config/studies/micro-fulfillment-inline.study.json',
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
const sweepMode = args[0] === '--sweep';
const studyMode = args[0] === '--study';
const positionalArgs = validateOnly || experimentMode || sweepMode || studyMode ? args.slice(1) : args;

if (validateOnly) {
  await validateModel(positionalArgs);
} else if (experimentMode) {
  await runExperiment(positionalArgs);
} else if (sweepMode) {
  await runSweep(positionalArgs);
} else if (studyMode) {
  await runStudy(positionalArgs);
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

async function runSweep(positionalArgs: string[]): Promise<void> {
  const modelPath = path.resolve(rootDir, positionalArgs[0] ?? defaultModelPath);
  const experimentId = positionalArgs[1];
  const model = await loadAiNativeDesModel(modelPath);
  const result = runDesModelSweepToResult(model, experimentId);
  const outputPath = path.resolve(
    rootDir,
    positionalArgs[2] ?? `output/${result.modelId}-${result.experimentId}-sweep.json`
  );

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');

  printSweepSummary(result);
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

async function runStudy(positionalArgs: string[]): Promise<void> {
  const studyPath = path.resolve(rootDir, positionalArgs[0] ?? defaultStudyPath);
  const study = await loadSimulationStudyCase(studyPath);
  const outputDir = path.resolve(rootDir, positionalArgs[1] ?? study.outputDir ?? `output/studies/${study.id}`);
  const artifacts: StudyArtifact[] = [];
  let diagnostics: ModelDiagnosticsReport | null = null;

  await mkdir(outputDir, { recursive: true });
  const preparedModel = await prepareStudyModel(study, studyPath, outputDir, artifacts);

  if (study.validate) {
    diagnostics = preparedModel.inlineModel
      ? analyzeDesModel(preparedModel.inlineModel)
      : await loadAndAnalyzeModel(preparedModel.modelPath);
    const diagnosticsPath = path.join(outputDir, 'diagnostics.json');
    await writeJsonFile(diagnosticsPath, diagnostics);
    artifacts.push({ kind: 'diagnostics', path: diagnosticsPath });

    if (!diagnostics.valid && study.failOnValidationError) {
      const manifestPath = path.join(outputDir, 'manifest.json');
      artifacts.push({ kind: 'manifest', path: manifestPath });
      const manifest = buildStudyManifest(study, preparedModel.modelPath, outputDir, diagnostics, artifacts);
      await writeJsonFile(manifestPath, manifest);
      printStudySummary(study, manifest, manifestPath);
      process.exitCode = 1;
      return;
    }
  }

  const model = preparedModel.inlineModel ?? await loadAiNativeDesModel(preparedModel.modelPath);

  for (const operation of study.runs) {
    const result = runDesModelToResult(model, operation.experimentId);
    const outputPath = path.join(outputDir, `${studyArtifactStem(model.id, operation, 'run')}.json`);
    await writeStudyResult(outputPath, result, operation, 'run', artifacts);
  }

  for (const operation of study.replications) {
    const result = runDesModelReplicationsToResult(model, operation.experimentId);
    const outputPath = path.join(outputDir, `${studyArtifactStem(model.id, operation, 'experiment')}.json`);
    await writeStudyResult(outputPath, result, operation, 'experiment', artifacts);
  }

  for (const operation of study.sweeps) {
    const result = runDesModelSweepToResult(model, operation.experimentId);
    const outputPath = path.join(outputDir, `${studyArtifactStem(model.id, operation, 'sweep')}.json`);
    await writeStudyResult(outputPath, result, operation, 'sweep', artifacts);
  }

  const manifestPath = path.join(outputDir, 'manifest.json');
  artifacts.push({ kind: 'manifest', path: manifestPath });
  const manifest = buildStudyManifest(study, preparedModel.modelPath, outputDir, diagnostics, artifacts);
  await writeJsonFile(manifestPath, manifest);
  printStudySummary(study, manifest, manifestPath);
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

async function prepareStudyModel(
  study: SimulationStudyCaseDefinition,
  studyPath: string,
  outputDir: string,
  artifacts: StudyArtifact[]
): Promise<PreparedStudyModel> {
  if (study.model) {
    const modelPath = path.join(outputDir, 'model.json');
    await writeJsonFile(modelPath, study.model);
    artifacts.push({ kind: 'model', path: modelPath });
    return {
      modelPath,
      inlineModel: study.model
    };
  }

  if (!study.modelPath) {
    throw new Error(`Study ${study.id} must define modelPath or an inline model`);
  }

  return {
    modelPath: path.resolve(path.dirname(studyPath), study.modelPath),
    inlineModel: null
  };
}

async function writeStudyResult(
  outputPath: string,
  result: GenericDesReportInput,
  operation: StudyOperationDefinition,
  kind: 'run' | 'experiment' | 'sweep',
  artifacts: StudyArtifact[]
): Promise<void> {
  await writeJsonFile(outputPath, result);
  artifacts.push({ kind, path: outputPath, experimentId: result.experimentId });

  if (operation.htmlReport) {
    const htmlPath = outputPath.replace(/\.json$/i, '.html');
    await writeFile(htmlPath, renderGenericDesReport(result), 'utf8');
    artifacts.push({ kind: 'html-report', path: htmlPath, experimentId: result.experimentId });
  }
}

async function writeJsonFile(outputPath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function buildStudyManifest(
  study: SimulationStudyCaseDefinition,
  modelPath: string,
  outputDir: string,
  diagnostics: ModelDiagnosticsReport | null,
  artifacts: StudyArtifact[]
): StudyManifest {
  return {
    schemaVersion: 'des-platform.study-result.v1',
    studyId: study.id,
    studyName: study.name,
    modelPath,
    outputDir,
    valid: diagnostics?.valid ?? true,
    errors: diagnostics?.errors.length ?? 0,
    warnings: diagnostics?.warnings.length ?? 0,
    artifacts: [...artifacts]
  };
}

function studyArtifactStem(
  modelId: string,
  operation: StudyOperationDefinition,
  suffix: 'run' | 'experiment' | 'sweep'
): string {
  return safeFileName(operation.outputName ?? `${modelId}-${operation.experimentId}-${suffix}`);
}

function safeFileName(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'artifact';
}

function printStudySummary(study: SimulationStudyCaseDefinition, manifest: StudyManifest, manifestPath: string): void {
  console.log(`study=${study.id}`);
  console.log(`name=${study.name}`);
  console.log(`valid=${manifest.valid}`);
  console.log(`errors=${manifest.errors}`);
  console.log(`warnings=${manifest.warnings}`);
  console.log(`artifacts=${manifest.artifacts.length}`);
  console.log(`outputDir=${manifest.outputDir}`);
  console.log(`manifest=${manifestPath}`);
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

function printSweepSummary(result: GenericDesSweepResult): void {
  console.log(`model=${result.modelId}`);
  console.log(`experiment=${result.experimentId}`);
  console.log(`cases=${result.caseCount}`);
  console.log(`replications=${result.replications}`);
  console.log(`baseSeed=${result.baseSeed}`);
  console.log(`sweepParameters=${result.sweepParameters.join(',') || 'none'}`);
  const bestCase = [...result.cases].sort(
    (left, right) => left.metricStats.averageCycleTimeSec.mean - right.metricStats.averageCycleTimeSec.mean
  )[0];
  if (bestCase) {
    console.log(`bestCase=${bestCase.caseIndex}`);
    printParameterValues(bestCase.parameterValues);
    console.log(`best.averageCycleTimeSec.mean=${bestCase.metricStats.averageCycleTimeSec.mean.toFixed(4)}`);
  }
}

function printParameterValues(parameterValues: Record<string, unknown>): void {
  if (Object.keys(parameterValues).length === 0) {
    return;
  }

  console.log(`parameters=${JSON.stringify(parameterValues)}`);
}
