import {
  MaterialHandlingDefinitionSchema,
  type ConveyorDefinition,
  type MaterialHandlingDefinition,
  type MaterialNodeDefinition,
  type MaterialPathDefinition,
  type StorageSystemDefinition,
  type TransporterFleetDefinition
} from '@des-platform/shared-schema/model-dsl';

export type MaterialRoutePlan = {
  nodeIds: string[];
  pathIds: string[];
  distanceM: number;
  travelTimeSec: number;
};

export type MaterialRouteSegmentReservation = {
  pathId: string;
  fromNodeId: string;
  toNodeId: string;
  distanceM: number;
  travelTimeSec: number;
  requestedStartSec: number;
  startSec: number;
  endSec: number;
  trafficWaitSec: number;
};

export type MaterialReservedRoutePlan = MaterialRoutePlan & {
  requestedStartSec: number;
  travelStartSec: number;
  travelEndSec: number;
  trafficWaitSec: number;
  reservedDurationSec: number;
  segments: MaterialRouteSegmentReservation[];
};

export type TransporterUnitState = {
  id: string;
  fleetId: string;
  status: 'idle' | 'busy' | 'down';
  currentNodeId: string;
  assignedEntityId: string | null;
};

export type StorageSlotState = {
  id: string;
  itemId: string | null;
};

export type StorageSystemState = {
  id: string;
  nodeId: string;
  capacity: number;
  slots: StorageSlotState[];
};

export type MaterialHandlingSnapshot = {
  nodes: MaterialNodeDefinition[];
  paths: MaterialPathDefinition[];
  pathReservations: PathReservationState[];
  transporterUnits: TransporterUnitState[];
  storageSystems: StorageSystemState[];
  conveyors: ConveyorDefinition[];
  zones: MaterialHandlingDefinition['zones'];
  obstacles: MaterialHandlingDefinition['obstacles'];
};

type PathEdge = {
  path: MaterialPathDefinition;
  from: string;
  to: string;
  distanceM: number;
  speedMps: number | null;
};

export type PathReservationState = {
  pathId: string;
  capacity: number;
  reservations: Array<{
    startSec: number;
    endSec: number;
  }>;
};

function distance2d(left: MaterialNodeDefinition, right: MaterialNodeDefinition): number {
  return Math.hypot(right.x - left.x, right.z - left.z);
}

export class MaterialHandlingRuntime {
  private readonly definition: MaterialHandlingDefinition;
  private readonly nodeMap = new Map<string, MaterialNodeDefinition>();
  private readonly adjacency = new Map<string, PathEdge[]>();
  private readonly transporterUnits = new Map<string, TransporterUnitState>();
  private readonly storageSystems = new Map<string, StorageSystemState>();
  private readonly pathReservations = new Map<string, Array<{ startSec: number; endSec: number }>>();

  constructor(definition: MaterialHandlingDefinition) {
    this.definition = MaterialHandlingDefinitionSchema.parse(definition);

    for (const node of this.definition.nodes) {
      this.nodeMap.set(node.id, node);
      this.adjacency.set(node.id, []);
    }

    for (const path of this.definition.paths) {
      this.addEdge(path, path.from, path.to);
      if (path.bidirectional) {
        this.addEdge(path, path.to, path.from);
      }
    }

    for (const fleet of this.definition.transporterFleets) {
      this.createTransporterUnits(fleet);
    }

    for (const storage of this.definition.storageSystems) {
      this.storageSystems.set(storage.id, this.createStorageState(storage));
    }
  }

