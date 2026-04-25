import RAPIER from '@dimforge/rapier3d-compat/rapier.es.js';
import type { AMR } from '@des-platform/domain-model';
import type { LayoutDefinition } from '@des-platform/shared-schema';
import type { AiNativeDesModelDefinition, MaterialHandlingDefinition } from '@des-platform/shared-schema/model-dsl';

type Point2 = {
  x: number;
  z: number;
};

type GraphNode = Point2 & {
  id: string;
};

type RouteWaypoint = Point2 & {
  id: string;
  nodeId?: string;
};

type RouteState = {
  waypoints: RouteWaypoint[];
  waypointIndex: number;
  destinationNodeId: string;
};

type RectObstacle = {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
};

type GridCell = {
  gx: number;
  gz: number;
};

export type RoutePlan = {
  nodeIds: string[];
  distanceM: number;
};

export type MotionArrival = {
  amrId: string;
  nodeId: string;
};

export type MotionTickResult = {
  arrivals: MotionArrival[];
};

export type RouteProgress = {
  targetNodeId: string | null;
  destinationNodeId: string | null;
  nodeIds: string[];
  remainingDistanceM: number;
};

type MaterialSnapshotLike = {
  nodes: Array<{ id: string; x: number; z: number }>;
  transporterUnits: Array<{ id: string; fleetId: string; status: string; currentNodeId: string; assignedEntityId: string | null }>;
  obstacles: MaterialHandlingDefinition['obstacles'];
};

type ActiveTransportLike = {
  transporterUnitId: string;
  fleetId: string;
  entityId: string;
  blockId: string;
  endSec: number;
  emptyRouteNodeIds: string[];
  emptyTravelStartSec: number;
  emptyTravelEndSec: number;
  loadStartSec: number;
  loadEndSec: number;
  loadedRouteNodeIds: string[];
  loadedTravelStartSec: number;
  loadedTravelEndSec: number;
  unloadStartSec: number;
  unloadEndSec: number;
  loadedToNodeId: string;
};

export type MaterialMotionVerificationOptions = {
  enabled?: boolean;
  tickSec?: number;
  clearanceM?: number;
  maxLagSec?: number;
};

export type MaterialMotionVerificationUnit = {
  unitId: string;
  fleetId: string;
  entityId: string | null;
  x: number;
  z: number;
  status: 'idle' | 'moving' | 'waiting' | 'loading' | 'unloading';
  targetNodeId: string | null;
  speedMps: number;
  minSeparationM: number | null;
  avoidanceStatus: 'clear' | 'near-miss' | 'blocked' | 'waiting';
  desEtaSec: number | null;
  physicsEtaSec: number | null;
  lagSec: number;
};

export type MaterialMotionVerificationWarning = {
  code: string;
  severity: 'warning' | 'error';
  unitId?: string;
  message: string;
};

export type MaterialMotionVerificationSnapshot = {
  enabled: boolean;
  tickSec: number;
  clearanceM: number;
  maxLagSec: number;
  units: MaterialMotionVerificationUnit[];
  warnings: MaterialMotionVerificationWarning[];
};

const FREE_SPACE_GRID_STEP_M = 0.8;
const STATIC_CLEARANCE_M = 1.12;
const ROUTE_ARRIVAL_TOLERANCE_M = 0.12;
const DYNAMIC_SAFETY_MARGIN_M = 0.38;
const DYNAMIC_HARD_MARGIN_M = 0.12;
const MIN_DYNAMIC_SEPARATION_M = 1.55;

function distance2d(left: Point2, right: Point2): number {
  return Math.hypot(right.x - left.x, right.z - left.z);
}

function waypointIdFor(point: Point2, index: number): string {
  return `free:${index}:${point.x.toFixed(2)}:${point.z.toFixed(2)}`;
}

function cellKey(cell: GridCell): string {
  return `${cell.gx},${cell.gz}`;
}

function parseCellKey(key: string): GridCell {
  const [gx, gz] = key.split(',').map(Number);
  return { gx: gx ?? 0, gz: gz ?? 0 };
}

function computeFloorCenterZ(layout: LayoutDefinition): number {
  if (layout.walls.length > 0) {
    return layout.walls.reduce((sum, wall) => sum + wall.z, 0) / layout.walls.length;
  }

  const allZ = [
    ...layout.aisleGraph.nodes.map((node) => node.z),
    ...layout.stations.flatMap((station) => station.binSlots.map((slot) => slot.z)),
    layout.line.start.z,
    layout.line.end.z
  ];
  return allZ.reduce((sum, z) => sum + z, 0) / Math.max(1, allZ.length);
}

function inflatedRect(
  item: { x: number; z: number; width: number; depth: number },
  clearanceM: number
): RectObstacle {
  return {
    minX: item.x - item.width / 2 - clearanceM,
    maxX: item.x + item.width / 2 + clearanceM,
    minZ: item.z - item.depth / 2 - clearanceM,
    maxZ: item.z + item.depth / 2 + clearanceM
  };
}

class FreeSpacePlanner {
  private readonly minX = 0;
  private readonly maxX: number;
  private readonly minZ: number;
  private readonly maxZ: number;
  private readonly cellsX: number;
  private readonly cellsZ: number;
  private readonly blocked = new Set<string>();

