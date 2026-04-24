import { z } from 'zod';

export const Coordinate2Schema = z.object({
  x: z.number(),
  z: z.number()
});

export const Coordinate3Schema = z.object({
  x: z.number(),
  y: z.number(),
  z: z.number()
});

export const BinSlotSchema = z.object({
  id: z.string(),
  x: z.number(),
  z: z.number()
});

export const StationLayoutSchema = z.object({
  id: z.string(),
  index: z.number().int().positive(),
  lineX: z.number(),
  stationZ: z.number(),
  dropNodeId: z.string(),
  binSlots: z.array(BinSlotSchema).length(2)
});

export const FacilitySchema = z.object({
  id: z.string(),
  x: z.number(),
  z: z.number(),
  width: z.number().positive(),
  depth: z.number().positive()
});

export const HomeNodeSchema = z.object({
  id: z.string(),
  x: z.number(),
  z: z.number()
});

export const AisleNodeSchema = z.object({
  id: z.string(),
  x: z.number(),
  z: z.number()
});

export const AisleEdgeSchema = z.tuple([z.string(), z.string()]);

export const ObstacleSchema = z.object({
  id: z.string(),
  x: z.number(),
  z: z.number(),
  width: z.number().positive(),
  depth: z.number().positive(),
  height: z.number().positive()
});

export const CameraPresetSchema = z.object({
  id: z.string(),
  label: z.string(),
  position: Coordinate3Schema,
  target: Coordinate3Schema
});

export const AssetDescriptorSchema = z.object({
  kind: z.enum(['primitive']),
  material: z.string(),
  color: z.string()
});

export const LayoutDefinitionSchema = z.object({
  id: z.string(),
  name: z.string(),
  units: z.literal('meter'),
  floor: z.object({
    width: z.number().positive(),
    depth: z.number().positive(),
    height: z.number().nonnegative()
  }),
  line: z.object({
    start: Coordinate2Schema,
    end: Coordinate2Schema,
    width: z.number().positive(),
    elevation: z.number().nonnegative(),
    pitchM: z.number().positive(),
    skidLengthM: z.number().positive(),
    skidGapM: z.number().nonnegative(),
    carLengthM: z.number().positive(),
    carWidthM: z.number().positive(),
    carHeightM: z.number().positive(),
    speedMps: z.number().positive()
  }),
  stations: z.array(StationLayoutSchema).min(1),
  facilities: z.object({
    supermarket: FacilitySchema,
    emptyReturn: FacilitySchema,
    amrHomes: z.array(HomeNodeSchema).min(1)
  }),
  aisleGraph: z.object({
    nodes: z.array(AisleNodeSchema).min(1),
    edges: z.array(AisleEdgeSchema).min(1)
  }),
  obstacles: z.array(ObstacleSchema),
  walls: z.array(ObstacleSchema),
  cameras: z.array(CameraPresetSchema).min(1),
  assets: z.record(AssetDescriptorSchema)
});

export const ScenarioDefinitionSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  layoutPath: z.string(),
  durationSec: z.number().positive(),
  seed: z.number().int().nonnegative(),
  taktTimeSec: z.number().positive(),
  snapshotIntervalSec: z.number().positive(),
  motionDtSec: z.number().positive(),
  line: z.object({
    stationCount: z.number().int().positive(),
    pacedCycleSec: z.number().positive(),
    pitchM: z.number().positive(),
    skidLengthM: z.number().positive(),
    skidGapM: z.number().nonnegative(),
    carLengthM: z.number().positive(),
    carWidthM: z.number().positive(),
    carHeightM: z.number().positive(),
    conveyorSpeedMps: z.number().positive()
  }),
  stations: z.object({
    qpc: z.array(z.number().int().positive()).min(1),
    initialBinFillRatio: z.number().min(0).max(1),
    unitsPerCar: z.number().int().positive()
  }),
  amr: z.object({
    count: z.number().int().positive(),
    speedMps: z.number().positive(),
    lengthM: z.number().positive(),
    widthM: z.number().positive(),
    heightM: z.number().positive(),
    loadTimeSec: z.number().nonnegative(),
    unloadTimeSec: z.number().nonnegative(),
    emptyHandlingSec: z.number().nonnegative()
  }),
  breakdown: z.object({
    enabled: z.boolean(),
    mode: z.enum(['periodic', 'random']),
    mtbfSec: z.number().positive(),
    repairSec: z.number().positive(),
    repairJitterRatio: z.number().min(0).max(1)
  }),
  stationBreakdown: z.object({
    enabled: z.boolean(),
    availability: z.number().min(0).max(1),
    mttrSec: z.number().positive(),
    mtbfDistribution: z.enum(['exponential']),
    mttrDistribution: z.enum(['erlang-2', 'constant']),
    scope: z.enum(['all-stations'])
  }).default({
    enabled: false,
    availability: 1,
    mttrSec: 300,
    mtbfDistribution: 'exponential',
    mttrDistribution: 'constant',
    scope: 'all-stations'
  }),
  dispatch: z.object({
    policy: z.literal('earliest-completion-nearest-idle')
  }),
  report: z.object({
    warmupSec: z.number().nonnegative(),
    includeReplay: z.boolean(),
    includeStationTables: z.boolean(),
    liveWindowStartSec: z.number().nonnegative(),
    livePlaybackSpeed: z.number().positive()
  })
}).superRefine((scenario, context) => {
  if (scenario.stations.qpc.length !== scenario.line.stationCount) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['stations', 'qpc'],
      message: `qpc length ${scenario.stations.qpc.length} must match line.stationCount ${scenario.line.stationCount}`
    });
  }

  if (scenario.stationBreakdown.enabled && scenario.stationBreakdown.availability <= 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['stationBreakdown', 'availability'],
      message: 'station breakdown availability must be greater than 0 when enabled'
    });
  }

  if (scenario.stationBreakdown.enabled && scenario.stationBreakdown.availability >= 1) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['stationBreakdown', 'availability'],
      message: 'station breakdown availability must be less than 1 when enabled'
    });
  }
});

