import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeJsonSchemas } from './loader.js';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const outputDir = path.resolve(currentDir, '../../../config/schemas');

await writeJsonSchemas(outputDir);
console.log(`Wrote JSON schemas to ${outputDir}`);