  constructor(private readonly layout: LayoutDefinition, private readonly stepM = FREE_SPACE_GRID_STEP_M) {
    const floorCenterZ = computeFloorCenterZ(layout);
    this.maxX = layout.floor.width;
    this.minZ = floorCenterZ - layout.floor.depth / 2;
    this.maxZ = floorCenterZ + layout.floor.depth / 2;
    this.cellsX = Math.floor((this.maxX - this.minX) / this.stepM) + 1;
    this.cellsZ = Math.floor((this.maxZ - this.minZ) / this.stepM) + 1;

    const staticObstacles = this.buildStaticObstacles();
    for (let gx = 0; gx < this.cellsX; gx += 1) {
      for (let gz = 0; gz < this.cellsZ; gz += 1) {
        const point = this.pointForCell({ gx, gz });
        if (staticObstacles.some((rect) => this.pointInsideRect(point, rect))) {
          this.blocked.add(cellKey({ gx, gz }));
        }
      }
    }
  }

  plan(start: Point2, destination: GraphNode): RouteWaypoint[] {
    const startCell = this.findNearestWalkableCell(this.cellForPoint(start), start);
    const destinationCell = this.findNearestWalkableCell(this.cellForPoint(destination), destination);
    const cellPath = this.findCellPath(startCell, destinationCell);
    const points = this.compressPath(cellPath).map((cell) => this.pointForCell(cell));

    if (points.length === 0) {
      return [];
    }

    points[0] = { x: start.x, z: start.z };
    points[points.length - 1] = { x: destination.x, z: destination.z };

    return points.slice(1).map((point, index, allPoints) => ({
      x: point.x,
      z: point.z,
      id: index === allPoints.length - 1 ? destination.id : waypointIdFor(point, index),
      nodeId: index === allPoints.length - 1 ? destination.id : undefined
    }));
  }

  isPointWalkable(point: Point2): boolean {
    return this.isWalkable(this.cellForPoint(point));
  }

  private buildStaticObstacles(): RectObstacle[] {
    const obstacles = [...this.layout.obstacles, ...this.layout.walls].map((obstacle) =>
      inflatedRect(obstacle, STATIC_CLEARANCE_M)
    );

    const lineMinX = Math.min(this.layout.line.start.x, this.layout.line.end.x);
    const lineMaxX = Math.max(this.layout.line.start.x, this.layout.line.end.x);
    const lineCenterX = (lineMinX + lineMaxX) / 2;
    const lineCenterZ = (this.layout.line.start.z + this.layout.line.end.z) / 2;
    obstacles.push(
      inflatedRect(
        {
          x: lineCenterX,
          z: lineCenterZ,
          width: lineMaxX - lineMinX,
          depth: this.layout.line.width
        },
        STATIC_CLEARANCE_M * 0.72
      )
    );

    return obstacles;
  }

  private findCellPath(start: GridCell, destination: GridCell): GridCell[] {
    const startKey = cellKey(start);
    const destinationKey = cellKey(destination);
    if (startKey === destinationKey) {
      return [start];
    }

    const open = new Set<string>([startKey]);
    const cameFrom = new Map<string, string>();
    const gScore = new Map<string, number>([[startKey, 0]]);
    const fScore = new Map<string, number>([
      [startKey, this.gridDistance(start, destination)]
    ]);

    while (open.size > 0) {
      const currentKey = [...open].sort((left, right) => {
        const scoreDelta = (fScore.get(left) ?? Number.POSITIVE_INFINITY) - (fScore.get(right) ?? Number.POSITIVE_INFINITY);
        return Math.abs(scoreDelta) > 1e-9 ? scoreDelta : left.localeCompare(right);
      })[0]!;

      if (currentKey === destinationKey) {
        const pathKeys = [currentKey];
        while (cameFrom.has(pathKeys[0]!)) {
          pathKeys.unshift(cameFrom.get(pathKeys[0]!)!);
        }
        return pathKeys.map(parseCellKey);
      }

      open.delete(currentKey);
      const current = parseCellKey(currentKey);
      for (const neighbor of this.neighbors(current)) {
        const neighborKey = cellKey(neighbor);
        const tentativeGScore = (gScore.get(currentKey) ?? Number.POSITIVE_INFINITY) + this.gridDistance(current, neighbor);
        if (tentativeGScore < (gScore.get(neighborKey) ?? Number.POSITIVE_INFINITY)) {
          cameFrom.set(neighborKey, currentKey);
          gScore.set(neighborKey, tentativeGScore);
          fScore.set(neighborKey, tentativeGScore + this.gridDistance(neighbor, destination));
          open.add(neighborKey);
        }
      }
    }

    throw new Error(`No free-space route between ${startKey} and ${destinationKey}`);
  }

