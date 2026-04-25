import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AiNativeDesLibraryCatalog } from './library-catalog.js';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const outputDir = path.resolve(currentDir, '../../../config/catalog');
const outputPath = path.join(outputDir, 'des-library-catalog.json');

await mkdir(outputDir, { recursive: true });
await writeFile(outputPath, `${JSON.stringify(AiNativeDesLibraryCatalog, null, 2)}\n`, 'utf8');

console.log(`Wrote AI-native DES library catalog to ${outputPath}`);
