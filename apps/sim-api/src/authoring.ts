import { analyzeDesModel, type ModelDiagnostic, type ModelDiagnosticsReport } from '@des-platform/model-compiler';
import {
  AiNativeDesModelDefinitionSchema,
  type AiNativeDesModelDefinition,
  type ProcessFlowBlockDefinition
} from '@des-platform/shared-schema/model-dsl';
import {
  SimulationStudyCaseDefinitionSchema,
  type SimulationStudyCaseDefinition
} from '@des-platform/shared-schema/study';

export type AuthoringDiagnostic = ModelDiagnostic & {
  source: 'schema' | 'model' | 'repair';
};

export type AuthoringDiagnoseResult = {
  valid: boolean;
  schemaValid: boolean;
  modelValid: boolean;
  study: SimulationStudyCaseDefinition | null;
  modelDiagnostics: ModelDiagnosticsReport | null;
  diagnostics: AuthoringDiagnostic[];
};

export type DraftStudyResult = AuthoringDiagnoseResult & {
  provider: 'rules' | 'openai';
  notes: string[];
};

type DraftRequest = {
  brief?: string;
  constraints?: Record<string, unknown>;
  provider?: 'auto' | 'rules' | 'openai';
};

type RepairRequest = {
  study?: unknown;
  brief?: string;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function slugify(value: string, fallback: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || fallback;
}

function issuePath(path: Array<string | number>): string {
  return path.length === 0 ? '$' : `$.${path.map(String).join('.')}`;
}

function schemaDiagnostics(error: { issues: Array<{ path: Array<string | number>; message: string }> }): AuthoringDiagnostic[] {
  return error.issues.map((issue) => ({
    source: 'schema',
    severity: 'error',
    code: 'schema.invalid',
    path: issuePath(issue.path),
    message: issue.message
  }));
}

function normalizeStudyInput(input: unknown): SimulationStudyCaseDefinition {
  const payload = asRecord(input);
  const candidate = 'study' in payload ? payload.study : payload;
  const object = asRecord(candidate);

  if (object.schemaVersion === 'des-platform.v1' || ('process' in object && !('model' in object))) {
    const model = repairModelShape(object);
    const experimentId = model.experiments[0]?.id ?? 'baseline';
    return SimulationStudyCaseDefinitionSchema.parse({
      schemaVersion: 'des-platform.study.v1',
      id: model.id,
      name: `${model.name} Study`,
      description: model.description,
      model,
      runs: [{ experimentId, outputName: `${experimentId}-run`, htmlReport: true }],
      metadata: { source: 'authoring-normalize' }
    });
  }

  return SimulationStudyCaseDefinitionSchema.parse(object);
}

function repairModelShape(input: Record<string, unknown>): AiNativeDesModelDefinition {
  const model = {
    schemaVersion: 'des-platform.v1',
    id: typeof input.id === 'string' ? input.id : 'authored-model',
    name: typeof input.name === 'string' ? input.name : 'Authored Model',
    description: typeof input.description === 'string' ? input.description : '',
    parameters: Array.isArray(input.parameters) ? input.parameters : [],
    process: input.process,
    materialHandling: input.materialHandling,
    experiments: Array.isArray(input.experiments) && input.experiments.length > 0
      ? input.experiments
      : [{ id: 'baseline', name: 'Baseline', seed: 20260425, stopTimeSec: 1800 }],
    metadata: asRecord(input.metadata)
  };
  if (!model.materialHandling && model.process && typeof model.process === 'object') {
    model.materialHandling = synthesizeMaterialHandling((model.process as { blocks?: unknown }).blocks);
  }
  return AiNativeDesModelDefinitionSchema.parse(model);
}

function synthesizeMaterialHandling(blocksInput: unknown): unknown {
  const blocks = Array.isArray(blocksInput) ? blocksInput.map(asRecord) : [];
  const moveBlocks = blocks.filter((block) => block.kind === 'moveByTransporter');
  if (moveBlocks.length === 0) {
    return undefined;
  }

  const nodeIds = new Set<string>(['home']);
  for (const block of moveBlocks) {
    if (typeof block.fromNodeId === 'string') nodeIds.add(block.fromNodeId);
    if (typeof block.toNodeId === 'string') nodeIds.add(block.toNodeId);
  }
  const nodes = [...nodeIds].map((id, index) => ({
    id,
    type: id === 'home' ? 'home' : id.includes('dock') ? 'dock' : id.includes('rack') ? 'storage' : 'station',
    x: index * 8,
    z: index % 2 === 0 ? 0 : 6
  }));
  const paths = nodes.slice(1).map((node, index) => ({
    id: `${nodes[index]!.id}-${node.id}`,
    from: nodes[index]!.id,
    to: node.id,
    bidirectional: true,
    trafficControl: 'reservation',
    capacity: 1
  }));
  const fleetId = moveBlocks.find((block) => typeof block.fleetId === 'string')?.fleetId ?? 'amr';
  return {
    id: 'generated-layout',
    nodes,
    paths,
    transporterFleets: [{ id: fleetId, count: 1, homeNodeId: 'home', speedMps: 1.2, accelerationMps2: 0.7, decelerationMps2: 0.7 }],
    storageSystems: [],
    conveyors: [],
    zones: [],
    obstacles: []
  };
}

export function diagnoseDesStudy(input: unknown): AuthoringDiagnoseResult {
  const parsedStudy = SimulationStudyCaseDefinitionSchema.safeParse(asRecord(input).study ?? input);
  let study: SimulationStudyCaseDefinition | null = null;
  const diagnostics: AuthoringDiagnostic[] = [];

  if (!parsedStudy.success) {
    diagnostics.push(...schemaDiagnostics(parsedStudy.error));
    try {
      study = normalizeStudyInput(input);
    } catch {
      return {
        valid: false,
        schemaValid: false,
        modelValid: false,
        study: null,
        modelDiagnostics: null,
        diagnostics
      };
    }
  } else {
    study = parsedStudy.data;
  }

  const model = study.model;
  if (!model) {
    diagnostics.push({
      source: 'schema',
      severity: 'error',
      code: 'study.external-model-not-supported',
      path: '$.modelPath',
      message: 'Authoring diagnostics require an inline model in this MVP.'
    });
    return {
      valid: false,
      schemaValid: parsedStudy.success,
      modelValid: false,
      study,
      modelDiagnostics: null,
      diagnostics
    };
  }

  const modelDiagnostics = analyzeDesModel(model);
  diagnostics.push(...modelDiagnostics.diagnostics.map((diagnostic) => ({ ...diagnostic, source: 'model' as const })));
  return {
    valid: parsedStudy.success && modelDiagnostics.valid,
    schemaValid: parsedStudy.success,
    modelValid: modelDiagnostics.valid,
    study,
    modelDiagnostics,
    diagnostics
  };
}

export async function draftDesStudy(request: DraftRequest): Promise<DraftStudyResult> {
  const brief = request.brief?.trim() || 'warehouse order picking with AMR transport and packing';
  const notes: string[] = [];
  const wantsOpenAi = request.provider === 'openai' || (request.provider !== 'rules' && Boolean(process.env.OPENAI_API_KEY));

  if (wantsOpenAi && process.env.OPENAI_API_KEY) {
    try {
      const study = await draftWithOpenAi(brief, request.constraints ?? {});
      const diagnosed = diagnoseDesStudy(study);
      return { ...diagnosed, provider: 'openai', notes };
    } catch (error) {
      notes.push(`OpenAI draft failed; used rules fallback. ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const study = buildRuleBasedStudy(brief, request.constraints ?? {});
  const diagnosed = diagnoseDesStudy(study);
  return { ...diagnosed, provider: 'rules', notes };
}

export function repairDesStudy(request: RepairRequest): AuthoringDiagnoseResult & { repaired: boolean; notes: string[] } {
  const notes: string[] = [];
  let study: SimulationStudyCaseDefinition;
  try {
    study = normalizeStudyInput(request.study);
  } catch {
    study = buildRuleBasedStudy(request.brief || 'warehouse order picking with AMR transport and packing', {});
    notes.push('Input could not be normalized; generated a fresh runnable draft from the brief.');
  }

  const model = study.model ? repairRunnableModel(study.model, notes) : buildRuleBasedStudy(request.brief || study.name, {}).model!;
  const experimentId = model.experiments[0]?.id ?? 'baseline';
  const repairedStudy = SimulationStudyCaseDefinitionSchema.parse({
    ...study,
    model,
    runs: study.runs.length > 0 ? study.runs : [{ experimentId, outputName: `${experimentId}-run`, htmlReport: true }]
  });
  const result = diagnoseDesStudy(repairedStudy);
  return { ...result, repaired: true, notes };
}

function repairRunnableModel(model: AiNativeDesModelDefinition, notes: string[]): AiNativeDesModelDefinition {
  const repaired = structuredClone(model) as AiNativeDesModelDefinition;
  if (repaired.experiments.length === 0) {
    repaired.experiments.push({ id: 'baseline', name: 'Baseline', seed: 20260425, replications: 1, seedStride: 1, parameterOverrides: {}, sweep: {}, stopTimeSec: 1800, warmupSec: 0, maxEvents: 100000 });
    notes.push('Added a baseline experiment.');
  }
  if (!repaired.process.blocks.some((block) => block.kind === 'sink')) {
    repaired.process.blocks.push({ id: 'sink', kind: 'sink' } as ProcessFlowBlockDefinition);
    notes.push('Added a sink block.');
  }
  const blockIds = new Set(repaired.process.blocks.map((block) => block.id));
  for (const block of repaired.process.blocks) {
    if (block.kind !== 'sink' && !repaired.process.connections.some((connection) => connection.from === block.id)) {
      const sinkId = repaired.process.blocks.find((candidate) => candidate.kind === 'sink')!.id;
      if (blockIds.has(sinkId)) {
        repaired.process.connections.push({ from: block.id, to: sinkId });
        notes.push(`Connected dead-end block ${block.id} to ${sinkId}.`);
      }
    }
  }
  return AiNativeDesModelDefinitionSchema.parse(repaired);
}

function buildRuleBasedStudy(brief: string, constraints: Record<string, unknown>): SimulationStudyCaseDefinition {
  const lower = brief.toLowerCase();
  const id = slugify(String(constraints.id ?? brief.split(/[,.，。]/)[0] ?? ''), 'authored-des-case');
  const isManufacturing = /manufactur|assembly|生产|制造|装配|产线/.test(lower);
  const entityType = isManufacturing ? 'part' : 'order';
  const arrivalMeanSec = Number(constraints.arrivalMeanSec ?? (/(每分钟|per minute|1\/min)/i.test(brief) ? 60 : 45));
  const serviceModeSec = Number(constraints.serviceModeSec ?? (isManufacturing ? 75 : 45));
  const stopTimeSec = Number(constraints.stopTimeSec ?? 1800);
  const pickerName = isManufacturing ? 'operator' : 'picker';

  const model: AiNativeDesModelDefinition = {
    schemaVersion: 'des-platform.v1',
    id,
    name: titleCase(id),
    description: brief,
    parameters: [
      { id: 'arrival-mean-sec', name: 'Mean interarrival time', path: '/process/blocks/source/intervalSec/mean', valueType: 'number', defaultValue: arrivalMeanSec, min: 10, max: 180, step: 5, unit: 's', description: 'Entity interarrival mean.' },
      { id: 'amr-speed-mps', name: 'AMR speed', path: '/materialHandling/transporterFleets/amr/speedMps', valueType: 'number', defaultValue: 1.2, min: 0.5, max: 2.5, step: 0.1, unit: 'm/s', description: 'Transporter maximum speed.' },
      { id: `${pickerName}-count`, name: `${titleCase(pickerName)} count`, path: `/process/resourcePools/${pickerName}/capacity`, valueType: 'integer', defaultValue: 1, min: 1, max: 6, step: 1, unit: pickerName, description: 'Constrained worker or machine capacity.' }
    ],
    process: {
      id: `${id}-flow`,
      resourcePools: [{ id: pickerName, name: titleCase(pickerName), capacity: 1 }],
      blocks: [
        { id: 'source', kind: 'source', entityType, startAtSec: 0, intervalSec: { kind: 'exponential', mean: arrivalMeanSec }, maxArrivals: 30, attributes: { source: 'authored' } },
        { id: 'move-to-work', kind: 'moveByTransporter', fleetId: 'amr', fromNodeId: 'dock', toNodeId: 'work', loadTimeSec: 3, unloadTimeSec: 2 },
        { id: 'work', kind: 'service', resourcePoolId: pickerName, quantity: 1, durationSec: { kind: 'triangular', min: Math.max(1, serviceModeSec * 0.6), mode: serviceModeSec, max: serviceModeSec * 1.7 } },
        { id: 'move-to-finish', kind: 'moveByTransporter', fleetId: 'amr', fromNodeId: 'work', toNodeId: 'finish', loadTimeSec: 2, unloadTimeSec: 2 },
        { id: 'sink', kind: 'sink' }
      ],
      connections: [
        { from: 'source', to: 'move-to-work' },
        { from: 'move-to-work', to: 'work' },
        { from: 'work', to: 'move-to-finish' },
        { from: 'move-to-finish', to: 'sink' }
      ]
    },
    materialHandling: {
      id: `${id}-layout`,
      units: 'meter',
      nodes: [
        { id: 'home', type: 'home', x: -5, z: 0 },
        { id: 'dock', type: 'dock', x: 0, z: 0 },
        { id: 'work', type: isManufacturing ? 'station' : 'storage', x: 12, z: 0 },
        { id: 'finish', type: 'station', x: 12, z: 8 },
        { id: 'parking', type: 'parking', x: -5, z: 4 },
        { id: 'charger', type: 'charger', x: -5, z: -4 }
      ],
      paths: [
        { id: 'home-dock', from: 'home', to: 'dock', bidirectional: true, trafficControl: 'reservation', capacity: 1, mode: 'path-guided' },
        { id: 'dock-work', from: 'dock', to: 'work', bidirectional: true, trafficControl: 'reservation', capacity: 1, mode: 'path-guided' },
        { id: 'work-finish', from: 'work', to: 'finish', bidirectional: true, trafficControl: 'reservation', capacity: 1, mode: 'path-guided' },
        { id: 'home-parking', from: 'home', to: 'parking', bidirectional: true, trafficControl: 'none', capacity: 2, mode: 'path-guided' }
      ],
      transporterFleets: [{ id: 'amr', vehicleType: 'amr', navigation: 'path-guided', count: 1, homeNodeId: 'home', parkingNodeId: 'parking', chargerNodeId: 'charger', idlePolicy: 'stay', speedMps: 1.2, accelerationMps2: 0.7, decelerationMps2: 0.7, lengthM: 1.1, widthM: 0.8, minClearanceM: 0.25 }],
      storageSystems: [],
      conveyors: [],
      zones: [],
      obstacles: [{ id: 'column-1', x: 6, z: 4, widthM: 0.8, depthM: 0.8, heightM: 4 }]
    },
    experiments: [{ id: 'baseline', name: 'Baseline', seed: 20260425, replications: 1, seedStride: 1, parameterOverrides: {}, sweep: {}, stopTimeSec, warmupSec: 0, maxEvents: 100000 }],
    metadata: { source: 'rule-based-authoring', brief }
  };

  return SimulationStudyCaseDefinitionSchema.parse({
    schemaVersion: 'des-platform.study.v1',
    id,
    name: `${titleCase(id)} Study`,
    description: brief,
    model,
    runs: [{ experimentId: 'baseline', outputName: 'baseline-run', htmlReport: true }],
    metadata: { source: 'rule-based-authoring' }
  });
}

function titleCase(value: string): string {
  return value.split(/[-_\s]+/).filter(Boolean).map((part) => part[0]!.toUpperCase() + part.slice(1)).join(' ');
}

async function draftWithOpenAi(brief: string, constraints: Record<string, unknown>): Promise<SimulationStudyCaseDefinition> {
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL ?? 'gpt-4.1-mini',
      input: [
        {
          role: 'system',
          content: 'You generate only JSON for des-platform.study.v1. Use inline model. Use valid process blocks, materialHandling layout, parameters, and one baseline experiment.'
        },
        {
          role: 'user',
          content: JSON.stringify({ brief, constraints })
        }
      ],
      temperature: 0.2
    })
  });
  if (!response.ok) {
    throw new Error(`OpenAI request failed with ${response.status}`);
  }
  const data = await response.json() as { output_text?: string; output?: Array<{ content?: Array<{ text?: string }> }> };
  const text = data.output_text ?? data.output?.flatMap((item) => item.content ?? []).map((content) => content.text ?? '').join('\n') ?? '';
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) {
    throw new Error('OpenAI response did not include JSON');
  }
  return normalizeStudyInput(JSON.parse(text.slice(start, end + 1)));
}