  private neighbors(cell: GridCell): GridCell[] {
    const neighbors: GridCell[] = [];
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dz = -1; dz <= 1; dz += 1) {
        if (dx === 0 && dz === 0) {
          continue;
        }
        const neighbor = { gx: cell.gx + dx, gz: cell.gz + dz };
        if (!this.isWalkable(neighbor)) {
          continue;
        }
        if (dx !== 0 && dz !== 0 && (!this.isWalkable({ gx: cell.gx + dx, gz: cell.gz }) || !this.isWalkable({ gx: cell.gx, gz: cell.gz + dz }))) {
          continue;
        }
        neighbors.push(neighbor);
      }
    }
    return neighbors.sort((left, right) => cellKey(left).localeCompare(cellKey(right)));
  }

  private compressPath(cells: GridCell[]): GridCell[] {
    if (cells.length <= 2) {
      return cells;
    }

    const compressed: GridCell[] = [cells[0]!];
    let previousDx = Math.sign(cells[1]!.gx - cells[0]!.gx);
    let previousDz = Math.sign(cells[1]!.gz - cells[0]!.gz);

    for (let index = 2; index < cells.length; index += 1) {
      const previous = cells[index - 1]!;
      const current = cells[index]!;
      const dx = Math.sign(current.gx - previous.gx);
      const dz = Math.sign(current.gz - previous.gz);
      if (dx !== previousDx || dz !== previousDz) {
        compressed.push(previous);
        previousDx = dx;
        previousDz = dz;
      }
    }

    compressed.push(cells[cells.length - 1]!);
    return compressed;
  }

  private findNearestWalkableCell(preferred: GridCell, target: Point2): GridCell {
    if (this.isWalkable(preferred)) {
      return preferred;
    }

    const candidates: Array<{ cell: GridCell; distanceM: number }> = [];
    const maxRadius = Math.max(this.cellsX, this.cellsZ);
    for (let radius = 1; radius <= maxRadius; radius += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        for (let dz = -radius; dz <= radius; dz += 1) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) {
            continue;
          }
          const candidate = { gx: preferred.gx + dx, gz: preferred.gz + dz };
          if (this.isWalkable(candidate)) {
            candidates.push({
              cell: candidate,
              distanceM: distance2d(this.pointForCell(candidate), target)
            });
          }
        }
      }
      if (candidates.length > 0) {
        candidates.sort((left, right) => {
          const delta = left.distanceM - right.distanceM;
          return Math.abs(delta) > 1e-9 ? delta : cellKey(left.cell).localeCompare(cellKey(right.cell));
        });
        return candidates[0]!.cell;
      }
    }

    throw new Error(`No walkable grid cell near ${target.x.toFixed(2)},${target.z.toFixed(2)}`);
  }

  private cellForPoint(point: Point2): GridCell {
    return {
      gx: Math.round((point.x - this.minX) / this.stepM),
      gz: Math.round((point.z - this.minZ) / this.stepM)
    };
  }

  private pointForCell(cell: GridCell): Point2 {
    return {
      x: this.minX + cell.gx * this.stepM,
      z: this.minZ + cell.gz * this.stepM
    };
  }

  private isWalkable(cell: GridCell): boolean {
    return (
      cell.gx >= 0 &&
      cell.gz >= 0 &&
      cell.gx < this.cellsX &&
      cell.gz < this.cellsZ &&
      !this.blocked.has(cellKey(cell))
    );
  }

  private gridDistance(left: GridCell, right: GridCell): number {
    return Math.hypot(right.gx - left.gx, right.gz - left.gz) * this.stepM;
  }

  private pointInsideRect(point: Point2, rect: RectObstacle): boolean {
    return point.x >= rect.minX && point.x <= rect.maxX && point.z >= rect.minZ && point.z <= rect.maxZ;
  }
}

export class MotionWorld {
  private readonly world: RAPIER.World;
  private readonly nodeMap = new Map<string, GraphNode>();
  private readonly adjacency = new Map<string, Array<{ id: string; distanceM: number }>>();
  private readonly bodies = new Map<string, RAPIER.RigidBody>();
  private readonly routes = new Map<string, RouteState>();
  private readonly freeSpacePlanner: FreeSpacePlanner;

  private constructor(private readonly layout: LayoutDefinition, world: RAPIER.World) {
    this.world = world;
    this.freeSpacePlanner = new FreeSpacePlanner(layout);

    for (const node of layout.aisleGraph.nodes) {
      this.nodeMap.set(node.id, node);
      this.adjacency.set(node.id, []);
    }

    for (const [from, to] of layout.aisleGraph.edges) {
      const fromNode = this.requireNode(from);
      const toNode = this.requireNode(to);
      const edgeDistance = distance2d(fromNode, toNode);
      this.adjacency.get(from)?.push({ id: to, distanceM: edgeDistance });
      this.adjacency.get(to)?.push({ id: from, distanceM: edgeDistance });
    }
  }

  static async create(layout: LayoutDefinition): Promise<MotionWorld> {
    await RAPIER.init();
    const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
    const motionWorld = new MotionWorld(layout, world);
    motionWorld.addStaticGeometry();
    return motionWorld;
  }

  registerAmrs(amrs: AMR[]): void {
    for (const amr of amrs) {
      const rigidBody = this.world.createRigidBody(
        RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(amr.x, amr.y, amr.z)
      );
      this.world.createCollider(
        RAPIER.ColliderDesc.cuboid(amr.lengthM / 2, amr.heightM / 2, amr.widthM / 2),
        rigidBody
      );
      this.bodies.set(amr.id, rigidBody);
    }
  }

