import { DesSimulation, type DesEventPayload, type DesRunResult } from '@des-platform/des-core';
import type { MaterialHandlingRuntime, MaterialHandlingSnapshot, MaterialTransportTaskPlan, TransporterUnitState } from '@des-platform/material-handling';
import {
  ProcessFlowDefinitionSchema,
  type DslLiteral,
  type ProcessConnectionDefinition,
  type ProcessFlowBlockDefinition,
  type ProcessFlowDefinition,
  type ResourcePoolDefinition,
  type TimeValueDefinition
} from '@des-platform/shared-schema/model-dsl';

import { createSeededRandom, sampleTimeSec, type RandomSource } from './stochastic.js';

const SOURCE_CREATE_EVENT = 'process.source.create';
const ENTITY_ENTER_EVENT = 'process.entity.enter';
const BLOCK_ROUTE_EVENT = 'process.block.route';
const SERVICE_COMPLETE_EVENT = 'process.service.complete';
const TRANSPORT_COMPLETE_EVENT = 'process.material.transport.complete';
const CONVEYOR_EXIT_EVENT = 'process.material.conveyor.exit';

type HoldWaitRequest = {
  entityId: string;
  blockId: string;
  signalId: string;
  queuedAtSec: number;
};

export type ProcessEntity = {
  id: string;
  type: string;
  createdAtSec: number;
  completedAtSec: number | null;
  currentBlockId: string | null;
  attributes: Record<string, DslLiteral>;
  visitedBlockIds: string[];
  resourceHoldings: Record<string, number>;
};

export type ProcessBlockStats = {
  entered: number;
  completed: number;
  currentQueueLength: number;
  maxQueueLength: number;
  totalWaitTimeSec: number;
  completedWaits: number;
  averageWaitTimeSec: number;
  blockedOutputCount: number;
  rejectedCount: number;
  droppedCount: number;
};

export type AdmissionResult =
  | { status: 'accepted' }
  | { status: 'blocked'; reason: string; receiverBlockId: string }
  | { status: 'rejected'; reason: string; branch?: string };

type QueueWaitEntry = {
  entityId: string;
  blockId: string;
  queuedAtSec: number;
};

type BlockedEntityRoute = {
  entityId: string;
  fromBlockId: string;
  toBlockId: string;
  queuedAtSec: number;
  reason: string;
};

export type ResourceWaitMode = 'service' | 'seize';

export type ResourceWaitRequest = {
  entityId: string;
  blockId: string;
  resourcePoolId: string;
  quantity: number;
  mode: ResourceWaitMode;
  durationSec: number;
  queuedAtSec: number;
};

type StorageStoreWaitRequest = {
  entityId: string;
  blockId: string;
  storageId: string;
  itemId: string;
  sku: string | null;
  queuedAtSec: number;
};

type StorageRetrieveWaitRequest = {
  entityId: string;
  blockId: string;
  storageId: string;
  query: string;
  policy: 'exactItem' | 'anyMatchingSku' | 'fifo' | 'nearest';
  queuedAtSec: number;
};

type ConveyorWaitRequest = {
  entityId: string;
  blockId: string;
  conveyorId: string;
  queuedAtSec: number;
};

export type RuntimeResourcePoolState = {
  id: string;
  capacity: number;
  available: number;
  waiting: ResourceWaitRequest[];
  maxQueueLength: number;
  busyTimeSec: number;
  utilization: number;
  totalWaitTimeSec: number;
  completedRequests: number;
  averageWaitTimeSec: number;
};

type RuntimeResourcePoolMutableState = RuntimeResourcePoolState & {
  lastChangedAtSec: number;
};

export type TransporterMoveRequest = {
  entityId: string;
  blockId: string;
  fleetId: string;
  fromNodeId: string;
  toNodeId: string;
  loadTimeSec: number;
  unloadTimeSec: number;
  queuedAtSec: number;
};

export type ActiveTransportState = {
  transporterUnitId: string;
  fleetId: string;
  entityId: string;
  blockId: string;
  startSec: number;
  endSec: number;
  requestQueuedAtSec: number;
  dispatchWaitSec: number;
  emptyFromNodeId: string;
  emptyToNodeId: string;
  emptyRouteNodeIds: string[];
  emptyTravelStartSec: number;
  emptyTravelEndSec: number;
  emptyTrafficWaitSec: number;
  loadStartSec: number;
  loadEndSec: number;
  loadedFromNodeId: string;
  loadedToNodeId: string;
  loadedRouteNodeIds: string[];
  loadedTravelStartSec: number;
  loadedTravelEndSec: number;
  loadedTrafficWaitSec: number;
  emptyPathTrafficWaitSec: number;
  emptyNodeTrafficWaitSec: number;
  loadedPathTrafficWaitSec: number;
  loadedNodeTrafficWaitSec: number;
  unloadStartSec: number;
  unloadEndSec: number;
  trafficWaitSec: number;
  pathTrafficWaitSec: number;
  nodeTrafficWaitSec: number;
};

export type RuntimeTransporterFleetStats = {
  fleetId: string;
  moveRequests: number;
  startedMoves: number;
  completedMoves: number;
  totalWaitTimeSec: number;
  averageWaitTimeSec: number;
  totalBusyTimeSec: number;
  utilization: number;
  totalEmptyDistanceM: number;
  totalLoadedDistanceM: number;
  totalDistanceM: number;
  totalTrafficWaitTimeSec: number;
  totalPathTrafficWaitTimeSec: number;
  totalNodeTrafficWaitTimeSec: number;
  totalEmptyTrafficWaitTimeSec: number;
  totalLoadedTrafficWaitTimeSec: number;
  totalEmptyPathTrafficWaitTimeSec: number;
  totalEmptyNodeTrafficWaitTimeSec: number;
  totalLoadedPathTrafficWaitTimeSec: number;
  totalLoadedNodeTrafficWaitTimeSec: number;
  totalEmptyTravelTimeSec: number;
  totalLoadedTravelTimeSec: number;
  totalTravelTimeSec: number;
};

type RuntimeTransporterFleetMutableStats = Omit<
  RuntimeTransporterFleetStats,
  'averageWaitTimeSec' | 'utilization' | 'totalDistanceM' | 'totalTravelTimeSec'
>;

export type ProcessFlowSnapshot = {
  nowSec: number;
  createdEntities: number;
  completedEntities: number;
  entities: ProcessEntity[];
  resourcePools: RuntimeResourcePoolState[];
  transporterWaits: TransporterMoveRequest[];
  activeTransports: ActiveTransportState[];
  transporterFleetStats: RuntimeTransporterFleetStats[];
  materialHandling: MaterialHandlingSnapshot | null;
  blockStats: Record<string, ProcessBlockStats>;
};

export type ProcessFlowRunResult = {
  simulation: DesSimulation;
  runtime: ProcessFlowRuntime;
  snapshot: ProcessFlowSnapshot;
  runResult: DesRunResult | null;
};

type ProcessRuntimeState = Record<string, never>;

type SourceCreatePayload = {
  sourceId: string;
};

type EntityEnterPayload = {
  entityId: string;
  blockId: string;
};

type BlockRoutePayload = {
  entityId: string;
  blockId: string;
};

type ServiceCompletePayload = {
  entityId: string;
  blockId: string;
  resourcePoolId: string;
  quantity: number;
};

type TransportCompletePayload = {
  entityId: string;
  blockId: string;
  fleetId: string;
  transporterUnitId: string;
  toNodeId: string;
  busyDurationSec: number;
  emptyDistanceM: number;
  loadedDistanceM: number;
  trafficWaitSec: number;
  pathTrafficWaitSec: number;
  nodeTrafficWaitSec: number;
  emptyTrafficWaitSec: number;
  loadedTrafficWaitSec: number;
  emptyPathTrafficWaitSec: number;
  emptyNodeTrafficWaitSec: number;
  loadedPathTrafficWaitSec: number;
  loadedNodeTrafficWaitSec: number;
  emptyTravelTimeSec: number;
  loadedTravelTimeSec: number;
};

type ConveyorExitPayload = {
  entityId: string;
  blockId: string;
  conveyorId: string;
};

function asSourceCreatePayload(payload: DesEventPayload): SourceCreatePayload {
  return { sourceId: String(payload.sourceId) };
}

function asEntityEnterPayload(payload: DesEventPayload): EntityEnterPayload {
  return { entityId: String(payload.entityId), blockId: String(payload.blockId) };
}

function asBlockRoutePayload(payload: DesEventPayload): BlockRoutePayload {
  return { entityId: String(payload.entityId), blockId: String(payload.blockId) };
}

function asServiceCompletePayload(payload: DesEventPayload): ServiceCompletePayload {
  return {
    entityId: String(payload.entityId),
    blockId: String(payload.blockId),
    resourcePoolId: String(payload.resourcePoolId),
    quantity: Number(payload.quantity)
  };
}

