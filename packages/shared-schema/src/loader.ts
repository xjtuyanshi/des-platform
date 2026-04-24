import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import YAML from 'yaml';
import { zodToJsonSchema } from 'zod-to-json-schema';

import {
  EventLogEntrySchema,
  KpiSummarySchema,
  LayoutDefinitionSchema,
  ScenarioDefinitionSchema,
  SimulationResultSchema,
  WorldSnapshotSchema,
  type LayoutDefinition,
  type ScenarioDefinition
} from './schemas.js';
import {
  AiNativeDesModelDefinitionSchema,
  ProcessFlowDefinitionSchema,
  type AiNativeDesModelDefinition,
  type ProcessFlowDefinition
} from './model-dsl.js';

function parseByExtension(filePath: string, raw: string): unknown {
  if (filePath.endsWith('.yaml') || filePath.endsWith('.yml')) {
    return YAML.parse(raw);
  }

  return JSON.parse(raw);
}

export async function loadLayoutDefinition(layoutPath: string): Promise<LayoutDefinition> {
  const raw = await readFile(layoutPath, 'utf8');
  return LayoutDefinitionSchema.parse(parseByExtension(layoutPath, raw));
}

export async function loadScenarioDefinition(scenarioPath: string): Promise<ScenarioDefinition> {
  const raw = await readFile(scenarioPath, 'utf8');
  return ScenarioDefinitionSchema.parse(parseByExtension(scenarioPath, raw));
}

export async function loadProcessFlowDefinition(flowPath: string): Promise<ProcessFlowDefinition> {
  const raw = await readFile(flowPath, 'utf8');
  return ProcessFlowDefinitionSchema.parse(parseByExtension(flowPath, raw));
}

export async function loadAiNativeDesModel(modelPath: string): Promise<AiNativeDesModelDefinition> {
  const raw = await readFile(modelPath, 'utf8');
  return AiNativeDesModelDefinitionSchema.parse(parseByExtension(modelPath, raw));
}

export async function loadScenarioBundle(scenarioPath: string): Promise<{ scenario: ScenarioDefinition; layout: LayoutDefinition; resolvedLayoutPath: string }> {
  const scenario = await loadScenarioDefinition(scenarioPath);
  const resolvedLayoutPath = path.resolve(path.dirname(scenarioPath), scenario.layoutPath);
  const layout = await loadLayoutDefinition(resolvedLayoutPath);
  return { scenario, layout, resolvedLayoutPath };
}

export async function listScenarioBundles(scenariosDir: string): Promise<
  Array<{ scenario: ScenarioDefinition; layout: LayoutDefinition; scenarioPath: string; resolvedLayoutPath: string }>
> {
  const entries = await readdir(scenariosDir, { withFileTypes: true });
  const scenarioPaths = entries
    .filter((entry) => entry.isFile() && /\.(ya?ml|json)$/i.test(entry.name))
    .map((entry) => path.join(scenariosDir, entry.name))
    .sort((left, right) => left.localeCompare(right));

  return Promise.all(
    scenarioPaths.map(async (scenarioPath) => {
      const bundle = await loadScenarioBundle(scenarioPath);
      return {
        ...bundle,
        scenarioPath
      };
    })
  );
}

export async function writeJsonSchemas(outputDir: string): Promise<void> {
  await mkdir(outputDir, { recursive: true });

  const files = [
    ['layout.schema.json', zodToJsonSchema(LayoutDefinitionSchema, 'LayoutDefinition')],
    ['scenario.schema.json', zodToJsonSchema(ScenarioDefinitionSchema, 'ScenarioDefinition')],
    ['kpi.schema.json', zodToJsonSchema(KpiSummarySchema, 'KpiSummary')],
    ['snapshot.schema.json', zodToJsonSchema(WorldSnapshotSchema, 'WorldSnapshot')],
    ['event-log.schema.json', zodToJsonSchema(EventLogEntrySchema, 'EventLogEntry')],
    ['simulation-result.schema.json', zodToJsonSchema(SimulationResultSchema, 'SimulationResult')],
    ['process-flow.schema.json', zodToJsonSchema(ProcessFlowDefinitionSchema, 'ProcessFlowDefinition')],
    ['model-dsl.schema.json', zodToJsonSchema(AiNativeDesModelDefinitionSchema, 'AiNativeDesModelDefinition')]
  ] as const;

  await Promise.all(
    files.map(([fileName, schema]) =>
      writeFile(path.join(outputDir, fileName), `${JSON.stringify(schema, null, 2)}\n`, 'utf8')
    )
  );
}