  getSnapshot(): MaterialHandlingSnapshot {
    return {
      nodes: [...this.nodeMap.values()].map((node) => ({ ...node })),
      paths: this.definition.paths.map((path) => ({ ...path })),
      pathReservations: this.definition.paths.map((path) => ({
        pathId: path.id,
        capacity: path.capacity,
        reservations: (this.pathReservations.get(path.id) ?? []).map((reservation) => ({ ...reservation }))
      })),
      transporterUnits: [...this.transporterUnits.values()].map((unit) => ({ ...unit })),
      storageSystems: [...this.storageSystems.values()].map((storage) => ({
        ...storage,
        slots: storage.slots.map((slot) => ({ ...slot }))
      })),
      conveyors: this.definition.conveyors.map((conveyor) => ({ ...conveyor })),
      zones: this.definition.zones.map((zone) => ({
        ...zone,
        polygon: zone.polygon.map((point) => ({ ...point }))
      })),
      obstacles: this.definition.obstacles.map((obstacle) => ({ ...obstacle }))
    };
  }

  findShortestRoute(startNodeId: string, endNodeId: string, fleetId?: string): MaterialRoutePlan {
    this.requireNode(startNodeId);
    this.requireNode(endNodeId);
    if (startNodeId === endNodeId) {
      return {
        nodeIds: [startNodeId],
        pathIds: [],
        distanceM: 0,
        travelTimeSec: 0
      };
    }

    const defaultSpeedMps = fleetId ? this.requireFleet(fleetId).speedMps : 1;
    const open = new Set<string>([startNodeId]);
    const cameFrom = new Map<string, { nodeId: string; pathId: string }>();
    const distanceScore = new Map<string, number>([[startNodeId, 0]]);
    const timeScore = new Map<string, number>([[startNodeId, 0]]);

    while (open.size > 0) {
      const currentId = [...open].sort((left, right) => {
        const delta = (timeScore.get(left) ?? Number.POSITIVE_INFINITY) - (timeScore.get(right) ?? Number.POSITIVE_INFINITY);
        return Math.abs(delta) > 1e-9 ? delta : left.localeCompare(right);
      })[0]!;

      if (currentId === endNodeId) {
        return this.buildRoutePlan(startNodeId, endNodeId, cameFrom, distanceScore.get(endNodeId) ?? 0, timeScore.get(endNodeId) ?? 0);
      }

      open.delete(currentId);
      for (const edge of this.adjacency.get(currentId) ?? []) {
        const edgeSpeedMps = edge.speedMps ?? defaultSpeedMps;
        const edgeTimeSec = edge.distanceM / edgeSpeedMps;
        const tentativeTime = (timeScore.get(currentId) ?? Number.POSITIVE_INFINITY) + edgeTimeSec;
        if (tentativeTime < (timeScore.get(edge.to) ?? Number.POSITIVE_INFINITY)) {
          cameFrom.set(edge.to, { nodeId: currentId, pathId: edge.path.id });
          distanceScore.set(edge.to, (distanceScore.get(currentId) ?? 0) + edge.distanceM);
          timeScore.set(edge.to, tentativeTime);
          open.add(edge.to);
        }
      }
    }

    throw new Error(`No material handling route between ${startNodeId} and ${endNodeId}`);
  }

  reserveRoute(startNodeId: string, endNodeId: string, fleetId: string | undefined, requestedStartSec: number): MaterialReservedRoutePlan {
    const route = this.findShortestRoute(startNodeId, endNodeId, fleetId);
    if (route.pathIds.length === 0) {
      return {
        ...route,
        requestedStartSec,
        travelStartSec: requestedStartSec,
        travelEndSec: requestedStartSec,
        trafficWaitSec: 0,
        reservedDurationSec: 0,
        segments: []
      };
    }

    const segments: MaterialRouteSegmentReservation[] = [];
    let currentSec = requestedStartSec;
    let trafficWaitSec = 0;

    for (let index = 0; index < route.pathIds.length; index += 1) {
      const fromNodeId = route.nodeIds[index]!;
      const toNodeId = route.nodeIds[index + 1]!;
      const edge = this.requireEdge(fromNodeId, toNodeId, route.pathIds[index]!);
      const speedMps = edge.speedMps ?? (fleetId ? this.requireFleet(fleetId).speedMps : 1);
      const travelTimeSec = edge.distanceM / speedMps;
      const startSec = this.reservePath(edge.path, currentSec, travelTimeSec);
      const endSec = startSec + travelTimeSec;
      const segmentWaitSec = startSec - currentSec;
      trafficWaitSec += segmentWaitSec;
      segments.push({
        pathId: edge.path.id,
        fromNodeId,
        toNodeId,
        distanceM: edge.distanceM,
        travelTimeSec,
        requestedStartSec: currentSec,
        startSec,
        endSec,
        trafficWaitSec: segmentWaitSec
      });
      currentSec = endSec;
    }

    return {
      ...route,
      requestedStartSec,
      travelStartSec: segments[0]?.startSec ?? requestedStartSec,
      travelEndSec: currentSec,
      trafficWaitSec,
      reservedDurationSec: currentSec - requestedStartSec,
      segments
    };
  }

