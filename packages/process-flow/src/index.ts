import { DesSimulation, type DesEventPayload } from '@des-platform/des-core';
import {
  ProcessFlowDefinitionSchema,
  type DslLiteral,
  type ProcessConnectionDefinition,
  type ProcessFlowBlockDefinition,
  type ProcessFlowDefinition,
  type ResourcePoolDefinition
} from '@des-platform/shared-schema/model-dsl';

const SOURCE_CREATE_EVENT = 'process.source.create';
const ENTITY_ENTER_EVENT = 'process.entity.enter';
const SERVICE_COMPLETE_EVENT = 'process.service.complete';

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
};

export type ProcessFlowSnapshot = {
  nowSec: number;
  createdEntities: number;
  completedEntities: number;
  entities: ProcessEntity[];
  resourcePools: RuntimeResourcePoolState[];
  blockStats: Record<string, ProcessBlockStats>;
};

export type ProcessFlowRunResult = {
  simulation: DesSimulation;
  runtime: ProcessFlowRuntime;
  snapshot: ProcessFlowSnapshot;
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

function cloneAttributes(attributes: Record<string, DslLiteral>): Record<string, DslLiteral> {
  return { ...attributes };
}

export class ProcessFlowRuntime {
  private readonly definition: ProcessFlowDefinition;
  private readonly blockMap = new Map<string, ProcessFlowBlockDefinition>();
  private readonly outgoing = new Map<string, ProcessConnectionDefinition[]>();
  private readonly resourcePools = new Map<string, RuntimeResourcePoolState>();
  private readonly sourceArrivalCounts = new Map<string, number>();
  private readonly entities = new Map<string, ProcessEntity>();
  private readonly completedEntityIds: string[] = [];
  private readonly blockStats = new Map<string, ProcessBlockStats>();
  private attached = false;

  constructor(definition: ProcessFlowDefinition) {
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
      resourcePools: [...this.resourcePools.values()].map((pool) => ({
        id: pool.id,
        capacity: pool.capacity,
        available: pool.available,
        waiting: pool.waiting.map((request) => ({ ...request })),
        maxQueueLength: pool.maxQueueLength
      })),
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

  private createResourcePoolState(pool: ResourcePoolDefinition): RuntimeResourcePoolState {
    return {
      id: pool.id,
      capacity: pool.capacity,
      available: pool.initialAvailable ?? pool.capacity,
      waiting: [],
      maxQueueLength: 0
    };
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
      this.scheduleSourceCreate(sim, block.id, sim.nowSec + block.intervalSec);
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
          block.durationSec,
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
          durationSec: block.durationSec,
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
      case 'selectOutput':
        this.incrementCompleted(block.id);
        this.routeFromBlock(sim, block.id, entity);
        break;
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

  private tryStartWaitingRequests(sim: DesSimulation<ProcessRuntimeState>, pool: RuntimeResourcePoolState): void {
    let index = 0;
    while (index < pool.waiting.length) {
      const request = pool.waiting[index]!;
      if (request.quantity > pool.available) {
        index += 1;
        continue;
      }

      pool.waiting.splice(index, 1);
      pool.available -= request.quantity;

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
    pool.available += quantity;
    if (pool.available > pool.capacity) {
      throw new Error(`Resource pool ${resourcePoolId} released above capacity`);
    }
    this.tryStartWaitingRequests(sim, pool);
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
    const matched =
      block.kind === 'selectOutput'
        ? connections.find((connection) => connection.condition && this.matchesCondition(entity, connection)) ??
          connections.find((connection) => !connection.condition)
        : connections.find((connection) => this.matchesCondition(entity, connection));

    if (!matched) {
      throw new Error(`Block ${blockId} has no outgoing connection matching entity ${entity.id}`);
    }

    return matched;
  }

  private matchesCondition(entity: ProcessEntity, connection: ProcessConnectionDefinition): boolean {
    if (!connection.condition) {
      return true;
    }

    const actual = entity.attributes[connection.condition.attribute];
    const equals = actual === connection.condition.value;
    return connection.condition.operator === 'equals' ? equals : !equals;
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

  private requireResourcePool(resourcePoolId: string): RuntimeResourcePoolState {
    const pool = this.resourcePools.get(resourcePoolId);
    if (!pool) {
      throw new Error(`Unknown resource pool ${resourcePoolId}`);
    }
    return pool;
  }
}

export function createProcessFlowSimulation(definition: ProcessFlowDefinition): ProcessFlowRunResult {
  const simulation = new DesSimulation<ProcessRuntimeState>({});
  const runtime = new ProcessFlowRuntime(definition);
  runtime.attach(simulation);
  return {
    simulation,
    runtime,
    snapshot: runtime.getSnapshot(simulation.nowSec)
  };
}

export function runProcessFlow(definition: ProcessFlowDefinition, untilSec: number, maxEvents?: number): ProcessFlowRunResult {
  const result = createProcessFlowSimulation(definition);
  result.simulation.runUntil(untilSec, maxEvents);
  return {
    ...result,
    snapshot: result.runtime.getSnapshot(result.simulation.nowSec)
  };
}