function asTransportCompletePayload(payload: DesEventPayload): TransportCompletePayload {
  return {
    entityId: String(payload.entityId),
    blockId: String(payload.blockId),
    fleetId: String(payload.fleetId),
    transporterUnitId: String(payload.transporterUnitId),
    toNodeId: String(payload.toNodeId),
    busyDurationSec: Number(payload.busyDurationSec),
    emptyDistanceM: Number(payload.emptyDistanceM),
    loadedDistanceM: Number(payload.loadedDistanceM),
    trafficWaitSec: Number(payload.trafficWaitSec),
    pathTrafficWaitSec: Number(payload.pathTrafficWaitSec),
    nodeTrafficWaitSec: Number(payload.nodeTrafficWaitSec),
    emptyTrafficWaitSec: Number(payload.emptyTrafficWaitSec),
    loadedTrafficWaitSec: Number(payload.loadedTrafficWaitSec),
    emptyPathTrafficWaitSec: Number(payload.emptyPathTrafficWaitSec),
    emptyNodeTrafficWaitSec: Number(payload.emptyNodeTrafficWaitSec),
    loadedPathTrafficWaitSec: Number(payload.loadedPathTrafficWaitSec),
    loadedNodeTrafficWaitSec: Number(payload.loadedNodeTrafficWaitSec),
    emptyTravelTimeSec: Number(payload.emptyTravelTimeSec),
    loadedTravelTimeSec: Number(payload.loadedTravelTimeSec)
  };
}

function asConveyorExitPayload(payload: DesEventPayload): ConveyorExitPayload {
  return {
    entityId: String(payload.entityId),
    blockId: String(payload.blockId),
    conveyorId: String(payload.conveyorId)
  };
}

function cloneAttributes(attributes: Record<string, DslLiteral>): Record<string, DslLiteral> {
  return { ...attributes };
}

function valueAsItemId(value: DslLiteral | undefined, fallback: string): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  return fallback;
}

export class ProcessFlowRuntime {
  private readonly definition: ProcessFlowDefinition;
  private readonly blockMap = new Map<string, ProcessFlowBlockDefinition>();
  private readonly outgoing = new Map<string, ProcessConnectionDefinition[]>();
  private readonly resourcePools = new Map<string, RuntimeResourcePoolMutableState>();
  private readonly sourceArrivalCounts = new Map<string, number>();
  private readonly entities = new Map<string, ProcessEntity>();
  private readonly completedEntityIds: string[] = [];
  private readonly blockStats = new Map<string, ProcessBlockStats>();
  private readonly transporterWaits = new Map<string, TransporterMoveRequest[]>();
  private readonly activeTransports = new Map<string, ActiveTransportState>();
  private readonly transporterFleetStats = new Map<string, RuntimeTransporterFleetMutableStats>();
  private readonly holdWaitsBySignal = new Map<string, HoldWaitRequest[]>();
  private readonly holdGateWaitsBySignal = new Map<string, HoldWaitRequest[]>();
  private readonly batchQueues = new Map<string, string[]>();
  private readonly batchCounts = new Map<string, number>();
  private readonly queueWaits = new Map<string, QueueWaitEntry[]>();
  private readonly queueGateWaits = new Map<string, QueueWaitEntry[]>();
  private readonly blockedOutputsByReceiver = new Map<string, BlockedEntityRoute[]>();
  private readonly blockedQueuesByReceiver = new Map<string, Set<string>>();
  private readonly pendingAdmissionsByBlock = new Map<string, number>();
  private readonly drainingQueueIds = new Set<string>();
  private readonly resourceGateWaitsByBlock = new Map<string, ResourceWaitRequest[]>();
  private readonly storageStoreWaitsByStorage = new Map<string, StorageStoreWaitRequest[]>();
  private readonly storageRetrieveWaitsByStorage = new Map<string, StorageRetrieveWaitRequest[]>();
  private readonly conveyorWaitsByConveyor = new Map<string, ConveyorWaitRequest[]>();
  private attached = false;

  constructor(
    definition: ProcessFlowDefinition,
    private readonly materialHandling: MaterialHandlingRuntime | null = null,
    private readonly random: RandomSource = createSeededRandom()
  ) {
    this.definition = ProcessFlowDefinitionSchema.parse(definition);

    for (const block of this.definition.blocks) {
      this.blockMap.set(block.id, block);
      this.blockStats.set(block.id, {
        entered: 0,
        completed: 0,
        currentQueueLength: 0,
        maxQueueLength: 0,
        totalWaitTimeSec: 0,
        completedWaits: 0,
        averageWaitTimeSec: 0,
        blockedOutputCount: 0,
        rejectedCount: 0,
        droppedCount: 0
      });
    }

    for (const connection of this.definition.connections) {
      const connections = this.outgoing.get(connection.from) ?? [];
      connections.push(connection);
      this.outgoing.set(connection.from, connections);
    }

    for (const pool of this.definition.resourcePools) {
      this.resourcePools.set(pool.id, this.createResourcePoolState(pool));
    }
  }

  attach(sim: DesSimulation<ProcessRuntimeState>): void {
    if (this.attached) {
      throw new Error(`Process flow ${this.definition.id} is already attached to a simulation`);
    }

    this.attached = true;
    sim.on(SOURCE_CREATE_EVENT, ({ sim: runtime, event }) => this.handleSourceCreate(runtime, asSourceCreatePayload(event.payload)));
    sim.on(ENTITY_ENTER_EVENT, ({ sim: runtime, event }) => this.handleEntityEnter(runtime, asEntityEnterPayload(event.payload)));
    sim.on(BLOCK_ROUTE_EVENT, ({ sim: runtime, event }) => this.handleBlockRoute(runtime, asBlockRoutePayload(event.payload)));
    sim.on(SERVICE_COMPLETE_EVENT, ({ sim: runtime, event }) => this.handleServiceComplete(runtime, asServiceCompletePayload(event.payload)));
    sim.on(TRANSPORT_COMPLETE_EVENT, ({ sim: runtime, event }) => this.handleTransportComplete(runtime, asTransportCompletePayload(event.payload)));
    sim.on(CONVEYOR_EXIT_EVENT, ({ sim: runtime, event }) => this.handleConveyorExit(runtime, asConveyorExitPayload(event.payload)));
    this.scheduleSources(sim);
  }

  getSnapshot(nowSec = 0): ProcessFlowSnapshot {
    return {
      nowSec,
      createdEntities: this.entities.size,
      completedEntities: this.completedEntityIds.length,
      entities: [...this.entities.values()].map((entity) => ({
        ...entity,
        attributes: { ...entity.attributes },
        visitedBlockIds: [...entity.visitedBlockIds],
        resourceHoldings: { ...entity.resourceHoldings }
      })),
      resourcePools: [...this.resourcePools.values()].map((pool) => this.snapshotResourcePool(pool, nowSec)),
      transporterWaits: [...this.transporterWaits.values()].flat().map((request) => ({ ...request })),
      activeTransports: [...this.activeTransports.values()].map((transport) => ({
        ...transport,
        emptyRouteNodeIds: [...transport.emptyRouteNodeIds],
        loadedRouteNodeIds: [...transport.loadedRouteNodeIds]
      })),
      transporterFleetStats: [...this.transporterFleetStats.values()].map((stats) => this.snapshotTransporterFleetStats(stats, nowSec)),
      materialHandling: this.materialHandling?.getSnapshot() ?? null,
      blockStats: Object.fromEntries(
        [...this.blockStats.entries()].map(([id, stats]) => [
          id,
          {
            ...stats
          }
        ])
      )
    };
  }

  private createResourcePoolState(pool: ResourcePoolDefinition): RuntimeResourcePoolMutableState {
    return {
      id: pool.id,
      capacity: pool.capacity,
      available: pool.initialAvailable ?? pool.capacity,
      waiting: [],
      maxQueueLength: 0,
      busyTimeSec: 0,
      utilization: 0,
      totalWaitTimeSec: 0,
      completedRequests: 0,
      averageWaitTimeSec: 0,
      lastChangedAtSec: 0
    };
  }

  private snapshotResourcePool(pool: RuntimeResourcePoolMutableState, nowSec: number): RuntimeResourcePoolState {
    const busyTimeSec = this.resourceBusyTimeUntil(pool, nowSec);
    return {
      id: pool.id,
      capacity: pool.capacity,
      available: pool.available,
      waiting: pool.waiting.map((request) => ({ ...request })),
      maxQueueLength: pool.maxQueueLength,
      busyTimeSec,
      utilization: nowSec <= 0 || pool.capacity <= 0 ? 0 : busyTimeSec / (pool.capacity * nowSec),
      totalWaitTimeSec: pool.totalWaitTimeSec,
      completedRequests: pool.completedRequests,
      averageWaitTimeSec: pool.completedRequests === 0 ? 0 : pool.totalWaitTimeSec / pool.completedRequests
    };
  }

  private accrueResourceBusyTime(pool: RuntimeResourcePoolMutableState, nowSec: number): void {
    pool.busyTimeSec = this.resourceBusyTimeUntil(pool, nowSec);
    pool.lastChangedAtSec = nowSec;
  }

  private resourceBusyTimeUntil(pool: RuntimeResourcePoolMutableState, nowSec: number): number {
    const elapsedSec = Math.max(0, nowSec - pool.lastChangedAtSec);
    const busyUnits = pool.capacity - pool.available;
    return pool.busyTimeSec + elapsedSec * busyUnits;
  }