  seizeTransporter(fleetId: string, entityId: string): TransporterUnitState | null {
    this.requireFleet(fleetId);
    const unit = [...this.transporterUnits.values()]
      .filter((candidate) => candidate.fleetId === fleetId && candidate.status === 'idle')
      .sort((left, right) => left.id.localeCompare(right.id))[0];

    if (!unit) {
      return null;
    }

    unit.status = 'busy';
    unit.assignedEntityId = entityId;
    return { ...unit };
  }

  releaseTransporter(unitId: string, nodeId?: string): TransporterUnitState {
    const unit = this.requireTransporterUnit(unitId);
    if (nodeId) {
      this.requireNode(nodeId);
      unit.currentNodeId = nodeId;
    }
    unit.status = 'idle';
    unit.assignedEntityId = null;
    return { ...unit };
  }

  store(storageId: string, itemId: string): StorageSlotState {
    const storage = this.requireStorage(storageId);
    if (storage.slots.some((slot) => slot.itemId === itemId)) {
      throw new Error(`Item ${itemId} is already stored in ${storageId}`);
    }

    const slot = storage.slots.find((candidate) => candidate.itemId === null);
    if (!slot) {
      throw new Error(`Storage system ${storageId} is full`);
    }

    slot.itemId = itemId;
    return { ...slot };
  }

  retrieve(storageId: string, itemId: string): StorageSlotState {
    const storage = this.requireStorage(storageId);
    const slot = storage.slots.find((candidate) => candidate.itemId === itemId);
    if (!slot) {
      throw new Error(`Item ${itemId} is not stored in ${storageId}`);
    }

    slot.itemId = null;
    return { ...slot };
  }

  getConveyorTravelTimeSec(conveyorId: string): number {
    const conveyor = this.requireConveyor(conveyorId);
    return conveyor.lengthM / conveyor.speedMps;
  }

  getConveyor(conveyorId: string): ConveyorDefinition {
    return { ...this.requireConveyor(conveyorId) };
  }

  private addEdge(path: MaterialPathDefinition, from: string, to: string): void {
    const fromNode = this.requireNode(from);
    const toNode = this.requireNode(to);
    const distanceM = path.lengthM ?? distance2d(fromNode, toNode);
    this.adjacency.get(from)?.push({
      path,
      from,
      to,
      distanceM,
      speedMps: path.speedLimitMps ?? null
    });
  }

  private reservePath(path: MaterialPathDefinition, requestedStartSec: number, durationSec: number): number {
    if (path.trafficControl === 'none' || durationSec <= 0) {
      return requestedStartSec;
    }

    const reservations = this.pathReservations.get(path.id) ?? [];
    const startSec = this.findEarliestReservationStart(reservations, path.capacity, requestedStartSec, durationSec);
    reservations.push({ startSec, endSec: startSec + durationSec });
    reservations.sort((left, right) => left.startSec - right.startSec || left.endSec - right.endSec);
    this.pathReservations.set(path.id, reservations);
    return startSec;
  }

