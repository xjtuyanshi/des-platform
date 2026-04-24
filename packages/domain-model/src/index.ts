import type { ScenarioDefinition } from '@des-platform/shared-schema';

export abstract class Resource {
  constructor(public readonly id: string, public readonly name: string) {}
}

export class Container extends Resource {
  constructor(id: string, name: string, public readonly capacity: number, public quantity: number) {
    super(id, name);
  }
}

export class Bin extends Container {
  public pendingRequest = false;
  public active = false;

  constructor(
    id: string,
    name: string,
    capacity: number,
    quantity: number,
    public readonly stationId: string,
    public readonly slotIndex: number
  ) {
    super(id, name, capacity, quantity);
  }

  consume(units = 1): number {
    const consumed = Math.min(this.quantity, units);
    this.quantity -= consumed;
    return consumed;
  }

  refill(): void {
    this.quantity = this.capacity;
    this.pendingRequest = false;
  }
}

export class ConveyorSegment extends Resource {
  constructor(
    id: string,
    name: string,
    public readonly startX: number,
    public readonly endX: number,
    public readonly speedMps: number,
    public readonly elevation: number,
    public readonly pitchM: number
  ) {
    super(id, name);
  }

  get totalLengthM(): number {
    return Math.abs(this.endX - this.startX);
  }
}

export class CarBody extends Resource {
  constructor(
    id: string,
    public readonly releaseTimeSec: number,
    public readonly lengthM: number,
    public readonly widthM: number,
    public readonly heightM: number,
    public readonly color: string
  ) {
    super(id, id);
  }
}

export class SkidCarrier extends Resource {
  constructor(
    id: string,
    public readonly releaseTimeSec: number,
    public readonly lengthM: number,
    public readonly widthM: number,
    public readonly heightM: number
  ) {
    super(id, id);
  }
}

export type StationConsumeResult = {
  emptiedBinIndex: number | null;
  requestBinIndex: number | null;
  starvationStarted: boolean;
  consumed: number;
};

export type StationRefillResult = {
  starvationCleared: boolean;
  clearedDurationSec: number;
};

export class Station extends Resource {
  public readonly bins: [Bin, Bin];
  public activeBinIndex = 0;
  public isStarved = false;
  public starvationCount = 0;
  public starvationStartSec = 0;
  public starvationDurationSec = 0;
  public requestCount = 0;
  public consumedUnits = 0;

  constructor(
    id: string,
    public readonly index: number,
    public readonly qpc: number,
    initialFillRatio = 1
  ) {
    super(id, id);
    const initialQty = Math.max(1, Math.ceil(qpc * initialFillRatio));
    this.bins = [
      new Bin(`${id}-A`, `${id} Bin A`, qpc, initialQty, id, 0),
      new Bin(`${id}-B`, `${id} Bin B`, qpc, qpc, id, 1)
    ];
    this.bins[0].active = true;
  }

  get totalInventory(): number {
    return this.bins[0].quantity + this.bins[1].quantity;
  }

  consumeOne(simTimeSec: number, units = 1): StationConsumeResult {
    const activeBin = this.bins[this.activeBinIndex];
    const consumed = activeBin.consume(units);
    this.consumedUnits += consumed;

    let emptiedBinIndex: number | null = null;
    let requestBinIndex: number | null = null;

    if (activeBin.quantity === 0) {
      emptiedBinIndex = this.activeBinIndex;
      if (!activeBin.pendingRequest) {
        activeBin.pendingRequest = true;
        requestBinIndex = this.activeBinIndex;
        this.requestCount += 1;
      }

      const alternateIndex = this.activeBinIndex === 0 ? 1 : 0;
      if (this.bins[alternateIndex].quantity > 0) {
        activeBin.active = false;
        this.activeBinIndex = alternateIndex;
        this.bins[alternateIndex].active = true;
      }
    }

    let starvationStarted = false;
    if (this.totalInventory <= 0 && !this.isStarved) {
      this.isStarved = true;
      this.starvationCount += 1;
      this.starvationStartSec = simTimeSec;
      starvationStarted = true;
    }

    return {
      emptiedBinIndex,
      requestBinIndex,
      starvationStarted,
      consumed
    };
  }

