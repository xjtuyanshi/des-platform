import { z } from 'zod';

export const Coordinate3Schema = z.object({
  x: z.number(),
  y: z.number(),
  z: z.number()
});

export const ShuttleNodeTypeSchema = z.enum([
  'storage',
  'aisle',
  'intersection',
  'inbound',
  'outbound',
  'charger',
  'parking',
  'lift-blackbox'
]);

export const ShuttleNodeSchema = z.object({
  id: z.string(),
  type: ShuttleNodeTypeSchema,
  x: z.number(),
  y: z.number().default(0),
  z: z.number(),
  noStop: z.boolean().default(false),
  noParking: z.boolean().default(false),
  capacity: z.number().int().positive().default(1),
  allowedDirections: z.array(z.string()).default([])
});

export const DirectionModeSchema = z.enum(['oneWay', 'twoWay']);
export const ReservationTypeSchema = z.enum(['edge', 'node', 'zone']);

export const ShuttleEdgeSchema = z.object({
  id: z.string(),
  from: z.string(),
  to: z.string(),
  lengthM: z.number().positive(),
  directionMode: DirectionModeSchema.default('twoWay'),
  speedLimitEmptyMps: z.number().positive().optional(),
  speedLimitLoadedMps: z.number().positive().optional(),
  reservationType: ReservationTypeSchema.default('edge'),
  conflictGroup: z.string().optional(),
  noParking: z.boolean().default(true)
});

export const ShuttleZoneSchema = z.object({
  id: z.string(),
  type: z.enum(['intersection', 'aisle', 'storage', 'parking']),
  nodeIds: z.array(z.string()).default([]),
  edgeIds: z.array(z.string()).default([]),
  noStop: z.boolean().default(false),
  noParking: z.boolean().default(false),
  capacity: z.number().int().positive().default(1),
  conflictGroup: z.string().optional()
});

export const VehicleConfigSchema = z.object({
  count: z.number().int().positive(),
  lengthM: z.number().positive(),
  widthM: z.number().positive(),
  heightM: z.number().positive(),
  emptySpeedMps: z.number().positive(),
  loadedSpeedMps: z.number().positive(),
  accelerationMps2: z.number().positive(),
  switchDirectionSec: z.number().nonnegative(),
  liftTimeSec: z.number().nonnegative(),
  lowerTimeSec: z.number().nonnegative(),
  maxLoadKg: z.number().positive(),
  safetyRadiusM: z.number().nonnegative(),
  batteryEnabled: z.boolean().default(false),
  initialSoc: z.number().min(0).max(1).default(1)
});

export const TaskGenerationSchema = z.object({
  inboundRatePerHour: z.number().nonnegative(),
  outboundRatePerHour: z.number().nonnegative(),
  inboundOutboundMix: z.number().min(0).max(1).default(0.5),
  arrivalDistribution: z.enum(['deterministic', 'seeded-exponential']).default('deterministic'),
  maxTasks: z.number().int().positive().default(200)
});

export const PhysicsParamsSchema = z.object({
  emptySpeedMps: z.number().positive(),
  loadedSpeedMps: z.number().positive(),
  accelerationMps2: z.number().positive(),
  switchDirectionSec: z.number().nonnegative(),
  liftTimeSec: z.number().nonnegative(),
  lowerTimeSec: z.number().nonnegative(),
  loadedClearanceM: z.number().nonnegative().default(0.2),
  reservationClearanceSec: z.number().nonnegative().default(0.4)
});

export const RoutingPolicySchema = z.object({
  algorithm: z.enum(['astar', 'dijkstra']).default('astar'),
  allowReplan: z.boolean().default(true),
  routeTimeoutSec: z.number().positive().default(12),
  maxReplansPerTask: z.number().int().nonnegative().default(3)
});

export const TrafficPolicySchema = z.object({
  edgeCapacity: z.number().int().positive().default(1),
  nodeCapacity: z.number().int().positive().default(1),
  zoneCapacity: z.number().int().positive().default(1),
  minimumClearanceSec: z.number().nonnegative().default(0.4),
  priorityAgingSec: z.number().nonnegative().default(20),
  deadlockDetectSec: z.number().positive().default(15),
  deadlockBreakPolicy: z.enum(['lowest-priority-replan', 'oldest-waits-wins']).default('oldest-waits-wins')
});