  private snapshotTransporterFleetStats(
    stats: RuntimeTransporterFleetMutableStats,
    nowSec: number
  ): RuntimeTransporterFleetStats {
    const unitCount = this.materialHandling
      ? this.materialHandling.getSnapshot().transporterUnits.filter((unit) => unit.fleetId === stats.fleetId).length
      : 0;
    const totalDistanceM = stats.totalEmptyDistanceM + stats.totalLoadedDistanceM;
    const totalTravelTimeSec = stats.totalEmptyTravelTimeSec + stats.totalLoadedTravelTimeSec;
    return {
      ...stats,
      averageWaitTimeSec: stats.startedMoves === 0 ? 0 : stats.totalWaitTimeSec / stats.startedMoves,
      utilization: nowSec <= 0 || unitCount <= 0 ? 0 : stats.totalBusyTimeSec / (unitCount * nowSec),
      totalDistanceM,
      totalTravelTimeSec
    };
  }

  private requireTransporterFleetStats(fleetId: string): RuntimeTransporterFleetMutableStats {
    const existing = this.transporterFleetStats.get(fleetId);
    if (existing) {
      return existing;
    }

    const created: RuntimeTransporterFleetMutableStats = {
      fleetId,
      moveRequests: 0,
      startedMoves: 0,
      completedMoves: 0,
      totalWaitTimeSec: 0,
      totalBusyTimeSec: 0,
      totalEmptyDistanceM: 0,
      totalLoadedDistanceM: 0,
      totalTrafficWaitTimeSec: 0,
      totalPathTrafficWaitTimeSec: 0,
      totalNodeTrafficWaitTimeSec: 0,
      totalEmptyTrafficWaitTimeSec: 0,
      totalLoadedTrafficWaitTimeSec: 0,
      totalEmptyPathTrafficWaitTimeSec: 0,
      totalEmptyNodeTrafficWaitTimeSec: 0,
      totalLoadedPathTrafficWaitTimeSec: 0,
      totalLoadedNodeTrafficWaitTimeSec: 0,
      totalEmptyTravelTimeSec: 0,
      totalLoadedTravelTimeSec: 0
    };
    this.transporterFleetStats.set(fleetId, created);
    return created;
  }

  private scheduleSources(sim: DesSimulation<ProcessRuntimeState>): void {
    for (const block of this.definition.blocks) {
      if (block.kind !== 'source') {
        continue;
      }

      if (block.scheduleAtSec && block.scheduleAtSec.length > 0) {
        const schedule = block.maxArrivals ? block.scheduleAtSec.slice(0, block.maxArrivals) : block.scheduleAtSec;
        for (const atSec of schedule) {
          this.scheduleSourceCreate(sim, block.id, atSec);
        }
        continue;
      }

      this.scheduleSourceCreate(sim, block.id, block.startAtSec);
    }
  }

  private scheduleSourceCreate(sim: DesSimulation<ProcessRuntimeState>, sourceId: string, atSec: number): void {
    sim.scheduleAt(SOURCE_CREATE_EVENT, atSec, { sourceId }, { priority: 20 });
  }

  private handleSourceCreate(sim: DesSimulation<ProcessRuntimeState>, payload: SourceCreatePayload): void {
    const block = this.requireBlock(payload.sourceId);
    if (block.kind !== 'source') {
      throw new Error(`Block ${payload.sourceId} is not a source`);
    }

    const createdCount = (this.sourceArrivalCounts.get(block.id) ?? 0) + 1;
    this.sourceArrivalCounts.set(block.id, createdCount);
    const entity: ProcessEntity = {
      id: `${block.id}-${createdCount}`,
      type: block.entityType,
      createdAtSec: sim.nowSec,
      completedAtSec: null,
      currentBlockId: block.id,
      attributes: cloneAttributes(block.attributes),
      visitedBlockIds: [block.id],
      resourceHoldings: {}
    };

    this.entities.set(entity.id, entity);
    this.incrementCompleted(block.id);
    this.routeFromBlock(sim, block.id, entity);

    if (block.intervalSec && (!block.maxArrivals || createdCount < block.maxArrivals)) {
      this.scheduleSourceCreate(sim, block.id, sim.nowSec + this.sampleTime(block.intervalSec, `${block.id}.intervalSec`));
    }
  }

  private handleEntityEnter(sim: DesSimulation<ProcessRuntimeState>, payload: EntityEnterPayload): void {
    const entity = this.requireEntity(payload.entityId);
    const block = this.requireBlock(payload.blockId);
    this.releasePendingAdmission(block.id);
    entity.currentBlockId = block.id;
    entity.visitedBlockIds.push(block.id);
    this.incrementEntered(block.id);

    switch (block.kind) {
      case 'source':
        throw new Error(`Entities cannot enter source block ${block.id}; source blocks create entities`);
      case 'queue':
        this.handleQueueBlock(sim, block, entity);
        break;
      case 'delay':
        sim.scheduleIn(
          BLOCK_ROUTE_EVENT,
          this.sampleTime(block.durationSec, `${block.id}.durationSec`),
          { entityId: entity.id, blockId: block.id },
          { priority: 50 }
        );
        this.incrementCompleted(block.id);
        break;
      case 'hold':
        this.handleHoldBlock(sim, block, entity);
        break;
      case 'signal':
        this.releaseSignalWaits(sim, block.signalId);
        entity.attributes.lastSignalId = block.signalId;
        this.incrementCompleted(block.id);
        this.routeFromBlock(sim, block.id, entity);
        break;
      case 'batch':
        this.handleBatchBlock(sim, block, entity);
        break;
      case 'unbatch':
        entity.attributes.lastUnbatchBlockId = block.id;
        this.incrementCompleted(block.id);
        this.routeFromBlock(sim, block.id, entity);
        break;
      case 'service':
        this.enqueueResourceRequest(sim, {
          entityId: entity.id,
          blockId: block.id,
          resourcePoolId: block.resourcePoolId,
          quantity: block.quantity,
          mode: 'service',
          durationSec: this.sampleTime(block.durationSec, `${block.id}.durationSec`),
          queuedAtSec: sim.nowSec
        }, block.queueCapacity);
        break;
      case 'seize':
        this.enqueueResourceRequest(sim, {
          entityId: entity.id,
          blockId: block.id,
          resourcePoolId: block.resourcePoolId,
          quantity: block.quantity,
          mode: 'seize',
          durationSec: 0,
          queuedAtSec: sim.nowSec
        }, block.queueCapacity);
        break;
      case 'release':
        this.releaseEntityResource(sim, entity, block.resourcePoolId, block.quantity);
        this.incrementCompleted(block.id);
        this.routeFromBlock(sim, block.id, entity);
        break;
      case 'assign':
        entity.attributes = {
          ...entity.attributes,
          ...block.assignments
        };
        this.incrementCompleted(block.id);
        this.routeFromBlock(sim, block.id, entity);
        break;
      case 'selectOutput':
        this.incrementCompleted(block.id);
        this.routeFromBlock(sim, block.id, entity);
        break;
      case 'moveByTransporter':
        this.enqueueTransporterMove(sim, {
          entityId: entity.id,
          blockId: block.id,
          fleetId: block.fleetId,
          fromNodeId: block.fromNodeId,
          toNodeId: block.toNodeId,
          loadTimeSec: this.sampleTime(block.loadTimeSec, `${block.id}.loadTimeSec`),
          unloadTimeSec: this.sampleTime(block.unloadTimeSec, `${block.id}.unloadTimeSec`),
          queuedAtSec: sim.nowSec
        });
        break;
      case 'pickup':
        this.handlePickupDropoffBlock(sim, block, entity, block.loadTimeSec, 'pickup');
        break;
      case 'dropoff':
        this.handlePickupDropoffBlock(sim, block, entity, block.unloadTimeSec, 'dropoff');
        break;
      case 'store':
        this.handleStoreBlock(sim, block, entity);
        break;
      case 'retrieve':
        this.handleRetrieveBlock(sim, block, entity);
        break;
      case 'convey': {
        this.handleConveyBlock(sim, block, entity);
        break;
      }
      case 'sink':
        entity.completedAtSec = sim.nowSec;
        entity.currentBlockId = block.id;
        this.completedEntityIds.push(entity.id);
        this.incrementCompleted(block.id);
        break;
      default:
        block satisfies never;
    }
  }

  private handleBlockRoute(sim: DesSimulation<ProcessRuntimeState>, payload: BlockRoutePayload): void {
    const entity = this.requireEntity(payload.entityId);
    this.routeFromBlock(sim, payload.blockId, entity);
  }