  getNodePosition(nodeId: string): GraphNode {
    return this.requireNode(nodeId);
  }

  estimateRouteDistance(startNodeId: string, destinationNodeId: string): number {
    return this.findShortestPath(startNodeId, destinationNodeId).distanceM;
  }

  estimateTaskDistance(amr: AMR, pickupNodeId: string, dropNodeId: string, returnNodeId: string): number {
    const toPickup = this.estimateRouteDistance(amr.currentNodeId, pickupNodeId);
    const toDropoff = this.estimateRouteDistance(pickupNodeId, dropNodeId);
    const toReturn = this.estimateRouteDistance(dropNodeId, returnNodeId);
    return toPickup + toDropoff + toReturn;
  }

  routeAmrTo(amr: AMR, destinationNodeId: string): RoutePlan {
    const destination = this.requireNode(destinationNodeId);
    const start = { x: amr.x, z: amr.z };
    let waypoints: RouteWaypoint[];

    try {
      waypoints = this.freeSpacePlanner.plan(start, destination);
    } catch {
      const fallbackPlan = this.findShortestPath(amr.currentNodeId, destinationNodeId);
      waypoints = fallbackPlan.nodeIds.slice(1).map((nodeId) => {
        const node = this.requireNode(nodeId);
        return { ...node, nodeId };
      });
    }

    const distanceM = this.measureWaypoints(start, waypoints);
    if (waypoints.length === 0 || distanceM <= ROUTE_ARRIVAL_TOLERANCE_M) {
      this.routes.delete(amr.id);
      return { nodeIds: [destinationNodeId], distanceM: 0 };
    }

    this.routes.set(amr.id, {
      waypoints,
      waypointIndex: 0,
      destinationNodeId
    });

    return {
      nodeIds: [amr.currentNodeId, ...waypoints.map((waypoint) => waypoint.id)],
      distanceM
    };
  }

  hasActiveRoutes(): boolean {
    return this.routes.size > 0;
  }

  getRouteProgress(amr: AMR): RouteProgress {
    const route = this.routes.get(amr.id);
    if (!route) {
      return {
        targetNodeId: null,
        destinationNodeId: null,
        nodeIds: [],
        remainingDistanceM: 0
      };
    }

    const remainingWaypoints = route.waypoints.slice(route.waypointIndex);
    let remainingDistanceM = 0;
    let cursor = { x: amr.x, z: amr.z };
    for (const waypoint of remainingWaypoints) {
      remainingDistanceM += distance2d(cursor, waypoint);
      cursor = waypoint;
    }

    return {
      targetNodeId: remainingWaypoints[0]?.id ?? null,
      destinationNodeId: route.destinationNodeId,
      nodeIds: remainingWaypoints.map((waypoint) => waypoint.id),
      remainingDistanceM
    };
  }

  step(amrs: AMR[], dtSec: number): MotionTickResult {
    const arrivals: MotionArrival[] = [];
    const predictedPositions = new Map<string, Point2>();
    const routeAmrs = [...amrs].sort((left, right) => left.id.localeCompare(right.id));

    for (const amr of routeAmrs) {
      predictedPositions.set(amr.id, { x: amr.x, z: amr.z });
    }

    for (const amr of routeAmrs) {
      const route = this.routes.get(amr.id);
      if (!route) {
        amr.currentSpeedMps = 0;
        continue;
      }

      const rigidBody = this.bodies.get(amr.id);
      if (!rigidBody) {
        throw new Error(`Missing Rapier handles for ${amr.id}`);
      }

      const target = route.waypoints[route.waypointIndex];
      if (!target) {
        this.routes.delete(amr.id);
        continue;
      }

      const current = { x: amr.x, z: amr.z };
      const remaining = distance2d(current, target);

      if (remaining <= ROUTE_ARRIVAL_TOLERANCE_M) {
        this.advanceRoute(amr, route, target, arrivals, routeAmrs);
        predictedPositions.set(amr.id, { x: amr.x, z: amr.z });
        continue;
      }

      const directionX = (target.x - current.x) / remaining;
      const directionZ = (target.z - current.z) / remaining;
      const maxDistance = Math.min(remaining, amr.maxSpeedMps * dtSec);
      const unrestrictedNext = {
        x: current.x + directionX * maxDistance,
        z: current.z + directionZ * maxDistance
      };
      const avoidanceFactor = this.computeDynamicAvoidanceFactor(amr, current, unrestrictedNext, routeAmrs, predictedPositions);
      const desiredDistance = maxDistance * avoidanceFactor;
      let next = {
        x: current.x + directionX * desiredDistance,
        z: current.z + directionZ * desiredDistance
      };
      if (desiredDistance <= 1e-9 && maxDistance > 1e-9) {
        next =
          this.findLocalAvoidanceMove(
            amr,
            current,
            target,
            { x: directionX, z: directionZ },
            maxDistance,
            routeAmrs,
            predictedPositions
          ) ?? next;
      }

      rigidBody.setNextKinematicTranslation({
        x: next.x,
        y: amr.y,
        z: next.z
      });

      const movedDistance = distance2d(current, next);
      amr.x = next.x;
      amr.z = next.z;
      amr.totalDistanceM += movedDistance;
      amr.currentSpeedMps = movedDistance / dtSec;
      amr.busyTimeSec += dtSec;
      if (movedDistance > 1e-6) {
        amr.yawRad = Math.atan2(directionZ, directionX);
      }
      predictedPositions.set(amr.id, { x: amr.x, z: amr.z });

      if (distance2d({ x: amr.x, z: amr.z }, target) <= ROUTE_ARRIVAL_TOLERANCE_M) {
        this.advanceRoute(amr, route, target, arrivals, routeAmrs);
        predictedPositions.set(amr.id, { x: amr.x, z: amr.z });
      }
    }

    this.world.timestep = dtSec;
    this.world.step();
    return { arrivals };
  }

