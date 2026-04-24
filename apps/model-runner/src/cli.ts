import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runDesModelToResult } from '@des-platform/model-compiler';
import { loadAiNativeDesModel } from '@des-platform/shared-schema/loader';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(currentDir, '../../..');
const defaultModelPath = path.join(rootDir, 'config/models/single-server-process.json');

function usage(): string {
  return [
    'Usage: pnpm run:model [modelPath] [experimentId] [outputPath]',
    '',
    'Examples:',
    '  pnpm run:model',
    '  pnpm run:model config/models/warehouse-material-flow.json baseline',
    '  pnpm run:model config/models/single-server-process.json baseline output/single-server-run.json'
  ].join('\n');
}

const modelPathArg = process.argv[2];
if (modelPathArg === '--help' || modelPathArg === '-h') {
  console.log(usage());
  process.exit(0);
}

const modelPath = path.resolve(rootDir, modelPathArg ?? defaultModelPath);
const experimentId = process.argv[3];
const model = await loadAiNativeDesModel(modelPath);
const result = runDesModelToResult(model, experimentId);
const outputPath = path.resolve(
  rootDir,
  process.argv[4] ?? `output/${result.modelId}-${result.experimentId}-run.json`
);

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');

console.log(`model=${result.modelId}`);
console.log(`experiment=${result.experimentId}`);
console.log(`createdEntities=${result.summary.createdEntities}`);
console.log(`completedEntities=${result.summary.completedEntities}`);
console.log(`averageCycleTimeSec=${result.summary.averageCycleTimeSec.toFixed(4)}`);
console.log(`stoppedBy=${result.summary.stoppedBy}`);
console.log(`output=${outputPath}`);