  private handleConveyorExit(sim: DesSimulation<ProcessRuntimeState>, payload: ConveyorExitPayload): void {
    const entity = this.requireEntity(payload.entityId);
    const block = this.requireBlock(payload.blockId);
    if (block.kind !== 'convey') {
      throw new Error(`Block ${payload.blockId} is not a convey block`);
    }

    const materialHandling = this.requireMaterialHandling(block.id);
    const conveyor = materialHandling.getConveyor(payload.conveyorId);
    materialHandling.exitConveyor(payload.conveyorId, entity.id);
    entity.attributes.conveyorId = payload.conveyorId;
    entity.attributes.locationNodeId = conveyor.exitNodeId;
    this.incrementCompleted(block.id);
    this.routeFromBlock(sim, block.id, entity);
    this.tryDrainConveyorWaits(sim, payload.conveyorId);
    this.tryDrainBlockedEntities(sim, block.id);
    this.tryDrainBlockedQueuesForReceiver(sim, block.id);
  }

  private handleTransportComplete(sim: DesSimulation<ProcessRuntimeState>, payload: TransportCompletePayload): void {
    const entity = this.requireEntity(payload.entityId);
    const materialHandling = this.requireMaterialHandling(payload.blockId);
    const stats = this.requireTransporterFleetStats(payload.fleetId);
    stats.completedMoves += 1;
    stats.totalBusyTimeSec += payload.busyDurationSec;
    stats.totalEmptyDistanceM += payload.emptyDistanceM;
    stats.totalLoadedDistanceM += payload.loadedDistanceM;
    stats.totalTrafficWaitTimeSec += payload.trafficWaitSec;
    stats.totalPathTrafficWaitTimeSec += payload.pathTrafficWaitSec;
    stats.totalNodeTrafficWaitTimeSec += payload.nodeTrafficWaitSec;
    stats.totalEmptyTrafficWaitTimeSec += payload.emptyTrafficWaitSec;
    stats.totalLoadedTrafficWaitTimeSec += payload.loadedTrafficWaitSec;
    stats.totalEmptyPathTrafficWaitTimeSec += payload.emptyPathTrafficWaitSec;
    stats.totalEmptyNodeTrafficWaitTimeSec += payload.emptyNodeTrafficWaitSec;
    stats.totalLoadedPathTrafficWaitTimeSec += payload.loadedPathTrafficWaitSec;
    stats.totalLoadedNodeTrafficWaitTimeSec += payload.loadedNodeTrafficWaitSec;
    stats.totalEmptyTravelTimeSec += payload.emptyTravelTimeSec;
    stats.totalLoadedTravelTimeSec += payload.loadedTravelTimeSec;
    materialHandling.releaseTransporter(payload.transporterUnitId, payload.toNodeId);
    this.activeTransports.delete(payload.transporterUnitId);
    entity.attributes.locationNodeId = payload.toNodeId;
    entity.attributes.lastTransporterFleetId = payload.fleetId;
    entity.attributes.lastTransporterUnitId = payload.transporterUnitId;
    this.incrementCompleted(payload.blockId);
    this.tryStartTransporterMoves(sim, payload.fleetId);
    this.routeFromBlock(sim, payload.blockId, entity);
  }

  private handleQueueBlock(sim: DesSimulation<ProcessRuntimeState>, block: Extract<ProcessFlowBlockDefinition, { kind: 'queue' }>, entity: ProcessEntity): void {
    if (!this.queueCanAccept(block)) {
      this.enqueueQueueGateWait(block.id, {
        entityId: entity.id,
        blockId: block.id,
        queuedAtSec: sim.nowSec
      });
      return;
    }

    this.enqueueQueueWait(block.id, {
      entityId: entity.id,
      blockId: block.id,
      queuedAtSec: sim.nowSec
    });
    this.tryDrainQueue(sim, block.id);
  }

  private handleHoldBlock(
    sim: DesSimulation<ProcessRuntimeState>,
    block: Extract<ProcessFlowBlockDefinition, { kind: 'hold' }>,
    entity: ProcessEntity
  ): void {
    if (block.signalId) {
      const waits = this.holdWaitsBySignal.get(block.signalId) ?? [];
      if (block.queueCapacity !== undefined && waits.filter((wait) => wait.blockId === block.id).length >= block.queueCapacity) {
        const gateWaits = this.holdGateWaitsBySignal.get(block.signalId) ?? [];
        gateWaits.push({
          entityId: entity.id,
          blockId: block.id,
          signalId: block.signalId,
          queuedAtSec: sim.nowSec
        });
        this.holdGateWaitsBySignal.set(block.signalId, gateWaits);
        this.requireStats(block.id).blockedOutputCount += 1;
        return;
      }
      waits.push({
        entityId: entity.id,
        blockId: block.id,
        signalId: block.signalId,
        queuedAtSec: sim.nowSec
      });
      this.holdWaitsBySignal.set(block.signalId, waits);
      this.requireStats(block.id).maxQueueLength = Math.max(this.requireStats(block.id).maxQueueLength, waits.length);
      return;
    }

    const delaySec = block.untilSec !== undefined
      ? Math.max(0, block.untilSec - sim.nowSec)
      : this.sampleTime(block.durationSec ?? 0, `${block.id}.durationSec`);
    sim.scheduleIn(
      BLOCK_ROUTE_EVENT,
      delaySec,
      { entityId: entity.id, blockId: block.id },
      { priority: 50 }
    );
    this.incrementCompleted(block.id);
  }

  private releaseSignalWaits(sim: DesSimulation<ProcessRuntimeState>, signalId: string): void {
    const waits = [
      ...(this.holdWaitsBySignal.get(signalId) ?? []),
      ...(this.holdGateWaitsBySignal.get(signalId) ?? [])
    ];
    this.holdWaitsBySignal.delete(signalId);
    this.holdGateWaitsBySignal.delete(signalId);
    const releasedBlockIds = new Set<string>();
    for (const wait of waits) {
      const entity = this.requireEntity(wait.entityId);
      entity.attributes.lastReleasedSignalId = signalId;
      entity.attributes.lastSignalWaitSec = sim.nowSec - wait.queuedAtSec;
      const stats = this.requireStats(wait.blockId);
      stats.blockedOutputCount = Math.max(0, stats.blockedOutputCount - 1);
      this.incrementCompleted(wait.blockId);
      releasedBlockIds.add(wait.blockId);
      this.routeFromBlock(sim, wait.blockId, entity);
    }
    for (const blockId of releasedBlockIds) {
      this.tryDrainBlockedQueuesForReceiver(sim, blockId);
      this.tryDrainBlockedEntities(sim, blockId);
    }
  }

  private handleBatchBlock(
    sim: DesSimulation<ProcessRuntimeState>,
    block: Extract<ProcessFlowBlockDefinition, { kind: 'batch' }>,
    entity: ProcessEntity
  ): void {
    const queue = this.batchQueues.get(block.id) ?? [];
    queue.push(entity.id);
    this.batchQueues.set(block.id, queue);
    this.requireStats(block.id).maxQueueLength = Math.max(this.requireStats(block.id).maxQueueLength, queue.length);

    if (queue.length < block.batchSize) {
      return;
    }

    const released = queue.splice(0, block.batchSize);
    const batchCount = (this.batchCounts.get(block.id) ?? 0) + 1;
    this.batchCounts.set(block.id, batchCount);
    const batchId = `${block.id}-${batchCount}`;
    for (const entityId of released) {
      const batched = this.requireEntity(entityId);
      batched.attributes[block.batchIdAttribute] = batchId;
      batched.attributes[block.batchSizeAttribute] = block.batchSize;
      this.incrementCompleted(block.id);
      this.routeFromBlock(sim, block.id, batched);
    }
  }

  private handlePickupDropoffBlock(
    sim: DesSimulation<ProcessRuntimeState>,
    block: Extract<ProcessFlowBlockDefinition, { kind: 'pickup' | 'dropoff' }>,
    entity: ProcessEntity,
    durationSec: TimeValueDefinition,
    mode: 'pickup' | 'dropoff'
  ): void {
    this.requireMaterialHandling(block.id);
    const itemId = this.itemIdFor(entity, block.itemIdAttribute);
    entity.attributes.locationNodeId = block.nodeId;
    entity.attributes.lastMaterialAction = mode;
    entity.attributes.lastMaterialNodeId = block.nodeId;
    entity.attributes.lastMaterialItemId = itemId;
    sim.scheduleIn(
      BLOCK_ROUTE_EVENT,
      this.sampleTime(durationSec, `${block.id}.${mode === 'pickup' ? 'loadTimeSec' : 'unloadTimeSec'}`),
      { entityId: entity.id, blockId: block.id },
      { priority: 50 }
    );
    this.incrementCompleted(block.id);
  }

  private handleStoreBlock(
    sim: DesSimulation<ProcessRuntimeState>,
    block: Extract<ProcessFlowBlockDefinition, { kind: 'store' }>,
    entity: ProcessEntity
  ): void {
    const materialHandling = this.requireMaterialHandling(block.id);
    const itemId = this.itemIdFor(entity, block.itemIdAttribute);
    const sku = block.skuAttribute ? valueAsItemId(entity.attributes[block.skuAttribute], itemId) : null;
    if (!materialHandling.canStore(block.storageId, itemId)) {
      const waits = this.storageStoreWaitsByStorage.get(block.storageId) ?? [];
      waits.push({ entityId: entity.id, blockId: block.id, storageId: block.storageId, itemId, sku, queuedAtSec: sim.nowSec });
      this.storageStoreWaitsByStorage.set(block.storageId, waits);
      this.updateBlockWaitStats(block.id, waits.length);
      return;
    }

    this.completeStoreBlock(sim, block.id, block.storageId, entity, itemId, sku);
  }