  private findEarliestReservationStart(
    reservations: Array<{ startSec: number; endSec: number }>,
    capacity: number,
    requestedStartSec: number,
    durationSec: number
  ): number {
    let candidateStartSec = requestedStartSec;

    while (true) {
      const candidateEndSec = candidateStartSec + durationSec;
      const overlapping = reservations.filter((reservation) => reservation.startSec < candidateEndSec && candidateStartSec < reservation.endSec);
      if (overlapping.length < capacity) {
        return candidateStartSec;
      }

      candidateStartSec = Math.min(...overlapping.map((reservation) => reservation.endSec));
    }
  }

  private createTransporterUnits(fleet: TransporterFleetDefinition): void {
    for (let index = 1; index <= fleet.count; index += 1) {
      const id = `${fleet.id}-${index}`;
      this.transporterUnits.set(id, {
        id,
        fleetId: fleet.id,
        status: 'idle',
        currentNodeId: fleet.homeNodeId,
        assignedEntityId: null
      });
    }
  }

  private createStorageState(storage: StorageSystemDefinition): StorageSystemState {
    const slotIds = storage.slotIds ?? Array.from({ length: storage.capacity }, (_, index) => `${storage.id}-slot-${index + 1}`);
    return {
      id: storage.id,
      nodeId: storage.nodeId,
      capacity: storage.capacity,
      slots: slotIds.map((id) => ({
        id,
        itemId: null
      }))
    };
  }

  private buildRoutePlan(
    startNodeId: string,
    endNodeId: string,
    cameFrom: Map<string, { nodeId: string; pathId: string }>,
    distanceM: number,
    travelTimeSec: number
  ): MaterialRoutePlan {
    const nodeIds = [endNodeId];
    const pathIds: string[] = [];

    while (nodeIds[0] !== startNodeId) {
      const previous = cameFrom.get(nodeIds[0]!);
      if (!previous) {
        throw new Error(`Broken material handling route ending at ${endNodeId}`);
      }
      pathIds.unshift(previous.pathId);
      nodeIds.unshift(previous.nodeId);
    }

    return {
      nodeIds,
      pathIds,
      distanceM,
      travelTimeSec
    };
  }

  private requireNode(nodeId: string): MaterialNodeDefinition {
    const node = this.nodeMap.get(nodeId);
    if (!node) {
      throw new Error(`Unknown material handling node ${nodeId}`);
    }
    return node;
  }

  private requireEdge(fromNodeId: string, toNodeId: string, pathId: string): PathEdge {
    const edge = (this.adjacency.get(fromNodeId) ?? []).find((candidate) => candidate.to === toNodeId && candidate.path.id === pathId);
    if (!edge) {
      throw new Error(`Unknown material handling edge ${pathId} from ${fromNodeId} to ${toNodeId}`);
    }
    return edge;
  }

  private requireFleet(fleetId: string): TransporterFleetDefinition {
    const fleet = this.definition.transporterFleets.find((candidate) => candidate.id === fleetId);
    if (!fleet) {
      throw new Error(`Unknown transporter fleet ${fleetId}`);
    }
    return fleet;
  }

  private requireTransporterUnit(unitId: string): TransporterUnitState {
    const unit = this.transporterUnits.get(unitId);
    if (!unit) {
      throw new Error(`Unknown transporter unit ${unitId}`);
    }
    return unit;
  }

  private requireStorage(storageId: string): StorageSystemState {
    const storage = this.storageSystems.get(storageId);
    if (!storage) {
      throw new Error(`Unknown storage system ${storageId}`);
    }
    return storage;
  }

  private requireConveyor(conveyorId: string): ConveyorDefinition {
    const conveyor = this.definition.conveyors.find((candidate) => candidate.id === conveyorId);
    if (!conveyor) {
      throw new Error(`Unknown conveyor ${conveyorId}`);
    }
    return conveyor;
  }
}

export function createMaterialHandlingRuntime(definition: MaterialHandlingDefinition): MaterialHandlingRuntime {
  return new MaterialHandlingRuntime(definition);
}
