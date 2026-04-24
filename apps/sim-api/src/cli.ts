import { DEFAULT_SCENARIO_ID, persistScenarioArtifacts } from './runtime.js';

const scenarioId = process.argv[2] ?? DEFAULT_SCENARIO_ID;

await persistScenarioArtifacts(scenarioId);
console.log(`Scenario artifacts generated for ${scenarioId}.`);