  findShortestPath(startNodeId: string, destinationNodeId: string): RoutePlan {
    if (startNodeId === destinationNodeId) {
      return { nodeIds: [startNodeId], distanceM: 0 };
    }

    const open = new Set<string>([startNodeId]);
    const cameFrom = new Map<string, string>();
    const gScore = new Map<string, number>([[startNodeId, 0]]);
    const fScore = new Map<string, number>([
      [startNodeId, distance2d(this.requireNode(startNodeId), this.requireNode(destinationNodeId))]
    ]);

    while (open.size > 0) {
      let currentId: string | null = null;

      for (const candidateId of open) {
        const scoreDelta =
          (fScore.get(candidateId) ?? Number.POSITIVE_INFINITY) -
          (fScore.get(currentId ?? '') ?? Number.POSITIVE_INFINITY);
        if (
          currentId === null ||
          scoreDelta < -1e-9 ||
          (Math.abs(scoreDelta) <= 1e-9 && candidateId.localeCompare(currentId) < 0)
        ) {
          currentId = candidateId;
        }
      }

      if (currentId === destinationNodeId) {
        const nodeIds = [currentId];
        while (cameFrom.has(nodeIds[0]!)) {
          nodeIds.unshift(cameFrom.get(nodeIds[0]!)!);
        }
        return {
          nodeIds,
          distanceM: gScore.get(destinationNodeId) ?? 0
        };
      }

      open.delete(currentId!);
      for (const neighbor of this.adjacency.get(currentId!) ?? []) {
        const tentativeGScore = (gScore.get(currentId!) ?? Number.POSITIVE_INFINITY) + neighbor.distanceM;
        if (tentativeGScore < (gScore.get(neighbor.id) ?? Number.POSITIVE_INFINITY)) {
          cameFrom.set(neighbor.id, currentId!);
          gScore.set(neighbor.id, tentativeGScore);
          fScore.set(
            neighbor.id,
            tentativeGScore + distance2d(this.requireNode(neighbor.id), this.requireNode(destinationNodeId))
          );
          open.add(neighbor.id);
        }
      }
    }

    throw new Error(`No route between ${startNodeId} and ${destinationNodeId}`);
  }

  private addStaticGeometry(): void {
    for (const obstacle of [...this.layout.obstacles, ...this.layout.walls]) {
      this.world.createCollider(
        RAPIER.ColliderDesc.cuboid(obstacle.width / 2, obstacle.height / 2, obstacle.depth / 2).setTranslation(
          obstacle.x,
          obstacle.height / 2,
          obstacle.z
        )
      );
    }
  }

  private advanceRoute(
    amr: AMR,
    route: RouteState,
    target: RouteWaypoint,
    arrivals: MotionArrival[],
    amrs: AMR[]
  ): void {
    const isFinalWaypoint = route.waypointIndex + 1 >= route.waypoints.length;
    const arrivalPoint = isFinalWaypoint ? this.resolveDockedArrivalPoint(amr, target, amrs) : target;
    amr.x = arrivalPoint.x;
    amr.z = arrivalPoint.z;
    if (target.nodeId) {
      amr.currentNodeId = target.nodeId;
    }
    route.waypointIndex += 1;
    if (route.waypointIndex >= route.waypoints.length) {
      amr.currentNodeId = route.destinationNodeId;
      this.routes.delete(amr.id);
      arrivals.push({ amrId: amr.id, nodeId: route.destinationNodeId });
    }
  }

  private resolveDockedArrivalPoint(amr: AMR, target: Point2, amrs: AMR[]): Point2 {
    const nearestConflict = amrs.some((other) => {
      if (other.id === amr.id) {
        return false;
      }
      return distance2d(target, other) < this.dynamicHardDistance(amr, other);
    });
    if (!nearestConflict) {
      return target;
    }

    const orderedDirections: Point2[] = [
      { x: 0, z: 1 },
      { x: 0, z: -1 },
      { x: 1, z: 0 },
      { x: -1, z: 0 },
      { x: 0.707, z: 0.707 },
      { x: -0.707, z: 0.707 },
      { x: 0.707, z: -0.707 },
      { x: -0.707, z: -0.707 }
    ];
    const baseRadius = Math.max(amr.lengthM, amr.widthM) + DYNAMIC_HARD_MARGIN_M + 0.22;

    for (let ring = 1; ring <= 3; ring += 1) {
      for (const direction of orderedDirections) {
        const candidate = {
          x: target.x + direction.x * baseRadius * ring,
          z: target.z + direction.z * baseRadius * ring
        };
        if (!this.freeSpacePlanner.isPointWalkable(candidate)) {
          continue;
        }

        const hasConflict = amrs.some((other) => {
          if (other.id === amr.id) {
            return false;
          }
          return distance2d(candidate, other) < this.dynamicHardDistance(amr, other);
        });
        if (!hasConflict) {
          return candidate;
        }
      }
    }

    return target;
  }