export const BinStateSchema = z.object({
  id: z.string(),
  quantity: z.number().int().nonnegative(),
  capacity: z.number().int().positive(),
  pendingRequest: z.boolean(),
  isActive: z.boolean()
});

export const StationOperationalStateSchema = z.enum([
  'running',
  'idle',
  'down',
  'upstream-starved',
  'material-starved',
  'blocked'
]);

export const StationStateSchema = z.object({
  id: z.string(),
  index: z.number().int().positive(),
  qpc: z.number().int().positive(),
  currentCarId: z.string().nullable(),
  state: StationOperationalStateSchema,
  stateReason: z.string(),
  stateColor: z.string(),
  isStarved: z.boolean(),
  activeBinIndex: z.number().int().min(0).max(1),
  requestCount: z.number().int().nonnegative(),
  starvationCount: z.number().int().nonnegative(),
  bins: z.array(BinStateSchema).length(2)
});

export const CarSnapshotSchema = z.object({
  id: z.string(),
  sequence: z.number().int().positive(),
  skidId: z.string(),
  lineOrder: z.number().int().nonnegative(),
  releaseTimeSec: z.number().nonnegative(),
  distanceM: z.number().nonnegative(),
  nextStationId: z.string().nullable(),
  distanceToNextStationM: z.number().nonnegative().nullable(),
  timeToExitSec: z.number().nonnegative(),
  x: z.number(),
  y: z.number(),
  z: z.number(),
  lengthM: z.number().positive(),
  widthM: z.number().positive(),
  heightM: z.number().positive()
});

export const SkidSnapshotSchema = z.object({
  id: z.string(),
  carId: z.string(),
  releaseTimeSec: z.number().nonnegative(),
  distanceM: z.number().nonnegative(),
  x: z.number(),
  y: z.number(),
  z: z.number(),
  lengthM: z.number().positive(),
  widthM: z.number().positive(),
  heightM: z.number().positive()
});

export const TaskStateSchema = z.object({
  id: z.string(),
  stationId: z.string(),
  binId: z.string(),
  status: z.enum(['queued', 'assigned', 'to-pickup', 'loading', 'to-dropoff', 'unloading', 'to-return', 'empty-handling', 'done']),
  requestTimeSec: z.number().nonnegative(),
  assignedAtSec: z.number().nonnegative().nullable(),
  ageSec: z.number().nonnegative(),
  waitSec: z.number().nonnegative(),
  assignedAmrId: z.string().nullable(),
  qpc: z.number().int().positive()
});

export const AmrSnapshotSchema = z.object({
  id: z.string(),
  status: z.enum(['idle', 'moving', 'handling']),
  phase: z.enum(['idle', 'to-pickup', 'loading', 'to-dropoff', 'unloading', 'to-return', 'empty-handling']),
  taskId: z.string().nullable(),
  x: z.number(),
  y: z.number(),
  z: z.number(),
  yawRad: z.number(),
  speedMps: z.number().nonnegative(),
  totalDistanceM: z.number().nonnegative(),
  busyTimeSec: z.number().nonnegative(),
  currentNodeId: z.string(),
  targetNodeId: z.string().nullable(),
  routeDestinationNodeId: z.string().nullable(),
  routeNodeIds: z.array(z.string()),
  routeRemainingDistanceM: z.number().nonnegative()
});