  private completeStoreBlock(
    sim: DesSimulation<ProcessRuntimeState>,
    blockId: string,
    storageId: string,
    entity: ProcessEntity,
    itemId: string,
    sku: string | null
  ): void {
    this.requireMaterialHandling(blockId).store(storageId, itemId, { sku: sku ?? undefined, storedAtSec: sim.nowSec });
    entity.attributes.storageId = storageId;
    entity.attributes.storedItemId = itemId;
    if (sku) {
      entity.attributes.storedSku = sku;
    }
    this.incrementCompleted(blockId);
    this.routeFromBlock(sim, blockId, entity);
    this.tryDrainStorageRetrieveWaits(sim, storageId);
  }

  private handleRetrieveBlock(
    sim: DesSimulation<ProcessRuntimeState>,
    block: Extract<ProcessFlowBlockDefinition, { kind: 'retrieve' }>,
    entity: ProcessEntity
  ): void {
    const materialHandling = this.requireMaterialHandling(block.id);
    const policy = block.retrievePolicy ?? 'exactItem';
    const query = policy === 'anyMatchingSku' && block.skuAttribute
      ? valueAsItemId(entity.attributes[block.skuAttribute], entity.id)
      : this.itemIdFor(entity, block.itemIdAttribute);
    if (!materialHandling.canRetrieve(block.storageId, query, policy)) {
      const waits = this.storageRetrieveWaitsByStorage.get(block.storageId) ?? [];
      waits.push({ entityId: entity.id, blockId: block.id, storageId: block.storageId, query, policy, queuedAtSec: sim.nowSec });
      this.storageRetrieveWaitsByStorage.set(block.storageId, waits);
      this.updateBlockWaitStats(block.id, waits.length);
      return;
    }

    this.completeRetrieveBlock(sim, block.id, block.storageId, entity, query, policy);
  }

  private completeRetrieveBlock(
    sim: DesSimulation<ProcessRuntimeState>,
    blockId: string,
    storageId: string,
    entity: ProcessEntity,
    query: string,
    policy: 'exactItem' | 'anyMatchingSku' | 'fifo' | 'nearest'
  ): void {
    const slot = this.requireMaterialHandling(blockId).retrieve(storageId, query, policy);
    entity.attributes.storageId = null;
    entity.attributes.retrievedItemId = slot.itemId ?? query;
    if (slot.sku) {
      entity.attributes.retrievedSku = slot.sku;
    }
    this.incrementCompleted(blockId);
    this.routeFromBlock(sim, blockId, entity);
    this.tryDrainStorageStoreWaits(sim, storageId);
  }

  private handleConveyBlock(
    sim: DesSimulation<ProcessRuntimeState>,
    block: Extract<ProcessFlowBlockDefinition, { kind: 'convey' }>,
    entity: ProcessEntity
  ): void {
    const materialHandling = this.requireMaterialHandling(block.id);
    if (!materialHandling.canEnterConveyor(block.conveyorId)) {
      const waits = this.conveyorWaitsByConveyor.get(block.conveyorId) ?? [];
      waits.push({ entityId: entity.id, blockId: block.id, conveyorId: block.conveyorId, queuedAtSec: sim.nowSec });
      this.conveyorWaitsByConveyor.set(block.conveyorId, waits);
      this.updateBlockWaitStats(block.id, waits.length);
      return;
    }

    this.enterConveyor(sim, block.id, block.conveyorId, entity);
  }

  private enterConveyor(sim: DesSimulation<ProcessRuntimeState>, blockId: string, conveyorId: string, entity: ProcessEntity): void {
    const materialHandling = this.requireMaterialHandling(blockId);
    const conveyor = materialHandling.getConveyor(conveyorId);
    const entered = materialHandling.enterConveyor(conveyorId, entity.id, sim.nowSec);
    entity.attributes.conveyorId = conveyorId;
    entity.attributes.locationNodeId = conveyor.entryNodeId;
    sim.scheduleAt(
      CONVEYOR_EXIT_EVENT,
      entered.exitAtSec,
      { entityId: entity.id, blockId, conveyorId },
      { priority: 50 }
    );
  }

  private handleServiceComplete(sim: DesSimulation<ProcessRuntimeState>, payload: ServiceCompletePayload): void {
    const entity = this.requireEntity(payload.entityId);
    const pool = this.requireResourcePool(payload.resourcePoolId);
    this.accrueResourceBusyTime(pool, sim.nowSec);
    pool.available += payload.quantity;
    if (pool.available > pool.capacity) {
      throw new Error(`Resource pool ${pool.id} released above capacity`);
    }

    this.incrementCompleted(payload.blockId);
    this.tryStartWaitingRequests(sim, pool);
    this.routeFromBlock(sim, payload.blockId, entity);
  }

  private enqueueResourceRequest(sim: DesSimulation<ProcessRuntimeState>, request: ResourceWaitRequest, queueCapacity?: number): void {
    const pool = this.requireResourcePool(request.resourcePoolId);
    const waitingForBlock = pool.waiting.filter((waiting) => waiting.blockId === request.blockId).length;
    if (queueCapacity !== undefined && waitingForBlock >= queueCapacity && request.quantity > pool.available) {
      const gateWaits = this.resourceGateWaitsByBlock.get(request.blockId) ?? [];
      gateWaits.push(request);
      this.resourceGateWaitsByBlock.set(request.blockId, gateWaits);
      this.requireStats(request.blockId).blockedOutputCount += 1;
      return;
    }

    pool.waiting.push(request);
    pool.maxQueueLength = Math.max(pool.maxQueueLength, pool.waiting.length);
    this.requireStats(request.blockId).maxQueueLength = Math.max(this.requireStats(request.blockId).maxQueueLength, waitingForBlock + 1);
    this.tryStartWaitingRequests(sim, pool);
  }

  private tryStartWaitingRequests(sim: DesSimulation<ProcessRuntimeState>, pool: RuntimeResourcePoolMutableState): void {
    let index = 0;
    const changedBlockIds = new Set<string>();
    while (index < pool.waiting.length) {
      const request = pool.waiting[index]!;
      if (request.quantity > pool.available) {
        index += 1;
        continue;
      }

      pool.waiting.splice(index, 1);
      this.accrueResourceBusyTime(pool, sim.nowSec);
      pool.available -= request.quantity;
      pool.totalWaitTimeSec += sim.nowSec - request.queuedAtSec;
      pool.completedRequests += 1;
      changedBlockIds.add(request.blockId);

      if (request.mode === 'service') {
        sim.scheduleIn(
          SERVICE_COMPLETE_EVENT,
          request.durationSec,
          {
            entityId: request.entityId,
            blockId: request.blockId,
            resourcePoolId: request.resourcePoolId,
            quantity: request.quantity
          },
          { priority: 40 }
        );
      } else {
        const entity = this.requireEntity(request.entityId);
        entity.resourceHoldings[request.resourcePoolId] = (entity.resourceHoldings[request.resourcePoolId] ?? 0) + request.quantity;
        this.incrementCompleted(request.blockId);
        this.routeFromBlock(sim, request.blockId, entity);
      }
    }

    for (const blockId of changedBlockIds) {
      this.tryDrainResourceGateForBlock(sim, blockId);
      this.tryDrainBlockedQueuesForReceiver(sim, blockId);
      this.tryDrainBlockedEntities(sim, blockId);
    }
  }

  private releaseEntityResource(sim: DesSimulation<ProcessRuntimeState>, entity: ProcessEntity, resourcePoolId: string, quantity: number): void {
    const held = entity.resourceHoldings[resourcePoolId] ?? 0;
    if (held < quantity) {
      throw new Error(`Entity ${entity.id} cannot release ${quantity} from ${resourcePoolId}; only ${held} held`);
    }

    entity.resourceHoldings[resourcePoolId] = held - quantity;
    if (entity.resourceHoldings[resourcePoolId] === 0) {
      delete entity.resourceHoldings[resourcePoolId];
    }

    const pool = this.requireResourcePool(resourcePoolId);
    this.accrueResourceBusyTime(pool, sim.nowSec);
    pool.available += quantity;
    if (pool.available > pool.capacity) {
      throw new Error(`Resource pool ${resourcePoolId} released above capacity`);
    }
    this.tryStartWaitingRequests(sim, pool);
  }

  private enqueueTransporterMove(sim: DesSimulation<ProcessRuntimeState>, request: TransporterMoveRequest): void {
    this.requireMaterialHandling(request.blockId);
    this.requireTransporterFleetStats(request.fleetId).moveRequests += 1;
    const waits = this.transporterWaits.get(request.fleetId) ?? [];
    waits.push(request);
    this.transporterWaits.set(request.fleetId, waits);
    this.requireStats(request.blockId).maxQueueLength = Math.max(this.requireStats(request.blockId).maxQueueLength, waits.length);
    this.tryStartTransporterMoves(sim, request.fleetId);
  }

