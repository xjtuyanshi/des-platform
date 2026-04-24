import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { listScenarioBundles } from '@des-platform/shared-schema/loader';
import { runSimulation } from '@des-platform/simulation-core';

import { renderReport } from './index.js';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(currentDir, '../../..');
const outputDir = path.join(rootDir, 'output');
const scenariosDir = path.join(rootDir, 'config/scenarios');
const defaultScenarioId = 'baseline-90-uph';

function buildValidationText(result: Awaited<ReturnType<typeof runSimulation>>): string {
  const { kpis, validation } = result;
  return [
    `scenario=${result.scenarioId}`,
    `steadyStateCycleSec=${kpis.steadyStateCycleSec.toFixed(4)}`,
    `steadyStateUph=${kpis.steadyStateUph.toFixed(4)}`,
    `actualAverageUph=${kpis.actualAverageUph.toFixed(4)}`,
    `lineDowntimeSec=${kpis.lineDowntimeSec.toFixed(4)}`,
    `starvationSec=${kpis.starvationSec.toFixed(4)}`,
    `completedCars=${kpis.completedCars}`,
    `totalAmrDistanceM=${kpis.totalAmrDistanceM.toFixed(4)}`,
    `baselinePass=${kpis.baselinePass}`,
    `validationPass=${validation.passed}`,
    ...validation.checks.map((check) => `${check.id}=${check.passed ? 'PASS' : 'FAIL'} ${check.detail}`)
  ].join('\n');
}

function getArtifactPrefixes(scenarioId: string): string[] {
  return scenarioId === defaultScenarioId ? [scenarioId, 'baseline'] : [scenarioId];
}

const requestedScenarioId = process.argv[2] ?? defaultScenarioId;
const bundles = await listScenarioBundles(scenariosDir);
const selectedBundle = bundles.find((bundle) => bundle.scenario.id === requestedScenarioId);

if (!selectedBundle) {
  throw new Error(`Unknown scenario: ${requestedScenarioId}`);
}

const { scenario, layout } = selectedBundle;
const result = await runSimulation(
  {
    ...scenario,
    snapshotIntervalSec: 10
  },
  layout
);

const summary = {
  scenarioId: result.scenarioId,
  layoutId: result.layoutId,
  kpis: result.kpis,
  validation: result.validation
};

await mkdir(outputDir, { recursive: true });

for (const artifactPrefix of getArtifactPrefixes(result.scenarioId)) {
  await writeFile(path.join(outputDir, `${artifactPrefix}-report.html`), renderReport(result), 'utf8');
  await writeFile(path.join(outputDir, `${artifactPrefix}-summary.json`), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  await writeFile(path.join(outputDir, `${artifactPrefix}-validation.txt`), `${buildValidationText(result)}\n`, 'utf8');
}

console.log(`Wrote report assets for ${result.scenarioId} to ${outputDir}`);