export const KpiSummarySchema = z.object({
  completedCars: z.number().int().nonnegative(),
  releasedCars: z.number().int().nonnegative(),
  lineDowntimeSec: z.number().nonnegative(),
  starvationSec: z.number().nonnegative(),
  steadyStateCycleSec: z.number().nonnegative(),
  steadyStateUph: z.number().nonnegative(),
  actualAverageUph: z.number().nonnegative(),
  averageTaskWaitSec: z.number().nonnegative(),
  averageTaskCycleSec: z.number().nonnegative(),
  maxQueueLength: z.number().int().nonnegative(),
  amrUtilization: z.record(z.number().min(0)),
  stationConsumption: z.record(z.number().int().nonnegative()),
  stationDowntimeSec: z.record(z.number().nonnegative()),
  stationAvailability: z.record(z.number().min(0).max(1)),
  totalAmrDistanceM: z.number().nonnegative(),
  baselinePass: z.boolean()
});

export const AlertSchema = z.object({
  code: z.string(),
  severity: z.enum(['info', 'warning', 'critical']),
  message: z.string()
});

export const WorldSnapshotSchema = z.object({
  simTimeSec: z.number().nonnegative(),
  line: z.object({
    isRunning: z.boolean(),
    speedMps: z.number().nonnegative(),
    activeCars: z.number().int().nonnegative(),
    completedCars: z.number().int().nonnegative(),
    headCarId: z.string().nullable(),
    tailCarId: z.string().nullable(),
    onlineCarIds: z.array(z.string()),
    lineWindowStartSec: z.number().nonnegative()
  }),
  cars: z.array(CarSnapshotSchema),
  skids: z.array(SkidSnapshotSchema),
  stations: z.array(StationStateSchema).min(1),
  tasks: z.array(TaskStateSchema),
  amrs: z.array(AmrSnapshotSchema),
  kpis: KpiSummarySchema,
  alerts: z.array(AlertSchema)
});

export const EventLogEntrySchema = z.object({
  id: z.string(),
  simTimeSec: z.number().nonnegative(),
  type: z.enum([
    'car-released',
    'station-consumed',
    'car-exited',
    'bin-emptied',
    'bin-refilled',
    'task-created',
    'task-assigned',
    'task-started',
    'task-finished',
    'line-stopped',
    'line-started',
    'station-failed',
    'station-repaired',
    'starvation-started',
    'starvation-cleared'
  ]),
  payload: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()]))
});

export const ValidationCheckSchema = z.object({
  id: z.string(),
  label: z.string(),
  passed: z.boolean(),
  detail: z.string()
});

export const ValidationSummarySchema = z.object({
  passed: z.boolean(),
  checks: z.array(ValidationCheckSchema).min(1)
});

export const SimulationResultSchema = z.object({
  scenarioId: z.string(),
  layoutId: z.string(),
  createdAt: z.string(),
  scenario: ScenarioDefinitionSchema,
  layout: LayoutDefinitionSchema,
  kpis: KpiSummarySchema,
  validation: ValidationSummarySchema,
  snapshots: z.array(WorldSnapshotSchema),
  events: z.array(EventLogEntrySchema)
});

export const RuntimeSessionStatusSchema = z.enum(['starting', 'running', 'paused', 'completed', 'error']);

export const RuntimeSessionStateSchema = z.object({
  sessionId: z.string(),
  scenarioId: z.string(),
  layoutId: z.string(),
  status: RuntimeSessionStatusSchema,
  speed: z.number().positive(),
  startTimeSec: z.number().nonnegative(),
  simTimeSec: z.number().nonnegative(),
  durationSec: z.number().positive(),
  progress: z.number().min(0).max(1),
  createdAt: z.string(),
  updatedAt: z.string(),
  latestSnapshot: WorldSnapshotSchema.nullable(),
  latestKpis: KpiSummarySchema.nullable(),
  recentEvents: z.array(EventLogEntrySchema),
  error: z.string().nullable()
});

export type LayoutDefinition = z.infer<typeof LayoutDefinitionSchema>;
export type ScenarioDefinition = z.infer<typeof ScenarioDefinitionSchema>;
export type KpiSummary = z.infer<typeof KpiSummarySchema>;
export type WorldSnapshot = z.infer<typeof WorldSnapshotSchema>;
export type EventLogEntry = z.infer<typeof EventLogEntrySchema>;
export type ValidationCheck = z.infer<typeof ValidationCheckSchema>;
export type ValidationSummary = z.infer<typeof ValidationSummarySchema>;
export type SimulationResult = z.infer<typeof SimulationResultSchema>;
export type RuntimeSessionState = z.infer<typeof RuntimeSessionStateSchema>;
export type RuntimeSessionStatus = z.infer<typeof RuntimeSessionStatusSchema>;
export type StationOperationalState = z.infer<typeof StationOperationalStateSchema>;