  private tryStartTransporterMoves(sim: DesSimulation<ProcessRuntimeState>, fleetId: string): void {
    const materialHandling = this.requireMaterialHandling(`fleet:${fleetId}`);
    const waits = this.transporterWaits.get(fleetId) ?? [];
    let index = 0;

    while (index < waits.length) {
      const request = waits[index]!;
      const unit = materialHandling.seizeTransporter(fleetId, request.entityId, request.fromNodeId);
      if (!unit) {
        break;
      }

      waits.splice(index, 1);
      const stats = this.requireTransporterFleetStats(fleetId);
      stats.startedMoves += 1;
      stats.totalWaitTimeSec += sim.nowSec - request.queuedAtSec;
      this.scheduleTransportCompletion(sim, request, unit);
    }

    if (waits.length === 0) {
      this.transporterWaits.delete(fleetId);
    }
  }

  private scheduleTransportCompletion(
    sim: DesSimulation<ProcessRuntimeState>,
    request: TransporterMoveRequest,
    unit: TransporterUnitState
  ): void {
    const materialHandling = this.requireMaterialHandling(request.blockId);
    const plan: MaterialTransportTaskPlan = materialHandling.planTransportTask({
      unit,
      fleetId: request.fleetId,
      entityId: request.entityId,
      fromNodeId: request.fromNodeId,
      toNodeId: request.toNodeId,
      loadTimeSec: request.loadTimeSec,
      unloadTimeSec: request.unloadTimeSec,
      requestedStartSec: sim.nowSec
    });
    const emptyRoute = plan.emptyRoute;
    const loadedRoute = plan.loadedRoute;
    const routeDistanceM = emptyRoute.distanceM + loadedRoute.distanceM;
    const routeTravelTimeSec = emptyRoute.travelTimeSec + loadedRoute.travelTimeSec;
    const routeTrafficWaitSec = plan.trafficWaitSec;
    const routePathTrafficWaitSec = emptyRoute.pathTrafficWaitSec + loadedRoute.pathTrafficWaitSec;
    const routeNodeTrafficWaitSec = emptyRoute.nodeTrafficWaitSec + loadedRoute.nodeTrafficWaitSec;
    const busyDurationSec = plan.completionSec - sim.nowSec;
    this.activeTransports.set(unit.id, {
      transporterUnitId: unit.id,
      fleetId: request.fleetId,
      entityId: request.entityId,
      blockId: request.blockId,
      startSec: sim.nowSec,
      endSec: plan.completionSec,
      requestQueuedAtSec: request.queuedAtSec,
      dispatchWaitSec: sim.nowSec - request.queuedAtSec,
      emptyFromNodeId: unit.currentNodeId,
      emptyToNodeId: request.fromNodeId,
      emptyRouteNodeIds: emptyRoute.nodeIds,
      emptyTravelStartSec: emptyRoute.travelStartSec,
      emptyTravelEndSec: emptyRoute.travelEndSec,
      emptyTrafficWaitSec: emptyRoute.trafficWaitSec,
      loadStartSec: emptyRoute.travelEndSec,
      loadEndSec: plan.loadEndSec,
      loadedFromNodeId: request.fromNodeId,
      loadedToNodeId: request.toNodeId,
      loadedRouteNodeIds: loadedRoute.nodeIds,
      loadedTravelStartSec: loadedRoute.travelStartSec,
      loadedTravelEndSec: loadedRoute.travelEndSec,
      loadedTrafficWaitSec: loadedRoute.trafficWaitSec,
      emptyPathTrafficWaitSec: emptyRoute.pathTrafficWaitSec,
      emptyNodeTrafficWaitSec: emptyRoute.nodeTrafficWaitSec,
      loadedPathTrafficWaitSec: loadedRoute.pathTrafficWaitSec,
      loadedNodeTrafficWaitSec: loadedRoute.nodeTrafficWaitSec,
      unloadStartSec: loadedRoute.travelEndSec,
      unloadEndSec: plan.unloadEndSec,
      trafficWaitSec: routeTrafficWaitSec,
      pathTrafficWaitSec: routePathTrafficWaitSec,
      nodeTrafficWaitSec: routeNodeTrafficWaitSec
    });
    const entity = this.requireEntity(request.entityId);
    entity.attributes.lastEmptyRouteDistanceM = emptyRoute.distanceM;
    entity.attributes.lastEmptyRouteTravelTimeSec = emptyRoute.travelTimeSec;
    entity.attributes.lastEmptyRouteTrafficWaitSec = emptyRoute.trafficWaitSec;
    entity.attributes.lastEmptyRoutePathTrafficWaitSec = emptyRoute.pathTrafficWaitSec;
    entity.attributes.lastEmptyRouteNodeTrafficWaitSec = emptyRoute.nodeTrafficWaitSec;
    entity.attributes.lastEmptyRoutePath = emptyRoute.pathIds.join('>');
    entity.attributes.lastLoadedRouteDistanceM = loadedRoute.distanceM;
    entity.attributes.lastLoadedRouteTravelTimeSec = loadedRoute.travelTimeSec;
    entity.attributes.lastLoadedRouteTrafficWaitSec = loadedRoute.trafficWaitSec;
    entity.attributes.lastLoadedRoutePathTrafficWaitSec = loadedRoute.pathTrafficWaitSec;
    entity.attributes.lastLoadedRouteNodeTrafficWaitSec = loadedRoute.nodeTrafficWaitSec;
    entity.attributes.lastLoadedRoutePath = loadedRoute.pathIds.join('>');
    entity.attributes.lastRouteDistanceM = routeDistanceM;
    entity.attributes.lastRouteTravelTimeSec = routeTravelTimeSec;
    entity.attributes.lastRouteTrafficWaitSec = routeTrafficWaitSec;
    entity.attributes.lastRoutePathTrafficWaitSec = routePathTrafficWaitSec;
    entity.attributes.lastRouteNodeTrafficWaitSec = routeNodeTrafficWaitSec;
    entity.attributes.lastRoutePath = [...emptyRoute.pathIds, ...loadedRoute.pathIds].join('>');

    sim.scheduleIn(
      TRANSPORT_COMPLETE_EVENT,
      busyDurationSec,
      {
        entityId: request.entityId,
        blockId: request.blockId,
        fleetId: request.fleetId,
        transporterUnitId: unit.id,
        toNodeId: request.toNodeId,
        busyDurationSec,
        emptyDistanceM: emptyRoute.distanceM,
        loadedDistanceM: loadedRoute.distanceM,
        trafficWaitSec: routeTrafficWaitSec,
        pathTrafficWaitSec: routePathTrafficWaitSec,
        nodeTrafficWaitSec: routeNodeTrafficWaitSec,
        emptyTrafficWaitSec: emptyRoute.trafficWaitSec,
        loadedTrafficWaitSec: loadedRoute.trafficWaitSec,
        emptyPathTrafficWaitSec: emptyRoute.pathTrafficWaitSec,
        emptyNodeTrafficWaitSec: emptyRoute.nodeTrafficWaitSec,
        loadedPathTrafficWaitSec: loadedRoute.pathTrafficWaitSec,
        loadedNodeTrafficWaitSec: loadedRoute.nodeTrafficWaitSec,
        emptyTravelTimeSec: emptyRoute.travelTimeSec,
        loadedTravelTimeSec: loadedRoute.travelTimeSec
      },
      { priority: 45 }
    );
  }

  private routeFromBlock(sim: DesSimulation<ProcessRuntimeState>, blockId: string, entity: ProcessEntity): void {
    const next = this.requireNextConnection(blockId, entity);
    this.tryRouteEntity(sim, entity, blockId, next.to);
  }

  private tryRouteEntity(
    sim: DesSimulation<ProcessRuntimeState>,
    entity: ProcessEntity,
    fromBlockId: string,
    toBlockId: string
  ): boolean {
    const admission = this.checkAdmission(toBlockId);
    if (admission.status === 'accepted') {
      this.reservePendingAdmission(toBlockId);
      sim.scheduleAt(
        ENTITY_ENTER_EVENT,
        sim.nowSec,
        { entityId: entity.id, blockId: toBlockId },
        { priority: 60 }
      );
      return true;
    }

    if (admission.status === 'blocked') {
      this.blockOutputForReceiver({
        entityId: entity.id,
        fromBlockId,
        toBlockId,
        queuedAtSec: sim.nowSec,
        reason: admission.reason
      });
      return false;
    }

    const stats = this.requireStats(fromBlockId);
    stats.rejectedCount += 1;
    return false;
  }

