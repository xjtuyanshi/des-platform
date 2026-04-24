import { z } from 'zod';

export const DslLiteralSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const RawTimeDistributionDefinitionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('constant'),
    value: z.number().nonnegative()
  }),
  z.object({
    kind: z.literal('uniform'),
    min: z.number().nonnegative(),
    max: z.number().nonnegative()
  }),
  z.object({
    kind: z.literal('triangular'),
    min: z.number().nonnegative(),
    mode: z.number().nonnegative(),
    max: z.number().nonnegative()
  }),
  z.object({
    kind: z.literal('normal'),
    mean: z.number().nonnegative(),
    sd: z.number().positive(),
    min: z.number().nonnegative().default(0),
    max: z.number().nonnegative().optional()
  }),
  z.object({
    kind: z.literal('exponential'),
    mean: z.number().positive()
  })
]);

export const TimeDistributionDefinitionSchema = RawTimeDistributionDefinitionSchema.superRefine((distribution, context) => {
  if ((distribution.kind === 'uniform' || distribution.kind === 'triangular') && distribution.max < distribution.min) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['max'],
      message: `${distribution.kind} distribution max must be greater than or equal to min`
    });
  }

  if (distribution.kind === 'triangular' && (distribution.mode < distribution.min || distribution.mode > distribution.max)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['mode'],
      message: 'Triangular distribution mode must be between min and max'
    });
  }

  if (distribution.kind === 'normal' && distribution.max !== undefined && distribution.max < distribution.min) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['max'],
      message: 'Normal distribution max must be greater than or equal to min'
    });
  }
});

export const TimeValueDefinitionSchema = z.union([z.number().nonnegative(), TimeDistributionDefinitionSchema]);

function timeValueCanAdvance(value: z.infer<typeof TimeValueDefinitionSchema>): boolean {
  if (typeof value === 'number') {
    return value > 0;
  }

  switch (value.kind) {
    case 'constant':
      return value.value > 0;
    case 'uniform':
    case 'triangular':
      return value.max > 0;
    case 'normal':
      return value.max === undefined || value.max > 0;
    case 'exponential':
      return true;
    default:
      value satisfies never;
      return false;
  }
}

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

export const MhCoordinate2Schema = z.object({
  x: z.number(),
  z: z.number()
});

export const MaterialNodeDefinitionSchema = MhCoordinate2Schema.extend({
  id: z.string(),
  type: z.enum(['point', 'station', 'dock', 'storage', 'home', 'charger', 'conveyor-port']).default('point'),
  label: z.string().optional()
});

export const MaterialPathDefinitionSchema = z.object({
  id: z.string(),
  from: z.string(),
  to: z.string(),
  bidirectional: z.boolean().default(true),
  lengthM: z.number().positive().optional(),
  speedLimitMps: z.number().positive().optional(),
  mode: z.enum(['path-guided', 'free-space', 'conveyor']).default('path-guided')
});

export const MaterialObstacleDefinitionSchema = MhCoordinate2Schema.extend({
  id: z.string(),
  widthM: z.number().positive(),
  depthM: z.number().positive(),
  heightM: z.number().positive().default(1)
});

export const MaterialZoneDefinitionSchema = z.object({
  id: z.string(),
  kind: z.enum(['free-space', 'restricted', 'storage', 'traffic-control']),
  polygon: z.array(MhCoordinate2Schema).min(3)
});

export const TransporterFleetDefinitionSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  vehicleType: z.enum(['amr', 'agv', 'forklift', 'worker', 'crane']).default('amr'),
  navigation: z.enum(['path-guided', 'free-space']).default('path-guided'),
  count: z.number().int().positive(),
  homeNodeId: z.string(),
  speedMps: z.number().positive(),
  accelerationMps2: z.number().positive().optional(),
  decelerationMps2: z.number().positive().optional(),
  lengthM: z.number().positive().optional(),
  widthM: z.number().positive().optional(),
  minClearanceM: z.number().nonnegative().default(0)
});

export const StorageSystemDefinitionSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  nodeId: z.string(),
  capacity: z.number().int().positive(),
  slotIds: z.array(z.string()).optional()
});

export const ConveyorDefinitionSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  entryNodeId: z.string(),
  exitNodeId: z.string(),
  lengthM: z.number().positive(),
  speedMps: z.number().positive(),
  capacity: z.number().int().positive().optional()
});

export const MaterialHandlingDefinitionSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  units: z.literal('meter').default('meter'),
  nodes: z.array(MaterialNodeDefinitionSchema).min(1),
  paths: z.array(MaterialPathDefinitionSchema).default([]),
  transporterFleets: z.array(TransporterFleetDefinitionSchema).default([]),
  storageSystems: z.array(StorageSystemDefinitionSchema).default([]),
  conveyors: z.array(ConveyorDefinitionSchema).default([]),
  zones: z.array(MaterialZoneDefinitionSchema).default([]),
  obstacles: z.array(MaterialObstacleDefinitionSchema).default([])
}).superRefine((materialHandling, context) => {
  const nodeIds = new Set<string>();
  for (const node of materialHandling.nodes) {
    if (nodeIds.has(node.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['nodes'],
        message: `Duplicate material handling node id ${node.id}`
      });
    }
    nodeIds.add(node.id);
  }

  const pathIds = new Set<string>();
  for (const path of materialHandling.paths) {
    if (pathIds.has(path.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['paths'],
        message: `Duplicate material handling path id ${path.id}`
      });
    }
    pathIds.add(path.id);

    if (!nodeIds.has(path.from)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['paths', path.id, 'from'],
        message: `Path ${path.id} references unknown from node ${path.from}`
      });
    }
    if (!nodeIds.has(path.to)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['paths', path.id, 'to'],
        message: `Path ${path.id} references unknown to node ${path.to}`
      });
    }
  }

  for (const fleet of materialHandling.transporterFleets) {
    if (!nodeIds.has(fleet.homeNodeId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['transporterFleets', fleet.id, 'homeNodeId'],
        message: `Transporter fleet ${fleet.id} references unknown home node ${fleet.homeNodeId}`
      });
    }
  }

  for (const storage of materialHandling.storageSystems) {
    if (!nodeIds.has(storage.nodeId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['storageSystems', storage.id, 'nodeId'],
        message: `Storage system ${storage.id} references unknown node ${storage.nodeId}`
      });
    }
    if (storage.slotIds && storage.slotIds.length !== storage.capacity) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['storageSystems', storage.id, 'slotIds'],
        message: `Storage system ${storage.id} slotIds length must match capacity`
      });
    }
  }

  for (const conveyor of materialHandling.conveyors) {
    if (!nodeIds.has(conveyor.entryNodeId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['conveyors', conveyor.id, 'entryNodeId'],
        message: `Conveyor ${conveyor.id} references unknown entry node ${conveyor.entryNodeId}`
      });
    }
    if (!nodeIds.has(conveyor.exitNodeId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['conveyors', conveyor.id, 'exitNodeId'],
        message: `Conveyor ${conveyor.id} references unknown exit node ${conveyor.exitNodeId}`
      });
    }
  }
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
  intervalSec: TimeValueDefinitionSchema.optional(),
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
  durationSec: TimeValueDefinitionSchema
});

export const ServiceBlockDefinitionSchema = BlockBaseSchema.extend({
  kind: z.literal('service'),
  resourcePoolId: z.string(),
  quantity: z.number().int().positive().default(1),
  durationSec: TimeValueDefinitionSchema,
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

export const MoveByTransporterBlockDefinitionSchema = BlockBaseSchema.extend({
  kind: z.literal('moveByTransporter'),
  fleetId: z.string(),
  fromNodeId: z.string(),
  toNodeId: z.string(),
  loadTimeSec: TimeValueDefinitionSchema.default(0),
  unloadTimeSec: TimeValueDefinitionSchema.default(0)
});

export const StoreBlockDefinitionSchema = BlockBaseSchema.extend({
  kind: z.literal('store'),
  storageId: z.string(),
  itemIdAttribute: z.string().optional()
});

export const RetrieveBlockDefinitionSchema = BlockBaseSchema.extend({
  kind: z.literal('retrieve'),
  storageId: z.string(),
  itemIdAttribute: z.string().optional()
});

export const ConveyBlockDefinitionSchema = BlockBaseSchema.extend({
  kind: z.literal('convey'),
  conveyorId: z.string()
});

export const ProcessFlowBlockDefinitionSchema = z.discriminatedUnion('kind', [
  SourceBlockDefinitionSchema,
  QueueBlockDefinitionSchema,
  DelayBlockDefinitionSchema,
  ServiceBlockDefinitionSchema,
  SeizeBlockDefinitionSchema,
  ReleaseBlockDefinitionSchema,
  SelectOutputBlockDefinitionSchema,
  SinkBlockDefinitionSchema,
  MoveByTransporterBlockDefinitionSchema,
  StoreBlockDefinitionSchema,
  RetrieveBlockDefinitionSchema,
  ConveyBlockDefinitionSchema
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

    if (block.kind === 'source') {
      if (block.intervalSec === undefined && (!block.scheduleAtSec || block.scheduleAtSec.length === 0)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['blocks', block.id],
          message: `Source ${block.id} must define intervalSec or scheduleAtSec`
        });
      }

      if (block.intervalSec !== undefined && !timeValueCanAdvance(block.intervalSec)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['blocks', block.id, 'intervalSec'],
          message: `Source ${block.id} intervalSec must be able to advance simulation time`
        });
      }
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
  seed: z.number().int().nonnegative().default(1),
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
  materialHandling: MaterialHandlingDefinitionSchema.optional(),
  experiments: z.array(ExperimentDefinitionSchema).default([]),
  metadata: z.record(DslLiteralSchema).default({})
}).superRefine((model, context) => {
  const materialBlocks = model.process.blocks.filter((block) =>
    block.kind === 'moveByTransporter' || block.kind === 'store' || block.kind === 'retrieve' || block.kind === 'convey'
  );

  if (materialBlocks.length > 0 && !model.materialHandling) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['materialHandling'],
      message: 'Models using Material Handling process blocks must define materialHandling'
    });
    return;
  }

  if (!model.materialHandling) {
    return;
  }

  const nodeIds = new Set(model.materialHandling.nodes.map((node) => node.id));
  const fleetIds = new Set(model.materialHandling.transporterFleets.map((fleet) => fleet.id));
  const storageIds = new Set(model.materialHandling.storageSystems.map((storage) => storage.id));
  const conveyorIds = new Set(model.materialHandling.conveyors.map((conveyor) => conveyor.id));

  for (const block of model.process.blocks) {
    if (block.kind === 'moveByTransporter') {
      if (!fleetIds.has(block.fleetId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['process', 'blocks', block.id, 'fleetId'],
          message: `MoveByTransporter block ${block.id} references unknown fleet ${block.fleetId}`
        });
      }
      if (!nodeIds.has(block.fromNodeId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['process', 'blocks', block.id, 'fromNodeId'],
          message: `MoveByTransporter block ${block.id} references unknown from node ${block.fromNodeId}`
        });
      }
      if (!nodeIds.has(block.toNodeId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['process', 'blocks', block.id, 'toNodeId'],
          message: `MoveByTransporter block ${block.id} references unknown to node ${block.toNodeId}`
        });
      }
    }

    if ((block.kind === 'store' || block.kind === 'retrieve') && !storageIds.has(block.storageId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['process', 'blocks', block.id, 'storageId'],
        message: `${block.kind} block ${block.id} references unknown storage ${block.storageId}`
      });
    }

    if (block.kind === 'convey' && !conveyorIds.has(block.conveyorId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['process', 'blocks', block.id, 'conveyorId'],
        message: `Convey block ${block.id} references unknown conveyor ${block.conveyorId}`
      });
    }
  }
});