  private computeDynamicAvoidanceFactor(
    amr: AMR,
    current: Point2,
    proposed: Point2,
    amrs: AMR[],
    predictedPositions: Map<string, Point2>
  ): number {
    let factor = 1;

    for (const other of amrs) {
      if (other.id === amr.id) {
        continue;
      }

      const otherPredicted = predictedPositions.get(other.id) ?? { x: other.x, z: other.z };
      const safetyDistance = Math.max(
        MIN_DYNAMIC_SEPARATION_M,
        Math.max(amr.lengthM, amr.widthM) / 2 + Math.max(other.lengthM, other.widthM) / 2 + DYNAMIC_SAFETY_MARGIN_M
      );
      const hardDistance = this.dynamicHardDistance(amr, other);
      const proposedSeparation = distance2d(proposed, otherPredicted);
      if (proposedSeparation >= safetyDistance) {
        continue;
      }

      const currentSeparation = distance2d(current, otherPredicted);
      const movingCloser = proposedSeparation < currentSeparation - 0.01;
      if (movingCloser && proposedSeparation < hardDistance) {
        return 0;
      }

      const otherHasPriority = other.status !== 'moving' || other.id < amr.id;
      if (otherHasPriority && movingCloser) {
        return 0;
      }

      const bufferRatio = (proposedSeparation - hardDistance) / Math.max(0.001, safetyDistance - hardDistance);
      factor = Math.min(factor, Math.min(0.72, Math.max(0.18, bufferRatio)));
    }

    return factor;
  }

  private findLocalAvoidanceMove(
    amr: AMR,
    current: Point2,
    target: Point2,
    direction: Point2,
    maxDistance: number,
    amrs: AMR[],
    predictedPositions: Map<string, Point2>
  ): Point2 | null {
    const perpendicular = { x: -direction.z, z: direction.x };
    const lateralStep = Math.max(amr.widthM * 0.64, 0.86);
    const forwardStep = Math.max(maxDistance * 0.45, 0.05);
    const candidates: Point2[] = [];

    for (const side of [-1, 1]) {
      candidates.push({
        x: current.x + perpendicular.x * lateralStep * side,
        z: current.z + perpendicular.z * lateralStep * side
      });
      candidates.push({
        x: current.x + direction.x * forwardStep + perpendicular.x * lateralStep * side,
        z: current.z + direction.z * forwardStep + perpendicular.z * lateralStep * side
      });
      candidates.push({
        x: current.x + direction.x * maxDistance * 0.25 + perpendicular.x * lateralStep * 1.55 * side,
        z: current.z + direction.z * maxDistance * 0.25 + perpendicular.z * lateralStep * 1.55 * side
      });
    }

    const currentDistanceToTarget = distance2d(current, target);
    let best: { point: Point2; score: number } | null = null;
    for (const candidate of candidates) {
      if (!this.freeSpacePlanner.isPointWalkable(candidate)) {
        continue;
      }

      const minSeparation = this.minimumDynamicSeparation(amr, candidate, amrs, predictedPositions);
      if (minSeparation < 0) {
        continue;
      }

      const progress = currentDistanceToTarget - distance2d(candidate, target);
      const lateralCost = distance2d(current, candidate);
      const score = minSeparation * 12 + progress - lateralCost * 0.35;
      if (!best || score > best.score) {
        best = { point: candidate, score };
      }
    }

    return best?.point ?? null;
  }

  private minimumDynamicSeparation(
    amr: AMR,
    candidate: Point2,
    amrs: AMR[],
    predictedPositions: Map<string, Point2>
  ): number {
    let minClearance = Number.POSITIVE_INFINITY;
    for (const other of amrs) {
      if (other.id === amr.id) {
        continue;
      }

      const otherPredicted = predictedPositions.get(other.id) ?? { x: other.x, z: other.z };
      const clearance = distance2d(candidate, otherPredicted) - this.dynamicHardDistance(amr, other);
      if (clearance < -1e-6) {
        return -1;
      }
      minClearance = Math.min(minClearance, clearance);
    }

    return minClearance;
  }

  private dynamicHardDistance(amr: AMR, other: AMR): number {
    return Math.max(
      MIN_DYNAMIC_SEPARATION_M,
      Math.max(amr.lengthM, amr.widthM) / 2 + Math.max(other.lengthM, other.widthM) / 2 + DYNAMIC_HARD_MARGIN_M
    );
  }

  private measureWaypoints(start: Point2, waypoints: RouteWaypoint[]): number {
    let distanceM = 0;
    let cursor = start;
    for (const waypoint of waypoints) {
      distanceM += distance2d(cursor, waypoint);
      cursor = waypoint;
    }
    return distanceM;
  }