  private checkAdmission(blockId: string): AdmissionResult {
    const block = this.requireBlock(blockId);
    switch (block.kind) {
      case 'queue':
        return this.queueCanAccept(block)
          ? { status: 'accepted' }
          : { status: 'blocked', reason: 'queue-full', receiverBlockId: block.id };
      case 'service':
      case 'seize':
        return this.resourceBlockCanAccept(block)
          ? { status: 'accepted' }
          : { status: 'blocked', reason: 'resource-queue-full', receiverBlockId: block.id };
      case 'hold':
        return this.holdBlockCanAccept(block)
          ? { status: 'accepted' }
          : { status: 'blocked', reason: 'hold-queue-full', receiverBlockId: block.id };
      case 'convey': {
        const materialHandling = this.requireMaterialHandling(block.id);
        const conveyor = materialHandling.getConveyor(block.conveyorId);
        const conveyorState = materialHandling.getSnapshot().conveyorStates.find((state) => state.conveyorId === block.conveyorId);
        const pending = this.pendingAdmissionsByBlock.get(block.id) ?? 0;
        return materialHandling.canEnterConveyor(block.conveyorId) && (conveyorState?.wip.length ?? 0) + pending < (conveyor.capacity ?? 1)
          ? { status: 'accepted' }
          : { status: 'blocked', reason: 'conveyor-full', receiverBlockId: block.id };
      }
      default:
        return { status: 'accepted' };
    }
  }

  private queueCanAccept(block: Extract<ProcessFlowBlockDefinition, { kind: 'queue' }>): boolean {
    const queue = this.queueWaits.get(block.id) ?? [];
    const pending = this.pendingAdmissionsByBlock.get(block.id) ?? 0;
    return block.capacity === undefined || queue.length + pending < block.capacity;
  }

  private resourceBlockCanAccept(block: Extract<ProcessFlowBlockDefinition, { kind: 'service' | 'seize' }>): boolean {
    if (block.queueCapacity === undefined) {
      return true;
    }

    const pool = this.requireResourcePool(block.resourcePoolId);
    const waitingForBlock = pool.waiting.filter((waiting) => waiting.blockId === block.id).length;
    const pending = this.pendingAdmissionsByBlock.get(block.id) ?? 0;
    const immediateSlots = Math.floor(pool.available / block.quantity);
    const waitingSlots = Math.max(0, block.queueCapacity - waitingForBlock);
    return pending < immediateSlots + waitingSlots;
  }

  private holdBlockCanAccept(block: Extract<ProcessFlowBlockDefinition, { kind: 'hold' }>): boolean {
    if (!block.signalId || block.queueCapacity === undefined) {
      return true;
    }

    const waits = this.holdWaitsBySignal.get(block.signalId) ?? [];
    const pending = this.pendingAdmissionsByBlock.get(block.id) ?? 0;
    return waits.filter((wait) => wait.blockId === block.id).length + pending < block.queueCapacity;
  }

  private reservePendingAdmission(blockId: string): void {
    this.pendingAdmissionsByBlock.set(blockId, (this.pendingAdmissionsByBlock.get(blockId) ?? 0) + 1);
  }

  private releasePendingAdmission(blockId: string): void {
    const pending = this.pendingAdmissionsByBlock.get(blockId) ?? 0;
    if (pending <= 1) {
      this.pendingAdmissionsByBlock.delete(blockId);
    } else {
      this.pendingAdmissionsByBlock.set(blockId, pending - 1);
    }
  }

  private blockOutputForReceiver(route: BlockedEntityRoute): void {
    const existing = this.blockedOutputsByReceiver.get(route.toBlockId) ?? [];
    if (existing.some((candidate) => candidate.entityId === route.entityId && candidate.fromBlockId === route.fromBlockId)) {
      return;
    }

    existing.push(route);
    this.blockedOutputsByReceiver.set(route.toBlockId, existing);
    this.requireStats(route.fromBlockId).blockedOutputCount += 1;
  }

  private tryDrainBlockedEntities(sim: DesSimulation<ProcessRuntimeState>, receiverBlockId: string): void {
    const blocked = this.blockedOutputsByReceiver.get(receiverBlockId) ?? [];
    if (blocked.length === 0) {
      return;
    }

    const remaining: BlockedEntityRoute[] = [];
    for (const route of blocked) {
      const admission = this.checkAdmission(route.toBlockId);
      if (admission.status !== 'accepted') {
        remaining.push(route);
        continue;
      }

      const stats = this.requireStats(route.fromBlockId);
      stats.blockedOutputCount = Math.max(0, stats.blockedOutputCount - 1);
      const entity = this.requireEntity(route.entityId);
      entity.attributes.lastBlockedReason = route.reason;
      entity.attributes.lastBlockedWaitSec = sim.nowSec - route.queuedAtSec;
      this.reservePendingAdmission(route.toBlockId);
      sim.scheduleAt(
        ENTITY_ENTER_EVENT,
        sim.nowSec,
        { entityId: route.entityId, blockId: route.toBlockId },
        { priority: 60 }
      );
    }

    if (remaining.length === 0) {
      this.blockedOutputsByReceiver.delete(receiverBlockId);
    } else {
      this.blockedOutputsByReceiver.set(receiverBlockId, remaining);
    }
  }

  private rememberBlockedQueue(receiverBlockId: string, queueBlockId: string): void {
    const queueIds = this.blockedQueuesByReceiver.get(receiverBlockId) ?? new Set<string>();
    queueIds.add(queueBlockId);
    this.blockedQueuesByReceiver.set(receiverBlockId, queueIds);
  }

  private tryDrainBlockedQueuesForReceiver(sim: DesSimulation<ProcessRuntimeState>, receiverBlockId: string): void {
    const queueIds = this.blockedQueuesByReceiver.get(receiverBlockId);
    if (!queueIds || queueIds.size === 0) {
      return;
    }

    this.blockedQueuesByReceiver.delete(receiverBlockId);
    for (const queueBlockId of [...queueIds].sort()) {
      this.tryDrainQueue(sim, queueBlockId);
    }
  }

  private enqueueQueueWait(blockId: string, entry: QueueWaitEntry): void {
    const waits = this.queueWaits.get(blockId) ?? [];
    waits.push(entry);
    this.queueWaits.set(blockId, waits);
    this.updateBlockWaitStats(blockId, waits.length);
  }

  private enqueueQueueGateWait(blockId: string, entry: QueueWaitEntry): void {
    const waits = this.queueGateWaits.get(blockId) ?? [];
    waits.push(entry);
    this.queueGateWaits.set(blockId, waits);
    this.requireStats(blockId).blockedOutputCount += 1;
  }

  private tryDrainQueue(sim: DesSimulation<ProcessRuntimeState>, blockId: string): void {
    if (this.drainingQueueIds.has(blockId)) {
      return;
    }

    const block = this.requireBlock(blockId);
    if (block.kind !== 'queue') {
      throw new Error(`Block ${blockId} is not a queue`);
    }

    this.drainingQueueIds.add(blockId);
    try {
      this.admitQueueGateEntries(block);
      const queue = this.queueWaits.get(blockId) ?? [];
      while (queue.length > 0) {
        const entry = queue[0]!;
        const entity = this.requireEntity(entry.entityId);
        const next = this.requireNextConnection(blockId, entity);
        const admission = this.checkAdmission(next.to);
        if (admission.status !== 'accepted') {
          this.rememberBlockedQueue(next.to, blockId);
          break;
        }

        queue.shift();
        this.recordBlockWaitCompletion(blockId, sim.nowSec - entry.queuedAtSec);
        this.incrementCompleted(blockId);
        this.updateBlockWaitStats(blockId, queue.length);
        this.reservePendingAdmission(next.to);
        sim.scheduleAt(
          ENTITY_ENTER_EVENT,
          sim.nowSec,
          { entityId: entity.id, blockId: next.to },
          { priority: 60 }
        );
        this.tryDrainBlockedEntities(sim, blockId);
        this.tryDrainBlockedQueuesForReceiver(sim, blockId);
        this.admitQueueGateEntries(block);
      }

      if (queue.length === 0) {
        this.queueWaits.delete(blockId);
      } else {
        this.queueWaits.set(blockId, queue);
      }
      this.updateBlockWaitStats(blockId, queue.length);
    } finally {
      this.drainingQueueIds.delete(blockId);
    }
  }

  private admitQueueGateEntries(block: Extract<ProcessFlowBlockDefinition, { kind: 'queue' }>): void {
    const gate = this.queueGateWaits.get(block.id) ?? [];
    while (gate.length > 0 && this.queueCanAccept(block)) {
      const entry = gate.shift()!;
      const stats = this.requireStats(block.id);
      stats.blockedOutputCount = Math.max(0, stats.blockedOutputCount - 1);
      this.enqueueQueueWait(block.id, entry);
    }

    if (gate.length === 0) {
      this.queueGateWaits.delete(block.id);
    } else {
      this.queueGateWaits.set(block.id, gate);
    }
  }

  private updateBlockWaitStats(blockId: string, currentQueueLength: number): void {
    const stats = this.requireStats(blockId);
    stats.currentQueueLength = currentQueueLength;
    stats.maxQueueLength = Math.max(stats.maxQueueLength, currentQueueLength);
  }

  private recordBlockWaitCompletion(blockId: string, waitSec: number): void {
    const stats = this.requireStats(blockId);
    stats.totalWaitTimeSec += waitSec;
    stats.completedWaits += 1;
    stats.averageWaitTimeSec = stats.totalWaitTimeSec / stats.completedWaits;
  }

