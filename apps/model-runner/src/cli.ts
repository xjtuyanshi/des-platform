import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyzeDesModel, runDesModelToResult, type ModelDiagnostic, type ModelDiagnosticsReport } from '@des-platform/model-compiler';
import { loadAiNativeDesModel, loadUnknownDefinition } from '@des-platform/shared-schema/loader';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(currentDir, '../../..');
const defaultModelPath = path.join(rootDir, 'config/models/single-server-process.json');

function usage(): string {
  return [
    'Usage:',
    '  pnpm run:model [modelPath] [experimentId] [outputPath]',
    '  pnpm validate:model [modelPath] [outputPath]',
    '',
    'Options:',
    '  --validate   Validate the model and write diagnostics without running it',
    '',
    'Examples:',
    '  pnpm run:model',
    '  pnpm run:model config/models/warehouse-material-flow.json baseline',
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
const positionalArgs = validateOnly ? args.slice(1) : args;

if (validateOnly) {
  await validateModel(positionalArgs);
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
  console.log(`createdEntities=${result.summary.createdEntities}`);
  console.log(`completedEntities=${result.summary.completedEntities}`);
  console.log(`averageCycleTimeSec=${result.summary.averageCycleTimeSec.toFixed(4)}`);
  console.log(`stoppedBy=${result.summary.stoppedBy}`);
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