export const ShuttleScenarioSchema = z.object({
  schemaVersion: z.literal('shuttle.phase0.v0'),
  id: z.string(),
  name: z.string(),
  seed: z.number().int().nonnegative(),
  durationSec: z.number().positive(),
  timeStepSec: z.number().positive().default(0.2),
  vehicles: VehicleConfigSchema,
  layout: z.object({
    units: z.literal('meter').default('meter'),
    nodes: z.array(ShuttleNodeSchema).min(2),
    edges: z.array(ShuttleEdgeSchema).min(1),
    zones: z.array(ShuttleZoneSchema).default([])
  }),
  taskGeneration: TaskGenerationSchema,
  physicsParams: PhysicsParamsSchema,
  routingPolicy: RoutingPolicySchema,
  trafficPolicy: TrafficPolicySchema
}).superRefine((scenario, context) => {
  const nodeIds = new Set(scenario.layout.nodes.map((node) => node.id));
  for (const edge of scenario.layout.edges) {
    if (!nodeIds.has(edge.from)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['layout', 'edges', edge.id, 'from'],
        message: `Unknown edge from node ${edge.from}`
      });
    }
    if (!nodeIds.has(edge.to)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['layout', 'edges', edge.id, 'to'],
        message: `Unknown edge to node ${edge.to}`
      });
    }
  }
});

export const VehicleOperationalStateSchema = z.enum([
  'idle',
  'assigned',
  'moving-to-pickup',
  'aligning-under-load',
  'lifting',
  'loaded-moving',
  'lowering',
  'returning',
  'parking',
  'waiting-blocked',
  'charging',
  'faulted'
]);

export const VehicleStateSchema = z.object({
  id: z.string(),
  state: VehicleOperationalStateSchema,
  x: z.number(),
  y: z.number(),
  z: z.number(),
  yaw: z.number(),
  speedMps: z.number().nonnegative(),
  loaded: z.boolean(),
  taskId: z.string().nullable(),
  targetNodeId: z.string().nullable(),
  currentNodeId: z.string(),
  routeNodeIds: z.array(z.string()),
  waitReason: z.string().nullable(),
  blockedTimeSec: z.number().nonnegative(),
  idleTimeSec: z.number().nonnegative(),
  busyTimeSec: z.number().nonnegative()
});

export const TaskStateSchema = z.enum(['queued', 'assigned', 'in-progress', 'completed', 'failed']);
export const TaskKindSchema = z.enum(['inbound', 'outbound']);

export const TaskStateRecordSchema = z.object({
  id: z.string(),
  kind: TaskKindSchema,
  state: TaskStateSchema,
  createdAtSec: z.number().nonnegative(),
  assignedAtSec: z.number().nonnegative().nullable(),
  startedAtSec: z.number().nonnegative().nullable(),
  completedAtSec: z.number().nonnegative().nullable(),
  pickupNodeId: z.string(),
  dropoffNodeId: z.string(),
  loadId: z.string(),
  vehicleId: z.string().nullable(),
  replanCount: z.number().int().nonnegative(),
  waitReason: z.string().nullable()
});

export const LoadStateSchema = z.enum(['waiting', 'carried', 'stored', 'delivered']);

export const LoadStateRecordSchema = z.object({
  id: z.string(),
  state: LoadStateSchema,
  nodeId: z.string().nullable(),
  vehicleId: z.string().nullable(),
  weightKg: z.number().positive()
});

export const ReservationSchema = z.object({
  id: z.string(),
  resourceType: ReservationTypeSchema,
  resourceId: z.string(),
  vehicleId: z.string(),
  taskId: z.string().nullable(),
  startTimeSec: z.number().nonnegative(),
  endTimeSec: z.number().nonnegative(),
  priority: z.number().int(),
  conflictGroup: z.string().nullable(),
  reasonCode: z.string()
});

