import { z } from 'zod';

export const DslLiteralSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const EntityConditionSchema = z.object({
  attribute: z.string(),
  operator: z.enum(['equals', 'not-equals']).default('equals'),
  value: DslLiteralSchema
});

export const ResourcePoolDefinitionSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  capacity: z.number().int().positive(),
  initialAvailable: z.number().int().nonnegative().optional()
});

const BlockBaseSchema = z.object({
  id: z.string(),
  label: z.string().optional(),
  description: z.string().optional()
});

export const SourceBlockDefinitionSchema = BlockBaseSchema.extend({
  kind: z.literal('source'),
  entityType: z.string().default('entity'),
  startAtSec: z.number().nonnegative().default(0),
  intervalSec: z.number().positive().optional(),
  scheduleAtSec: z.array(z.number().nonnegative()).optional(),
  maxArrivals: z.number().int().positive().optional(),
  attributes: z.record(DslLiteralSchema).default({})
});

export const QueueBlockDefinitionSchema = BlockBaseSchema.extend({
  kind: z.literal('queue'),
  capacity: z.number().int().positive().optional(),
  discipline: z.enum(['fifo', 'lifo']).default('fifo')
});

export const DelayBlockDefinitionSchema = BlockBaseSchema.extend({
  kind: z.literal('delay'),
  durationSec: z.number().nonnegative()
});

export const ServiceBlockDefinitionSchema = BlockBaseSchema.extend({
  kind: z.literal('service'),
  resourcePoolId: z.string(),
  quantity: z.number().int().positive().default(1),
  durationSec: z.number().nonnegative(),
  queueCapacity: z.number().int().positive().optional()
});

export const SeizeBlockDefinitionSchema = BlockBaseSchema.extend({
  kind: z.literal('seize'),
  resourcePoolId: z.string(),
  quantity: z.number().int().positive().default(1),
  queueCapacity: z.number().int().positive().optional()
});

export const ReleaseBlockDefinitionSchema = BlockBaseSchema.extend({
  kind: z.literal('release'),
  resourcePoolId: z.string(),
  quantity: z.number().int().positive().default(1)
});

export const SelectOutputBlockDefinitionSchema = BlockBaseSchema.extend({
  kind: z.literal('selectOutput')
});

export const SinkBlockDefinitionSchema = BlockBaseSchema.extend({
  kind: z.literal('sink')
});

export const ProcessFlowBlockDefinitionSchema = z.discriminatedUnion('kind', [
  SourceBlockDefinitionSchema,
  QueueBlockDefinitionSchema,
  DelayBlockDefinitionSchema,
  ServiceBlockDefinitionSchema,
  SeizeBlockDefinitionSchema,
  ReleaseBlockDefinitionSchema,
  SelectOutputBlockDefinitionSchema,
  SinkBlockDefinitionSchema
]);

export const ProcessConnectionDefinitionSchema = z.object({
  from: z.string(),
  to: z.string(),
  condition: EntityConditionSchema.optional()
});

export const ProcessFlowDefinitionSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  resourcePools: z.array(ResourcePoolDefinitionSchema).default([]),
  blocks: z.array(ProcessFlowBlockDefinitionSchema).min(1),
  connections: z.array(ProcessConnectionDefinitionSchema).default([])
}).superRefine((flow, context) => {
  const blockIds = new Set<string>();
  for (const block of flow.blocks) {
    if (blockIds.has(block.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['blocks'],
        message: `Duplicate process block id ${block.id}`
      });
    }
    blockIds.add(block.id);

    if (block.kind === 'source' && !block.intervalSec && (!block.scheduleAtSec || block.scheduleAtSec.length === 0)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['blocks', block.id],
        message: `Source ${block.id} must define intervalSec or scheduleAtSec`
      });
    }
  }

  const poolIds = new Set(flow.resourcePools.map((pool) => pool.id));
  for (const pool of flow.resourcePools) {
    if (pool.initialAvailable !== undefined && pool.initialAvailable > pool.capacity) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['resourcePools', pool.id, 'initialAvailable'],
        message: `Resource pool ${pool.id} initialAvailable cannot exceed capacity`
      });
    }
  }

  for (const block of flow.blocks) {
    if ((block.kind === 'service' || block.kind === 'seize' || block.kind === 'release') && !poolIds.has(block.resourcePoolId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['blocks', block.id, 'resourcePoolId'],
        message: `Block ${block.id} references unknown resource pool ${block.resourcePoolId}`
      });
    }
  }

  for (const connection of flow.connections) {
    if (!blockIds.has(connection.from)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['connections'],
        message: `Connection references unknown from block ${connection.from}`
      });
    }
    if (!blockIds.has(connection.to)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['connections'],
        message: `Connection references unknown to block ${connection.to}`
      });
    }
  }
});

export const ExperimentDefinitionSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  stopTimeSec: z.number().positive(),
  warmupSec: z.number().nonnegative().default(0),
  maxEvents: z.number().int().positive().default(100_000)
});

export const AiNativeDesModelDefinitionSchema = z.object({
  schemaVersion: z.literal('des-platform.v1'),
  id: z.string(),
  name: z.string(),
  description: z.string().default(''),
  process: ProcessFlowDefinitionSchema,
  experiments: z.array(ExperimentDefinitionSchema).default([]),
  metadata: z.record(DslLiteralSchema).default({})
});

export type DslLiteral = z.infer<typeof DslLiteralSchema>;
export type EntityConditionDefinition = z.infer<typeof EntityConditionSchema>;
export type ResourcePoolDefinition = z.infer<typeof ResourcePoolDefinitionSchema>;
export type SourceBlockDefinition = z.infer<typeof SourceBlockDefinitionSchema>;
export type QueueBlockDefinition = z.infer<typeof QueueBlockDefinitionSchema>;
export type DelayBlockDefinition = z.infer<typeof DelayBlockDefinitionSchema>;
export type ServiceBlockDefinition = z.infer<typeof ServiceBlockDefinitionSchema>;
export type SeizeBlockDefinition = z.infer<typeof SeizeBlockDefinitionSchema>;
export type ReleaseBlockDefinition = z.infer<typeof ReleaseBlockDefinitionSchema>;
export type SelectOutputBlockDefinition = z.infer<typeof SelectOutputBlockDefinitionSchema>;
export type SinkBlockDefinition = z.infer<typeof SinkBlockDefinitionSchema>;
export type ProcessFlowBlockDefinition = z.infer<typeof ProcessFlowBlockDefinitionSchema>;
export type ProcessConnectionDefinition = z.infer<typeof ProcessConnectionDefinitionSchema>;
export type ProcessFlowDefinition = z.infer<typeof ProcessFlowDefinitionSchema>;
export type ExperimentDefinition = z.infer<typeof ExperimentDefinitionSchema>;
export type AiNativeDesModelDefinition = z.infer<typeof AiNativeDesModelDefinitionSchema>;