  private tryDrainResourceGateForBlock(sim: DesSimulation<ProcessRuntimeState>, blockId: string): void {
    const block = this.requireBlock(blockId);
    if (block.kind !== 'service' && block.kind !== 'seize') {
      return;
    }

    const waits = this.resourceGateWaitsByBlock.get(blockId) ?? [];
    if (waits.length === 0) {
      return;
    }

    while (waits.length > 0 && this.resourceBlockCanAccept(block)) {
      const request = waits.shift()!;
      const stats = this.requireStats(blockId);
      stats.blockedOutputCount = Math.max(0, stats.blockedOutputCount - 1);
      this.enqueueResourceRequest(sim, request, block.queueCapacity);
    }

    if (waits.length === 0) {
      this.resourceGateWaitsByBlock.delete(blockId);
    } else {
      this.resourceGateWaitsByBlock.set(blockId, waits);
    }
  }

  private tryDrainStorageStoreWaits(sim: DesSimulation<ProcessRuntimeState>, storageId: string): void {
    const waits = this.storageStoreWaitsByStorage.get(storageId) ?? [];
    if (waits.length === 0) {
      return;
    }

    while (waits.length > 0) {
      const wait = waits[0]!;
      if (!this.requireMaterialHandling(wait.blockId).canStore(wait.storageId, wait.itemId)) {
        break;
      }

      waits.shift();
      this.recordBlockWaitCompletion(wait.blockId, sim.nowSec - wait.queuedAtSec);
      this.updateBlockWaitStats(wait.blockId, waits.length);
      this.completeStoreBlock(sim, wait.blockId, wait.storageId, this.requireEntity(wait.entityId), wait.itemId, wait.sku);
    }

    if (waits.length === 0) {
      this.storageStoreWaitsByStorage.delete(storageId);
    } else {
      this.storageStoreWaitsByStorage.set(storageId, waits);
    }
  }

  private tryDrainStorageRetrieveWaits(sim: DesSimulation<ProcessRuntimeState>, storageId: string): void {
    const waits = this.storageRetrieveWaitsByStorage.get(storageId) ?? [];
    if (waits.length === 0) {
      return;
    }

    let index = 0;
    while (index < waits.length) {
      const wait = waits[index]!;
      if (!this.requireMaterialHandling(wait.blockId).canRetrieve(wait.storageId, wait.query, wait.policy)) {
        index += 1;
        continue;
      }

      waits.splice(index, 1);
      this.recordBlockWaitCompletion(wait.blockId, sim.nowSec - wait.queuedAtSec);
      this.updateBlockWaitStats(wait.blockId, waits.length);
      this.completeRetrieveBlock(sim, wait.blockId, wait.storageId, this.requireEntity(wait.entityId), wait.query, wait.policy);
    }

    if (waits.length === 0) {
      this.storageRetrieveWaitsByStorage.delete(storageId);
    } else {
      this.storageRetrieveWaitsByStorage.set(storageId, waits);
    }
  }

  private tryDrainConveyorWaits(sim: DesSimulation<ProcessRuntimeState>, conveyorId: string): void {
    const waits = this.conveyorWaitsByConveyor.get(conveyorId) ?? [];
    if (waits.length === 0) {
      return;
    }

    while (waits.length > 0 && this.requireMaterialHandling(waits[0]!.blockId).canEnterConveyor(conveyorId)) {
      const wait = waits.shift()!;
      this.recordBlockWaitCompletion(wait.blockId, sim.nowSec - wait.queuedAtSec);
      this.updateBlockWaitStats(wait.blockId, waits.length);
      this.enterConveyor(sim, wait.blockId, conveyorId, this.requireEntity(wait.entityId));
    }

    if (waits.length === 0) {
      this.conveyorWaitsByConveyor.delete(conveyorId);
    } else {
      this.conveyorWaitsByConveyor.set(conveyorId, waits);
    }
  }

  private requireNextConnection(blockId: string, entity: ProcessEntity): ProcessConnectionDefinition {
    const connections = this.outgoing.get(blockId) ?? [];
    if (connections.length === 0) {
      throw new Error(`Block ${blockId} has no outgoing connection`);
    }

    const block = this.requireBlock(blockId);
    const matched = block.kind === 'selectOutput'
      ? this.selectOutputConnection(connections, entity)
      : connections.find((connection) => this.matchesCondition(entity, connection));

    if (!matched) {
      throw new Error(`Block ${blockId} has no outgoing connection matching entity ${entity.id}`);
    }

    return matched;
  }

  private selectOutputConnection(connections: ProcessConnectionDefinition[], entity: ProcessEntity): ProcessConnectionDefinition | undefined {
    const conditionalMatches = connections.filter((connection) => connection.condition && this.matchesCondition(entity, connection));
    const unconditional = connections.filter((connection) => !connection.condition);
    const eligible = conditionalMatches.length > 0 ? [...conditionalMatches, ...unconditional] : unconditional;
    const probabilistic = eligible.filter((connection) => connection.probability !== undefined);

    if (probabilistic.length === 0) {
      return conditionalMatches[0] ?? unconditional[0];
    }

    const draw = this.random();
    let cumulativeProbability = 0;
    for (const connection of probabilistic) {
      cumulativeProbability += connection.probability ?? 0;
      if (draw <= cumulativeProbability || Math.abs(draw - cumulativeProbability) <= 1e-12) {
        return connection;
      }
    }

    if (cumulativeProbability >= 1 - 1e-12) {
      return probabilistic.at(-1);
    }

    return eligible.find((connection) => connection.probability === undefined);
  }

  private matchesCondition(entity: ProcessEntity, connection: ProcessConnectionDefinition): boolean {
    if (!connection.condition) {
      return true;
    }

    const actual = entity.attributes[connection.condition.attribute];
    const expected = connection.condition.value;

    switch (connection.condition.operator) {
      case 'equals':
        return actual === expected;
      case 'not-equals':
        return actual !== expected;
      case 'greater-than':
        return typeof actual === 'number' && typeof expected === 'number' && actual > expected;
      case 'greater-than-or-equal':
        return typeof actual === 'number' && typeof expected === 'number' && actual >= expected;
      case 'less-than':
        return typeof actual === 'number' && typeof expected === 'number' && actual < expected;
      case 'less-than-or-equal':
        return typeof actual === 'number' && typeof expected === 'number' && actual <= expected;
      default:
        connection.condition.operator satisfies never;
        return false;
    }
  }

  private incrementEntered(blockId: string): void {
    this.requireStats(blockId).entered += 1;
  }

  private incrementCompleted(blockId: string): void {
    this.requireStats(blockId).completed += 1;
  }

  private requireStats(blockId: string): ProcessBlockStats {
    const stats = this.blockStats.get(blockId);
    if (!stats) {
      throw new Error(`Unknown block stats for ${blockId}`);
    }
    return stats;
  }

  private requireBlock(blockId: string): ProcessFlowBlockDefinition {
    const block = this.blockMap.get(blockId);
    if (!block) {
      throw new Error(`Unknown process block ${blockId}`);
    }
    return block;
  }

  private requireEntity(entityId: string): ProcessEntity {
    const entity = this.entities.get(entityId);
    if (!entity) {
      throw new Error(`Unknown process entity ${entityId}`);
    }
    return entity;
  }

  private requireResourcePool(resourcePoolId: string): RuntimeResourcePoolMutableState {
    const pool = this.resourcePools.get(resourcePoolId);
    if (!pool) {
      throw new Error(`Unknown resource pool ${resourcePoolId}`);
    }
    return pool;
  }

  private requireMaterialHandling(blockId: string): MaterialHandlingRuntime {
    if (!this.materialHandling) {
      throw new Error(`Block ${blockId} requires a material handling runtime`);
    }

    return this.materialHandling;
  }

  private itemIdFor(entity: ProcessEntity, itemIdAttribute?: string): string {
    return valueAsItemId(itemIdAttribute ? entity.attributes[itemIdAttribute] : undefined, entity.id);
  }

  private sampleTime(definition: TimeValueDefinition, context: string): number {
    return sampleTimeSec(definition, this.random, context);
  }
}

export type ProcessFlowRuntimeOptions = {
  materialHandling?: MaterialHandlingRuntime | null;
  seed?: number;
  random?: RandomSource;
};

export function createProcessFlowSimulation(definition: ProcessFlowDefinition, options: ProcessFlowRuntimeOptions = {}): ProcessFlowRunResult {
  const simulation = new DesSimulation<ProcessRuntimeState>({});
  const runtime = new ProcessFlowRuntime(definition, options.materialHandling ?? null, options.random ?? createSeededRandom(options.seed));
  runtime.attach(simulation);
  return {
    simulation,
    runtime,
    snapshot: runtime.getSnapshot(simulation.nowSec),
    runResult: null
  };
}

export function runProcessFlow(
  definition: ProcessFlowDefinition,
  untilSec: number,
  maxEvents?: number,
  options: ProcessFlowRuntimeOptions = {}
): ProcessFlowRunResult {
  const result = createProcessFlowSimulation(definition, options);
  const runResult = result.simulation.runUntil(untilSec, maxEvents);
  return {
    ...result,
    snapshot: result.runtime.getSnapshot(result.simulation.nowSec),
    runResult
  };
}