  private requireNode(nodeId: string): GraphNode {
    const node = this.nodeMap.get(nodeId);
    if (!node) {
      throw new Error(`Unknown aisle node: ${nodeId}`);
    }

    return node;
  }
}

export function verifyMaterialHandlingMotion(input: {
  model: AiNativeDesModelDefinition;
  snapshot: MaterialSnapshotLike | null;
  activeTransports: ActiveTransportLike[];
  nowSec: number;
  options?: MaterialMotionVerificationOptions;
}): MaterialMotionVerificationSnapshot {
  const options = {
    enabled: input.options?.enabled ?? true,
    tickSec: input.options?.tickSec ?? 0.2,
    clearanceM: input.options?.clearanceM ?? 0.25,
    maxLagSec: input.options?.maxLagSec ?? 2
  };
  if (!options.enabled || !input.snapshot || !input.model.materialHandling) {
    return { ...options, enabled: false, units: [], warnings: [] };
  }

  const materialSnapshot = input.snapshot;
  const nodesById = new Map(materialSnapshot.nodes.map((node) => [node.id, node]));
  const fleetsById = new Map(input.model.materialHandling.transporterFleets.map((fleet) => [fleet.id, fleet]));
  const activeByUnitId = new Map(input.activeTransports.map((transport) => [transport.transporterUnitId, transport]));
  const warnings: MaterialMotionVerificationWarning[] = [];
  const units = materialSnapshot.transporterUnits.map((unit) => {
    const transport = activeByUnitId.get(unit.id);
    const fleet = fleetsById.get(unit.fleetId);
    const fleetSpeed = fleet?.speedMps ?? 1;
    const phase = transport ? materialTransportPhase(transport, input.nowSec) : 'idle';
    const routeNodeIds = transport
      ? (phase === 'moving' && input.nowSec < transport.emptyTravelEndSec ? transport.emptyRouteNodeIds : transport.loadedRouteNodeIds)
      : [unit.currentNodeId];
    const point = transport
      ? materialTransportPoint(transport, input.nowSec, nodesById) ?? nodesById.get(unit.currentNodeId) ?? { x: 0, z: 0 }
      : nodesById.get(unit.currentNodeId) ?? { x: 0, z: 0 };
    const remainingDistanceM = transport ? remainingRouteDistance(point, routeNodeIds, nodesById) : 0;
    const physicsEtaSec = transport && phase === 'moving' ? input.nowSec + remainingDistanceM / Math.max(0.001, fleetSpeed) : null;
    const desEtaSec = transport ? transport.endSec : null;
    const lagSec = physicsEtaSec !== null && desEtaSec !== null ? Math.max(0, physicsEtaSec - desEtaSec) : 0;
    const targetNodeId = transport ? routeNodeIds.at(-1) ?? transport.loadedToNodeId : null;
    const verificationUnit: MaterialMotionVerificationUnit = {
      unitId: unit.id,
      fleetId: unit.fleetId,
      entityId: transport?.entityId ?? unit.assignedEntityId,
      x: point.x,
      z: point.z,
      status: phase,
      targetNodeId,
      speedMps: phase === 'moving' ? fleetSpeed : 0,
      minSeparationM: null,
      avoidanceStatus: phase === 'waiting' ? 'waiting' : 'clear',
      desEtaSec,
      physicsEtaSec,
      lagSec
    };

    if (lagSec > options.maxLagSec) {
      warnings.push({
        code: 'motion.eta-lag',
        severity: 'warning',
        unitId: unit.id,
        message: `Physics ETA for ${unit.id} lags DES completion by ${lagSec.toFixed(1)}s.`
      });
    }
    if (transport && routeCrossesObstacle(routeNodeIds, nodesById, materialSnapshot.obstacles, options.clearanceM)) {
      warnings.push({
        code: 'motion.static-obstacle-route',
        severity: 'warning',
        unitId: unit.id,
        message: `Route for ${unit.id} intersects an obstacle clearance envelope.`
      });
      verificationUnit.avoidanceStatus = 'blocked';
    }

    return verificationUnit;
  });

  for (let leftIndex = 0; leftIndex < units.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < units.length; rightIndex += 1) {
      const left = units[leftIndex]!;
      const right = units[rightIndex]!;
      if (left.status === 'idle' && right.status === 'idle') {
        continue;
      }
      const leftFleet = fleetsById.get(left.fleetId);
      const rightFleet = fleetsById.get(right.fleetId);
      const minDistance = Math.max(
        MIN_DYNAMIC_SEPARATION_M,
        (Math.max(leftFleet?.lengthM ?? 1, leftFleet?.widthM ?? 1) + Math.max(rightFleet?.lengthM ?? 1, rightFleet?.widthM ?? 1)) / 2 +
          options.clearanceM
      );
      const separation = Math.hypot(left.x - right.x, left.z - right.z);
      left.minSeparationM = left.minSeparationM === null ? separation : Math.min(left.minSeparationM, separation);
      right.minSeparationM = right.minSeparationM === null ? separation : Math.min(right.minSeparationM, separation);
      if (separation < minDistance) {
        left.avoidanceStatus = 'near-miss';
        right.avoidanceStatus = 'near-miss';
        warnings.push({
          code: 'motion.dynamic-separation',
          severity: 'warning',
          message: `${left.unitId} and ${right.unitId} are ${separation.toFixed(2)}m apart, below ${minDistance.toFixed(2)}m.`
        });
      }
    }
  }

  return {
    ...options,
    enabled: true,
    units,
    warnings
  };
}