  refillBin(binIndex: number, simTimeSec: number): StationRefillResult {
    const bin = this.bins[binIndex];
    bin.refill();

    if (this.bins[this.activeBinIndex].quantity <= 0) {
      this.bins[this.activeBinIndex].active = false;
      this.activeBinIndex = binIndex;
      this.bins[binIndex].active = true;
    }

    if (this.isStarved && this.totalInventory > 0) {
      this.isStarved = false;
      const clearedDurationSec = simTimeSec - this.starvationStartSec;
      this.starvationDurationSec += clearedDurationSec;
      return {
        starvationCleared: true,
        clearedDurationSec
      };
    }

    return {
      starvationCleared: false,
      clearedDurationSec: 0
    };
  }

  finalize(endTimeSec: number): void {
    if (this.isStarved) {
      this.starvationDurationSec += endTimeSec - this.starvationStartSec;
    }
  }
}

export type TransportTaskStatus =
  | 'queued'
  | 'assigned'
  | 'to-pickup'
  | 'loading'
  | 'to-dropoff'
  | 'unloading'
  | 'to-return'
  | 'empty-handling'
  | 'done';

export class TransportTask extends Resource {
  public status: TransportTaskStatus = 'queued';
  public assignedAmrId: string | null = null;
  public assignedAtSec: number | null = null;
  public completedAtSec: number | null = null;

  constructor(
    id: string,
    public readonly stationId: string,
    public readonly binId: string,
    public readonly binIndex: number,
    public readonly qpc: number,
    public readonly requestTimeSec: number
  ) {
    super(id, id);
  }

  markAssigned(amrId: string, atSec: number): void {
    this.assignedAmrId = amrId;
    this.assignedAtSec = atSec;
    this.status = 'assigned';
  }

  markCompleted(atSec: number): void {
    this.completedAtSec = atSec;
    this.status = 'done';
  }

  get waitTimeSec(): number {
    return (this.assignedAtSec ?? this.requestTimeSec) - this.requestTimeSec;
  }

  get cycleTimeSec(): number {
    if (this.completedAtSec === null) {
      return 0;
    }

    return this.completedAtSec - this.requestTimeSec;
  }
}

export type AmrStatus = 'idle' | 'moving' | 'handling';
export type AmrPhase = 'idle' | 'to-pickup' | 'loading' | 'to-dropoff' | 'unloading' | 'to-return' | 'empty-handling';

export class AMR extends Resource {
  public status: AmrStatus = 'idle';
  public phase: AmrPhase = 'idle';
  public taskId: string | null = null;
  public currentNodeId: string;
  public x: number;
  public y: number;
  public z: number;
  public yawRad = 0;
  public currentSpeedMps = 0;
  public totalDistanceM = 0;
  public busyTimeSec = 0;

  constructor(
    id: string,
    public readonly homeNodeId: string,
    public readonly lengthM: number,
    public readonly widthM: number,
    public readonly heightM: number,
    public readonly maxSpeedMps: number,
    startX: number,
    startZ: number
  ) {
    super(id, id);
    this.currentNodeId = homeNodeId;
    this.x = startX;
    this.y = heightM / 2;
    this.z = startZ;
  }

  beginTask(taskId: string): void {
    this.taskId = taskId;
  }

  moveToPhase(phase: Exclude<AmrPhase, 'idle'>): void {
    this.phase = phase;
    this.status = phase === 'loading' || phase === 'unloading' || phase === 'empty-handling' ? 'handling' : 'moving';
  }

  setIdle(nodeId: string): void {
    this.status = 'idle';
    this.phase = 'idle';
    this.taskId = null;
    this.currentNodeId = nodeId;
    this.currentSpeedMps = 0;
  }
}

export function createStations(scenario: ScenarioDefinition): Station[] {
  return scenario.stations.qpc.map(
    (qpc, index) =>
      new Station(`S${index + 1}`, index + 1, qpc, scenario.stations.initialBinFillRatio)
  );
}

export function mulberry32(seed: number): () => number {
  let current = seed >>> 0;

  return () => {
    current += 0x6d2b79f5;
    let t = current;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