export const KpiSnapshotSchema = z.object({
  inboundPph: z.number().nonnegative(),
  outboundPph: z.number().nonnegative(),
  totalPph: z.number().nonnegative(),
  completedInbound: z.number().int().nonnegative(),
  completedOutbound: z.number().int().nonnegative(),
  activeTasks: z.number().int().nonnegative(),
  queuedTasks: z.number().int().nonnegative(),
  averageTaskCycleSec: z.number().nonnegative(),
  p95TaskCycleSec: z.number().nonnegative(),
  averageTaskWaitSec: z.number().nonnegative(),
  vehicleUtilization: z.record(z.number().min(0).max(1)),
  blockedTimeByReasonSec: z.record(z.number().nonnegative()),
  reservationConflictCount: z.number().int().nonnegative(),
  replanCount: z.number().int().nonnegative(),
  deadlockCount: z.number().int().nonnegative(),
  livelockCount: z.number().int().nonnegative(),
  eventLogHash: z.string()
});

export const EventLogEntrySchema = z.object({
  sequence: z.number().int().nonnegative(),
  timeSec: z.number().nonnegative(),
  eventType: z.string(),
  vehicleId: z.string().nullable(),
  taskId: z.string().nullable(),
  loadId: z.string().nullable(),
  fromNodeId: z.string().nullable(),
  toNodeId: z.string().nullable(),
  reason: z.string().nullable(),
  position: Coordinate3Schema.nullable(),
  details: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).default({})
});

export const ShuttleSimStateSchema = z.object({
  schemaVersion: z.literal('shuttle.phase0.state.v0'),
  scenarioId: z.string(),
  sessionId: z.string(),
  status: z.enum(['idle', 'running', 'paused', 'completed', 'error']),
  simTimeSec: z.number().nonnegative(),
  durationSec: z.number().positive(),
  seed: z.number().int().nonnegative(),
  vehicles: z.array(VehicleStateSchema),
  tasks: z.array(TaskStateRecordSchema),
  loads: z.array(LoadStateRecordSchema),
  reservations: z.array(ReservationSchema),
  kpis: KpiSnapshotSchema,
  recentEvents: z.array(EventLogEntrySchema),
  error: z.string().nullable()
});

export const ShuttleCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('loadScenario'), scenario: ShuttleScenarioSchema }),
  z.object({ type: z.literal('reset'), seed: z.number().int().nonnegative().optional() }),
  z.object({ type: z.literal('pause') }),
  z.object({ type: z.literal('resume') }),
  z.object({ type: z.literal('setParam'), path: z.string().regex(/^\//), value: z.union([z.string(), z.number(), z.boolean(), z.null()]) }),
  z.object({ type: z.literal('startRun'), durationSec: z.number().positive().optional(), seed: z.number().int().nonnegative().optional() }),
  z.object({ type: z.literal('exportLog') })
]);

export const ShuttleStreamMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('simState'), state: ShuttleSimStateSchema }),
  z.object({ type: z.literal('vehicleState'), vehicles: z.array(VehicleStateSchema), simTimeSec: z.number().nonnegative() }),
  z.object({ type: z.literal('taskEvent'), events: z.array(EventLogEntrySchema), simTimeSec: z.number().nonnegative() }),
  z.object({ type: z.literal('kpiUpdate'), kpis: KpiSnapshotSchema, simTimeSec: z.number().nonnegative() }),
  z.object({ type: z.literal('error'), message: z.string(), simTimeSec: z.number().nonnegative().optional() }),
  z.object({ type: z.literal('connectionRecovered'), state: ShuttleSimStateSchema })
]);

export type Coordinate3 = z.infer<typeof Coordinate3Schema>;
export type ShuttleScenario = z.infer<typeof ShuttleScenarioSchema>;
export type VehicleState = z.infer<typeof VehicleStateSchema>;
export type TaskStateRecord = z.infer<typeof TaskStateRecordSchema>;
export type LoadStateRecord = z.infer<typeof LoadStateRecordSchema>;
export type Reservation = z.infer<typeof ReservationSchema>;
export type KpiSnapshot = z.infer<typeof KpiSnapshotSchema>;
export type EventLogEntry = z.infer<typeof EventLogEntrySchema>;
export type ShuttleSimState = z.infer<typeof ShuttleSimStateSchema>;
export type ShuttleCommand = z.infer<typeof ShuttleCommandSchema>;
export type ShuttleStreamMessage = z.infer<typeof ShuttleStreamMessageSchema>;