function materialTransportPhase(transport: ActiveTransportLike, nowSec: number): MaterialMotionVerificationUnit['status'] {
  if (nowSec < transport.emptyTravelStartSec) return 'waiting';
  if (nowSec < transport.emptyTravelEndSec) return 'moving';
  if (nowSec < transport.loadEndSec) return 'loading';
  if (nowSec < transport.loadedTravelStartSec) return 'waiting';
  if (nowSec < transport.loadedTravelEndSec) return 'moving';
  if (nowSec < transport.unloadEndSec) return 'unloading';
  return 'idle';
}

function materialTransportPoint(
  transport: ActiveTransportLike,
  nowSec: number,
  nodesById: Map<string, Point2>
): Point2 | null {
  if (nowSec < transport.emptyTravelEndSec && transport.emptyTravelEndSec > transport.emptyTravelStartSec) {
    return interpolateNodeRoute(transport.emptyRouteNodeIds, (nowSec - transport.emptyTravelStartSec) / (transport.emptyTravelEndSec - transport.emptyTravelStartSec), nodesById);
  }
  if (nowSec < transport.loadedTravelStartSec) {
    return nodesById.get(transport.emptyRouteNodeIds.at(-1) ?? '') ?? null;
  }
  if (nowSec < transport.loadedTravelEndSec && transport.loadedTravelEndSec > transport.loadedTravelStartSec) {
    return interpolateNodeRoute(transport.loadedRouteNodeIds, (nowSec - transport.loadedTravelStartSec) / (transport.loadedTravelEndSec - transport.loadedTravelStartSec), nodesById);
  }
  return nodesById.get(transport.loadedToNodeId) ?? null;
}

function interpolateNodeRoute(routeNodeIds: string[], progress: number, nodesById: Map<string, Point2>): Point2 | null {
  const points = routeNodeIds.map((id) => nodesById.get(id)).filter((point): point is Point2 => Boolean(point));
  if (points.length === 0) return null;
  if (points.length === 1) return points[0]!;
  const lengths = points.slice(0, -1).map((point, index) => distance2d(point, points[index + 1]!));
  const total = lengths.reduce((sum, value) => sum + value, 0);
  let remaining = Math.max(0, Math.min(1, progress)) * total;
  for (let index = 0; index < lengths.length; index += 1) {
    const length = lengths[index]!;
    if (remaining <= length || index === lengths.length - 1) {
      const from = points[index]!;
      const to = points[index + 1]!;
      const local = length <= 0 ? 1 : remaining / length;
      return { x: from.x + (to.x - from.x) * local, z: from.z + (to.z - from.z) * local };
    }
    remaining -= length;
  }
  return points.at(-1) ?? null;
}

function remainingRouteDistance(point: Point2, routeNodeIds: string[], nodesById: Map<string, Point2>): number {
  const points = routeNodeIds.map((id) => nodesById.get(id)).filter((candidate): candidate is Point2 => Boolean(candidate));
  if (points.length === 0) return 0;
  let closestIndex = 0;
  let closestDistance = Number.POSITIVE_INFINITY;
  for (const [index, candidate] of points.entries()) {
    const distance = distance2d(point, candidate);
    if (distance < closestDistance) {
      closestDistance = distance;
      closestIndex = index;
    }
  }
  let distance = closestDistance;
  for (let index = closestIndex; index < points.length - 1; index += 1) {
    distance += distance2d(points[index]!, points[index + 1]!);
  }
  return distance;
}

function routeCrossesObstacle(
  routeNodeIds: string[],
  nodesById: Map<string, Point2>,
  obstacles: MaterialHandlingDefinition['obstacles'],
  clearanceM: number
): boolean {
  const points = routeNodeIds.map((id) => nodesById.get(id)).filter((point): point is Point2 => Boolean(point));
  for (let index = 0; index < points.length - 1; index += 1) {
    for (const obstacle of obstacles) {
      const rect = inflatedRect({ x: obstacle.x, z: obstacle.z, width: obstacle.widthM, depth: obstacle.depthM }, clearanceM);
      if (segmentIntersectsRect(points[index]!, points[index + 1]!, rect)) {
        return true;
      }
    }
  }
  return false;
}

function segmentIntersectsRect(from: Point2, to: Point2, rect: RectObstacle): boolean {
  const samples = 24;
  for (let index = 0; index <= samples; index += 1) {
    const t = index / samples;
    const point = { x: from.x + (to.x - from.x) * t, z: from.z + (to.z - from.z) * t };
    if (point.x >= rect.minX && point.x <= rect.maxX && point.z >= rect.minZ && point.z <= rect.maxZ) {
      return true;
    }
  }
  return false;
}