export type DslLiteral = z.infer<typeof DslLiteralSchema>;
export type TimeDistributionDefinition = z.infer<typeof TimeDistributionDefinitionSchema>;
export type TimeValueDefinition = z.infer<typeof TimeValueDefinitionSchema>;
export type EntityConditionDefinition = z.infer<typeof EntityConditionSchema>;
export type ResourcePoolDefinition = z.infer<typeof ResourcePoolDefinitionSchema>;
export type MaterialNodeDefinition = z.infer<typeof MaterialNodeDefinitionSchema>;
export type MaterialPathDefinition = z.infer<typeof MaterialPathDefinitionSchema>;
export type MaterialObstacleDefinition = z.infer<typeof MaterialObstacleDefinitionSchema>;
export type MaterialZoneDefinition = z.infer<typeof MaterialZoneDefinitionSchema>;
export type TransporterFleetDefinition = z.infer<typeof TransporterFleetDefinitionSchema>;
export type StorageSystemDefinition = z.infer<typeof StorageSystemDefinitionSchema>;
export type ConveyorDefinition = z.infer<typeof ConveyorDefinitionSchema>;
export type MaterialHandlingDefinition = z.infer<typeof MaterialHandlingDefinitionSchema>;
export type SourceBlockDefinition = z.infer<typeof SourceBlockDefinitionSchema>;
export type QueueBlockDefinition = z.infer<typeof QueueBlockDefinitionSchema>;
export type DelayBlockDefinition = z.infer<typeof DelayBlockDefinitionSchema>;
export type ServiceBlockDefinition = z.infer<typeof ServiceBlockDefinitionSchema>;
export type SeizeBlockDefinition = z.infer<typeof SeizeBlockDefinitionSchema>;
export type ReleaseBlockDefinition = z.infer<typeof ReleaseBlockDefinitionSchema>;
export type SelectOutputBlockDefinition = z.infer<typeof SelectOutputBlockDefinitionSchema>;
export type SinkBlockDefinition = z.infer<typeof SinkBlockDefinitionSchema>;
export type MoveByTransporterBlockDefinition = z.infer<typeof MoveByTransporterBlockDefinitionSchema>;
export type StoreBlockDefinition = z.infer<typeof StoreBlockDefinitionSchema>;
export type RetrieveBlockDefinition = z.infer<typeof RetrieveBlockDefinitionSchema>;
export type ConveyBlockDefinition = z.infer<typeof ConveyBlockDefinitionSchema>;
export type ProcessFlowBlockDefinition = z.infer<typeof ProcessFlowBlockDefinitionSchema>;
export type ProcessConnectionDefinition = z.infer<typeof ProcessConnectionDefinitionSchema>;
export type ProcessFlowDefinition = z.infer<typeof ProcessFlowDefinitionSchema>;
export type ExperimentDefinition = z.infer<typeof ExperimentDefinitionSchema>;
export type AiNativeDesModelDefinition = z.infer<typeof AiNativeDesModelDefinitionSchema>;
