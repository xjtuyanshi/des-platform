import { DesSimulation, type DesEventPayload, type DesRunResult } from '@des-platform/des-core';
import type { MaterialHandlingRuntime, MaterialHandlingSnapshot, TransporterUnitState } from '@des-platform/material-handling';
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
const SERVICE_COMPLETE_EVENT = 'process.service.complete';
const TRANSPORT_COMPLETE_EVENT = 'process.material.transport.complete';

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
  maxQueueLength: number;
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
  totalEmptyTrafficWaitTimeSec: number;
  totalLoadedTrafficWaitTimeSec: number;
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
  emptyTrafficWaitSec: number;
  loadedTrafficWaitSec: number;
  emptyTravelTimeSec: number;
  loadedTravelTimeSec: number;
};

function asSourceCreatePayload(payload: DesEventPayload): SourceCreatePayload {
  return { sourceId: String(payload.sourceId) };
}

function asEntityEnterPayload(payload: DesEventPayload): EntityEnterPayload {
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
    emptyTrafficWaitSec: Number(payload.emptyTrafficWaitSec),
    loadedTrafficWaitSec: Number(payload.loadedTrafficWaitSec),
    emptyTravelTimeSec: Number(payload.emptyTravelTimeSec),
    loadedTravelTimeSec: Number(payload.loadedTravelTimeSec)
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
  private readonly transporterFleetStats = new Map<string, RuntimeTransporterFleetMutableStats>();
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
        maxQueueLength: 0
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
    sim.on(SERVICE_COMPLETE_EVENT, ({ sim: runtime, event }) => this.handleServiceComplete(runtime, asServiceCompletePayload(event.payload)));
    sim.on(TRANSPORT_COMPLETE_EVENT, ({ sim: runtime, event }) => this.handleTransportComplete(runtime, asTransportCompletePayload(event.payload)));
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
      totalEmptyTrafficWaitTimeSec: 0,
      totalLoadedTrafficWaitTimeSec: 0,
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
          ENTITY_ENTER_EVENT,
          this.sampleTime(block.durationSec, `${block.id}.durationSec`),
          { entityId: entity.id, blockId: this.requireNextConnection(block.id, entity).to },
          { priority: 50 }
        );
        this.incrementCompleted(block.id);
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
      case 'store':
        this.requireMaterialHandling(block.id).store(block.storageId, this.itemIdFor(entity, block.itemIdAttribute));
        entity.attributes.storageId = block.storageId;
        this.incrementCompleted(block.id);
        this.routeFromBlock(sim, block.id, entity);
        break;
      case 'retrieve':
        this.requireMaterialHandling(block.id).retrieve(block.storageId, this.itemIdFor(entity, block.itemIdAttribute));
        entity.attributes.storageId = null;
        this.incrementCompleted(block.id);
        this.routeFromBlock(sim, block.id, entity);
        break;
      case 'convey': {
        const materialHandling = this.requireMaterialHandling(block.id);
        const conveyor = materialHandling.getConveyor(block.conveyorId);
        entity.attributes.conveyorId = block.conveyorId;
        entity.attributes.locationNodeId = conveyor.exitNodeId;
        sim.scheduleIn(
          ENTITY_ENTER_EVENT,
          materialHandling.getConveyorTravelTimeSec(block.conveyorId),
          { entityId: entity.id, blockId: this.requireNextConnection(block.id, entity).to },
          { priority: 50 }
        );
        this.incrementCompleted(block.id);
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

  private handleTransportComplete(sim: DesSimulation<ProcessRuntimeState>, payload: TransportCompletePayload): void {
    const entity = this.requireEntity(payload.entityId);
    const materialHandling = this.requireMaterialHandling(payload.blockId);
    const stats = this.requireTransporterFleetStats(payload.fleetId);
    stats.completedMoves += 1;
    stats.totalBusyTimeSec += payload.busyDurationSec;
    stats.totalEmptyDistanceM += payload.emptyDistanceM;
    stats.totalLoadedDistanceM += payload.loadedDistanceM;
    stats.totalTrafficWaitTimeSec += payload.trafficWaitSec;
    stats.totalEmptyTrafficWaitTimeSec += payload.emptyTrafficWaitSec;
    stats.totalLoadedTrafficWaitTimeSec += payload.loadedTrafficWaitSec;
    stats.totalEmptyTravelTimeSec += payload.emptyTravelTimeSec;
    stats.totalLoadedTravelTimeSec += payload.loadedTravelTimeSec;
    materialHandling.releaseTransporter(payload.transporterUnitId, payload.toNodeId);
    entity.attributes.locationNodeId = payload.toNodeId;
    entity.attributes.lastTransporterFleetId = payload.fleetId;
    entity.attributes.lastTransporterUnitId = payload.transporterUnitId;
    this.incrementCompleted(payload.blockId);
    this.tryStartTransporterMoves(sim, payload.fleetId);
    this.routeFromBlock(sim, payload.blockId, entity);
  }

  private handleQueueBlock(sim: DesSimulation<ProcessRuntimeState>, block: Extract<ProcessFlowBlockDefinition, { kind: 'queue' }>, entity: ProcessEntity): void {
    const stats = this.requireStats(block.id);
    const transientLength = stats.entered - stats.completed;
    if (block.capacity !== undefined && transientLength >= block.capacity) {
      throw new Error(`Queue ${block.id} capacity ${block.capacity} exceeded`);
    }

    stats.maxQueueLength = Math.max(stats.maxQueueLength, transientLength + 1);
    this.incrementCompleted(block.id);
    this.routeFromBlock(sim, block.id, entity);
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
    if (queueCapacity !== undefined && waitingForBlock >= queueCapacity) {
      throw new Error(`Resource queue for block ${request.blockId} exceeded capacity ${queueCapacity}`);
    }

    pool.waiting.push(request);
    pool.maxQueueLength = Math.max(pool.maxQueueLength, pool.waiting.length);
    this.requireStats(request.blockId).maxQueueLength = Math.max(this.requireStats(request.blockId).maxQueueLength, waitingForBlock + 1);
    this.tryStartWaitingRequests(sim, pool);
  }

  private tryStartWaitingRequests(sim: DesSimulation<ProcessRuntimeState>, pool: RuntimeResourcePoolMutableState): void {
    let index = 0;
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
      const unit = materialHandling.seizeTransporter(fleetId, request.entityId);
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
    const emptyRoute = materialHandling.reserveRoute(unit.currentNodeId, request.fromNodeId, request.fleetId, sim.nowSec);
    const loadedReadyAtSec = emptyRoute.travelEndSec + request.loadTimeSec;
    const loadedRoute = materialHandling.reserveRoute(request.fromNodeId, request.toNodeId, request.fleetId, loadedReadyAtSec);
    const routeDistanceM = emptyRoute.distanceM + loadedRoute.distanceM;
    const routeTravelTimeSec = emptyRoute.travelTimeSec + loadedRoute.travelTimeSec;
    const routeTrafficWaitSec = emptyRoute.trafficWaitSec + loadedRoute.trafficWaitSec;
    const busyDurationSec = loadedRoute.travelEndSec + request.unloadTimeSec - sim.nowSec;
    const entity = this.requireEntity(request.entityId);
    entity.attributes.lastEmptyRouteDistanceM = emptyRoute.distanceM;
    entity.attributes.lastEmptyRouteTravelTimeSec = emptyRoute.travelTimeSec;
    entity.attributes.lastEmptyRouteTrafficWaitSec = emptyRoute.trafficWaitSec;
    entity.attributes.lastEmptyRoutePath = emptyRoute.pathIds.join('>');
    entity.attributes.lastLoadedRouteDistanceM = loadedRoute.distanceM;
    entity.attributes.lastLoadedRouteTravelTimeSec = loadedRoute.travelTimeSec;
    entity.attributes.lastLoadedRouteTrafficWaitSec = loadedRoute.trafficWaitSec;
    entity.attributes.lastLoadedRoutePath = loadedRoute.pathIds.join('>');
    entity.attributes.lastRouteDistanceM = routeDistanceM;
    entity.attributes.lastRouteTravelTimeSec = routeTravelTimeSec;
    entity.attributes.lastRouteTrafficWaitSec = routeTrafficWaitSec;
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
        emptyTrafficWaitSec: emptyRoute.trafficWaitSec,
        loadedTrafficWaitSec: loadedRoute.trafficWaitSec,
        emptyTravelTimeSec: emptyRoute.travelTimeSec,
        loadedTravelTimeSec: loadedRoute.travelTimeSec
      },
      { priority: 45 }
    );
  }

  private routeFromBlock(sim: DesSimulation<ProcessRuntimeState>, blockId: string, entity: ProcessEntity): void {
    const next = this.requireNextConnection(blockId, entity);
    sim.scheduleAt(
      ENTITY_ENTER_EVENT,
      sim.nowSec,
      { entityId: entity.id, blockId: next.to },
      { priority: 60 }
    );
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
