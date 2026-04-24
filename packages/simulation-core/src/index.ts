import {
  AMR,
  CarBody,
  ConveyorSegment,
  SkidCarrier,
  TransportTask,
  createStations,
  type AmrPhase,
  type Station
} from '@des-platform/domain-model';
import { computeDispatchPlan } from '@des-platform/dispatching';
import { DeterministicEventQueue } from '@des-platform/event-queue';
import { MotionWorld } from '@des-platform/motion-layer';
import type {
  EventLogEntry,
  KpiSummary,
  LayoutDefinition,
  ScenarioDefinition,
  SimulationResult,
  StationOperationalState,
  ValidationSummary,
  WorldSnapshot
} from '@des-platform/shared-schema';

type SimulationEventType =
  | 'car-release'
  | 'station-consume'
  | 'car-exit'
  | 'breakdown-start'
  | 'breakdown-end'
  | 'station-breakdown-start'
  | 'station-breakdown-end'
  | 'snapshot'
  | 'motion-tick'
  | 'handling-complete';

type SimulationEventPayload =
  | { carId: string }
  | { carId: string; stationIndex: number }
  | { reason: 'breakdown'; repairSec: number }
  | { stationId: string; repairSec: number }
  | { amrId: string; phase: Extract<AmrPhase, 'loading' | 'unloading' | 'empty-handling'> }
  | Record<string, never>;

type CarRecord = {
  car: CarBody;
  skid: SkidCarrier;
  sequence: number;
  releaseLineTimeSec: number;
  exitLineTimeSec: number;
};

type DowntimeWindow = {
  startSec: number;
  endSec: number;
};

type LineStopReason = {
  key: string;
  reason: 'breakdown' | 'station-breakdown';
  repairEndSec: number;
  repairSec: number;
  stationId?: string;
};

const SKID_WIDTH_M = 2.2;
const SKID_HEIGHT_M = 0.24;

const PRIORITY = {
  breakdownStart: 5,
  breakdownEnd: 6,
  stationBreakdownStart: 5,
  stationBreakdownEnd: 6,
  handlingComplete: 10,
  stationConsume: 20,
  carExit: 30,
  carRelease: 40,
  motionTick: 50,
  snapshot: 100
} as const;

function mean(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

class SeededRandom {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state += 0x6d2b79f5;
    let value = this.state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  }

  uniform(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  exponential(mean: number): number {
    const u = Math.max(Number.EPSILON, 1 - this.next());
    return -Math.log(u) * mean;
  }
}

export type SimulationEngineOptions = {
  retainSnapshots?: boolean;
  retainEvents?: boolean;
  onSnapshot?: (snapshot: WorldSnapshot) => void;
  onEvent?: (event: EventLogEntry) => void;
};

export type SimulationAdvanceResult = {
  simTimeSec: number;
  emittedSnapshots: WorldSnapshot[];
  emittedEvents: EventLogEntry[];
  latestSnapshot: WorldSnapshot | null;
  finished: boolean;
};

export class SimulationEngine {
  private readonly queue = new DeterministicEventQueue<SimulationEventType, SimulationEventPayload>();
  private readonly conveyor: ConveyorSegment;
  private readonly lineTravelTimeSec: number;
  private readonly stations: Station[];
  private readonly stationArrivalOffsetsSec: number[];
  private readonly stationLayoutById = new Map<string, LayoutDefinition['stations'][number]>();
  private readonly cars = new Map<string, CarRecord>();
  private readonly tasks = new Map<string, TransportTask>();
  private readonly pendingTaskIds: string[] = [];
  private readonly amrs: AMR[] = [];
  private readonly snapshots: WorldSnapshot[] = [];
  private readonly events: EventLogEntry[] = [];
  private readonly exitTimesSec: number[] = [];
  private readonly dispatchWaitsSec: number[] = [];
  private readonly taskCycleTimesSec: number[] = [];
  private readonly lineDowntimeWindows: DowntimeWindow[] = [];
  private readonly breakdownRandom: SeededRandom;
  private readonly stationBreakdownRandom: SeededRandom;
  private readonly activeLineStopReasons = new Map<string, LineStopReason>();
  private readonly failedStationIds = new Set<string>();
  private readonly stationDowntimeSec = new Map<string, number>();
  private readonly stationDowntimeStartSec = new Map<string, number>();
  private motionWorld: MotionWorld | null = null;
  private currentAdvanceSnapshots: WorldSnapshot[] | null = null;
  private currentAdvanceEvents: EventLogEntry[] | null = null;

  private currentTimeSec = 0;
  private completedCars = 0;
  private releasedCars = 0;
  private nextCarSequence = 1;
  private nextTaskSequence = 1;
  private nextLogSequence = 1;
  private maxQueueLength = 0;
  private lineRunning = true;
  private lineDowntimeSec = 0;
  private activeDowntimeStartSec: number | null = null;
  private lineStopExpectedResumeSec: number | null = null;
  private motionTickScheduledAt: number | null = null;
  private initialized = false;
  private finalized = false;
  private latestSnapshot: WorldSnapshot | null = null;
  private readonly retainSnapshots: boolean;
  private readonly retainEvents: boolean;

  constructor(
    private readonly scenario: ScenarioDefinition,
    private readonly layout: LayoutDefinition,
    private readonly options: SimulationEngineOptions = {}
  ) {
    this.retainSnapshots = options.retainSnapshots ?? true;
    this.retainEvents = options.retainEvents ?? true;
    this.breakdownRandom = new SeededRandom(this.scenario.seed ^ 0x9e3779b9);
    this.stationBreakdownRandom = new SeededRandom(this.scenario.seed ^ 0x85ebca6b);
    this.conveyor = new ConveyorSegment(
      'line-main',
      'Automotive Main Line',
      layout.line.start.x,
      layout.line.end.x,
      scenario.line.conveyorSpeedMps,
      layout.line.elevation,
      scenario.line.pitchM
    );
    this.lineTravelTimeSec = this.conveyor.totalLengthM / this.conveyor.speedMps;
    this.stations = createStations(scenario);
    const orderedStationLayouts = [...layout.stations].sort((left, right) => left.index - right.index);
    for (const stationLayout of orderedStationLayouts) {
      this.stationLayoutById.set(stationLayout.id, stationLayout);
    }
    if (orderedStationLayouts.length !== scenario.line.stationCount) {
      throw new Error(
        `Station layout count ${orderedStationLayouts.length} does not match scenario station count ${scenario.line.stationCount}`
      );
    }
    if (this.stations.length !== scenario.line.stationCount) {
      throw new Error(
        `Station QPC count ${this.stations.length} does not match scenario station count ${scenario.line.stationCount}`
      );
    }
    this.stationArrivalOffsetsSec = orderedStationLayouts.map((stationLayout, stationIndex) => {
      if (stationLayout.index !== stationIndex + 1) {
        throw new Error(`Station layout index mismatch for ${stationLayout.id}`);
      }

      const entryDistanceM = stationLayout.lineX - layout.line.start.x;
      if (entryDistanceM < -1e-6 || entryDistanceM > this.conveyor.totalLengthM + 1e-6) {
        throw new Error(`Station ${stationLayout.id} lies outside the conveyor span`);
      }

      return entryDistanceM / this.conveyor.speedMps;
    });

    this.amrs = layout.facilities.amrHomes.slice(0, scenario.amr.count).map((home, index) => {
      const amr = new AMR(
        `AMR-${index + 1}`,
        home.id,
        scenario.amr.lengthM,
        scenario.amr.widthM,
        scenario.amr.heightM,
        scenario.amr.speedMps,
        home.x,
        home.z
      );
      return amr;
    });
  }

  get simTimeSec(): number {
    return this.currentTimeSec;
  }

  get isInitialized(): boolean {
    return this.initialized;
  }

  get isFinished(): boolean {
    return this.finalized;
  }

  getLastSnapshot(): WorldSnapshot | null {
    return this.latestSnapshot;
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    const motionWorld = await MotionWorld.create(this.layout);
    this.motionWorld = motionWorld;
    motionWorld.registerAmrs(this.amrs);
    this.bootstrapEvents();
    this.initialized = true;
  }

  async run(): Promise<SimulationResult> {
    await this.initialize();
    this.advanceTo(this.scenario.durationSec);
    return this.getResult();
  }

  advanceTo(targetTimeSec: number): SimulationAdvanceResult {
    if (!this.initialized || !this.motionWorld) {
      throw new Error('Simulation engine not initialized');
    }

    if (this.finalized) {
      return {
        simTimeSec: this.currentTimeSec,
        emittedSnapshots: [],
        emittedEvents: [],
        latestSnapshot: this.latestSnapshot,
        finished: true
      };
    }

    const clampedTargetTimeSec = Math.min(Math.max(targetTimeSec, this.currentTimeSec), this.scenario.durationSec);
    const emittedSnapshots: WorldSnapshot[] = [];
    const emittedEvents: EventLogEntry[] = [];
    this.currentAdvanceSnapshots = emittedSnapshots;
    this.currentAdvanceEvents = emittedEvents;

    try {
      while (!this.queue.isEmpty) {
        const next = this.queue.peek();
        if (!next || next.at > clampedTargetTimeSec || next.at > this.scenario.durationSec) {
          break;
        }

        const event = this.queue.pop();
        if (!event) {
          break;
        }

        this.currentTimeSec = event.at;
        this.processEvent(event);
      }

      if (clampedTargetTimeSec >= this.scenario.durationSec) {
        this.finalizeRun();
      } else {
        this.currentTimeSec = clampedTargetTimeSec;
      }
    } finally {
      this.currentAdvanceSnapshots = null;
      this.currentAdvanceEvents = null;
    }

    return {
      simTimeSec: this.currentTimeSec,
      emittedSnapshots,
      emittedEvents,
      latestSnapshot: this.latestSnapshot,
      finished: this.finalized
    };
  }

  getResult(): SimulationResult {
    if (!this.finalized) {
      throw new Error('Simulation result requested before the run completed');
    }

    const kpis = this.buildKpis(this.scenario.durationSec);
    const validation = this.buildValidationSummary(kpis);

    return {
      scenarioId: this.scenario.id,
      layoutId: this.layout.id,
      createdAt: new Date().toISOString(),
      scenario: this.scenario,
      layout: this.layout,
      kpis: {
        ...kpis,
        baselinePass: kpis.baselinePass && validation.passed
      },
      validation,
      snapshots: this.snapshots,
      events: this.events
    };
  }

  private processEvent(
    next: ReturnType<DeterministicEventQueue<SimulationEventType, SimulationEventPayload>['pop']>
  ): void {
    if (!next || !this.motionWorld) {
      return;
    }

    switch (next.type) {
      case 'breakdown-start':
        this.handleBreakdownStart(
          (next.payload as { reason: 'breakdown'; repairSec: number }).reason,
          (next.payload as { reason: 'breakdown'; repairSec: number }).repairSec
        );
        break;
      case 'breakdown-end':
        this.handleBreakdownEnd(
          (next.payload as { reason: 'breakdown'; repairSec: number }).reason,
          (next.payload as { reason: 'breakdown'; repairSec: number }).repairSec
        );
        break;
      case 'station-breakdown-start':
        this.handleStationBreakdownStart(
          (next.payload as { stationId: string; repairSec: number }).stationId,
          (next.payload as { stationId: string; repairSec: number }).repairSec
        );
        break;
      case 'station-breakdown-end':
        this.handleStationBreakdownEnd(
          (next.payload as { stationId: string; repairSec: number }).stationId,
          (next.payload as { stationId: string; repairSec: number }).repairSec
        );
        break;
      case 'car-release':
        if (!this.lineRunning && this.rescheduleLineDependentEvent(next)) {
          break;
        }
        this.handleCarRelease();
        break;
      case 'station-consume':
        if (!this.lineRunning && this.rescheduleLineDependentEvent(next)) {
          break;
        }
        this.handleStationConsume(
          (next.payload as { stationIndex: number; carId: string }).stationIndex,
          (next.payload as { stationIndex: number; carId: string }).carId
        );
        break;
      case 'car-exit':
        if (!this.lineRunning && this.rescheduleLineDependentEvent(next)) {
          break;
        }
        this.handleCarExit((next.payload as { carId: string }).carId);
        break;
      case 'snapshot':
        this.captureSnapshot(this.currentTimeSec);
        break;
      case 'motion-tick':
        this.motionTickScheduledAt = null;
        this.handleMotionTick(this.motionWorld);
        break;
      case 'handling-complete':
        this.handleHandlingComplete(
          this.motionWorld,
          (next.payload as { amrId: string; phase: Extract<AmrPhase, 'loading' | 'unloading' | 'empty-handling'> }).amrId,
          (next.payload as { amrId: string; phase: Extract<AmrPhase, 'loading' | 'unloading' | 'empty-handling'> }).phase
        );
        break;
    }
  }

  private finalizeRun(): void {
    if (this.finalized) {
      return;
    }

    this.currentTimeSec = this.scenario.durationSec;
    if (this.activeDowntimeStartSec !== null) {
      this.lineDowntimeSec += this.currentTimeSec - this.activeDowntimeStartSec;
      this.lineDowntimeWindows.push({
        startSec: this.activeDowntimeStartSec,
        endSec: this.currentTimeSec
      });
      this.activeDowntimeStartSec = null;
    }
    for (const stationId of this.failedStationIds) {
      const startedAtSec = this.stationDowntimeStartSec.get(stationId);
      if (startedAtSec !== undefined) {
        this.stationDowntimeSec.set(
          stationId,
          (this.stationDowntimeSec.get(stationId) ?? 0) + this.currentTimeSec - startedAtSec
        );
      }
    }
    this.failedStationIds.clear();
    this.stationDowntimeStartSec.clear();
    this.activeLineStopReasons.clear();
    this.lineStopExpectedResumeSec = null;
    for (const station of this.stations) {
      station.finalize(this.scenario.durationSec);
    }

    if (this.latestSnapshot?.simTimeSec !== this.scenario.durationSec) {
      this.captureSnapshot(this.scenario.durationSec);
    }

    this.finalized = true;
  }

  private bootstrapEvents(): void {
    this.logEvent(0, 'line-started', { lineId: this.conveyor.id });

    for (let releaseTimeSec = 0; releaseTimeSec < this.scenario.durationSec; releaseTimeSec += this.scenario.taktTimeSec) {
      this.queue.schedule({
        type: 'car-release',
        at: releaseTimeSec,
        priority: PRIORITY.carRelease,
        payload: {}
      });
    }

    for (let snapshotTimeSec = 0; snapshotTimeSec <= this.scenario.durationSec; snapshotTimeSec += this.scenario.snapshotIntervalSec) {
      this.queue.schedule({
        type: 'snapshot',
        at: snapshotTimeSec,
        priority: PRIORITY.snapshot,
        payload: {}
      });
    }

    if (this.scenario.breakdown.enabled) {
      this.scheduleBreakdownStart(this.computeNextBreakdownAt(0));
    }

    if (this.scenario.stationBreakdown.enabled) {
      for (const station of this.stations) {
        this.scheduleStationBreakdownStart(station.id, this.sampleStationFailureTimeSec(0));
      }
    }
  }

  private handleCarRelease(): void {
    if (!this.lineRunning) {
      return;
    }

    const sequence = this.nextCarSequence;
    const carId = `CAR-${sequence}`;
    const skidId = `SKID-${sequence}`;
    this.nextCarSequence += 1;

    const car = new CarBody(
      carId,
      this.currentTimeSec,
      this.scenario.line.carLengthM,
      this.scenario.line.carWidthM,
      this.scenario.line.carHeightM,
      this.layout.assets.carBody.color
    );
    const skid = new SkidCarrier(
      skidId,
      this.currentTimeSec,
      this.scenario.line.skidLengthM,
      SKID_WIDTH_M,
      SKID_HEIGHT_M
    );
    const releaseLineTimeSec = this.getLineActiveTime(this.currentTimeSec);
    const exitLineTimeSec = releaseLineTimeSec + this.lineTravelTimeSec;
    const exitEventTimeSec = this.currentTimeSec + this.lineTravelTimeSec;

    this.cars.set(carId, { car, skid, sequence, releaseLineTimeSec, exitLineTimeSec });
    this.releasedCars += 1;
    this.logEvent(this.currentTimeSec, 'car-released', { carId });

    for (let stationIndex = 0; stationIndex < this.stations.length; stationIndex += 1) {
      const consumeTimeSec = this.currentTimeSec + this.requireStationArrivalOffsetSec(stationIndex);
      if (consumeTimeSec <= this.scenario.durationSec) {
        this.queue.schedule({
          type: 'station-consume',
          at: consumeTimeSec,
          priority: PRIORITY.stationConsume,
          payload: { carId, stationIndex }
        });
      }
    }

    if (exitEventTimeSec <= this.scenario.durationSec) {
      this.queue.schedule({
        type: 'car-exit',
        at: exitEventTimeSec,
        priority: PRIORITY.carExit,
        payload: { carId }
      });
    }
  }

  private handleStationConsume(stationIndex: number, carId: string): void {
    if (!this.lineRunning) {
      return;
    }

    const station = this.stations[stationIndex];
    const consumedBinId = station.bins[station.activeBinIndex]?.id ?? `${station.id}-unknown`;
    const result = station.consumeOne(this.currentTimeSec, this.scenario.stations.unitsPerCar);
    this.logEvent(this.currentTimeSec, 'station-consumed', {
      carId,
      stationId: station.id,
      binId: consumedBinId,
      consumedUnits: result.consumed,
      isStarved: station.isStarved
    });

    if (result.emptiedBinIndex !== null) {
      const emptiedBin = station.bins[result.emptiedBinIndex];
      this.logEvent(this.currentTimeSec, 'bin-emptied', {
        stationId: station.id,
        binId: emptiedBin.id,
        quantity: emptiedBin.quantity
      });
    }

    if (result.requestBinIndex !== null) {
      const bin = station.bins[result.requestBinIndex];
      const task = new TransportTask(
        `TASK-${this.nextTaskSequence++}`,
        station.id,
        bin.id,
        result.requestBinIndex,
        station.qpc,
        this.currentTimeSec
      );
      this.tasks.set(task.id, task);
      this.pendingTaskIds.push(task.id);
      this.maxQueueLength = Math.max(this.maxQueueLength, this.pendingTaskIds.length);
      this.logEvent(this.currentTimeSec, 'task-created', {
        taskId: task.id,
        stationId: task.stationId,
        binId: task.binId
      });
      this.dispatchPendingTasks();
    }

    if (result.starvationStarted) {
      this.logEvent(this.currentTimeSec, 'starvation-started', { stationId: station.id, carId });
    }
  }

  private handleCarExit(carId: string): void {
    if (!this.cars.has(carId)) {
      return;
    }

    this.completedCars += 1;
    this.exitTimesSec.push(this.currentTimeSec);
    this.logEvent(this.currentTimeSec, 'car-exited', { carId });
    this.cars.delete(carId);
  }

  private handleBreakdownStart(reason: 'breakdown', repairSec: number): void {
    const repairEndSec = this.currentTimeSec + repairSec;
    this.beginLineStop({
      key: 'line-breakdown',
      reason,
      repairSec,
      repairEndSec
    });

    if (repairEndSec <= this.scenario.durationSec) {
      this.queue.schedule({
        type: 'breakdown-end',
        at: repairEndSec,
        priority: PRIORITY.breakdownEnd,
        payload: { reason, repairSec }
      });
    }
  }

  private handleBreakdownEnd(reason: 'breakdown', repairSec: number): void {
    this.endLineStop('line-breakdown', reason, repairSec);

    if (this.scenario.breakdown.enabled) {
      this.scheduleBreakdownStart(this.computeNextBreakdownAt(this.currentTimeSec));
    }
  }

  private handleStationBreakdownStart(stationId: string, repairSec: number): void {
    if (this.failedStationIds.has(stationId)) {
      return;
    }

    this.requireStation(stationId);
    this.failedStationIds.add(stationId);
    this.stationDowntimeStartSec.set(stationId, this.currentTimeSec);
    this.logEvent(this.currentTimeSec, 'station-failed', {
      stationId,
      mttrSec: round(repairSec, 3),
      mtbfDistribution: this.scenario.stationBreakdown.mtbfDistribution,
      mttrDistribution: this.scenario.stationBreakdown.mttrDistribution
    });

    const repairEndSec = this.currentTimeSec + repairSec;
    this.beginLineStop({
      key: `station:${stationId}`,
      reason: 'station-breakdown',
      stationId,
      repairSec,
      repairEndSec
    });

    if (repairEndSec <= this.scenario.durationSec) {
      this.queue.schedule({
        type: 'station-breakdown-end',
        at: repairEndSec,
        priority: PRIORITY.stationBreakdownEnd,
        payload: { stationId, repairSec }
      });
    }
  }

  private handleStationBreakdownEnd(stationId: string, repairSec: number): void {
    if (this.failedStationIds.has(stationId)) {
      this.failedStationIds.delete(stationId);
      const startedAtSec = this.stationDowntimeStartSec.get(stationId) ?? this.currentTimeSec;
      this.stationDowntimeStartSec.delete(stationId);
      this.stationDowntimeSec.set(stationId, (this.stationDowntimeSec.get(stationId) ?? 0) + this.currentTimeSec - startedAtSec);
      this.logEvent(this.currentTimeSec, 'station-repaired', {
        stationId,
        repairSec: round(repairSec, 3),
        downtimeSec: round(this.currentTimeSec - startedAtSec, 3)
      });
    }

    this.endLineStop(`station:${stationId}`, 'station-breakdown', repairSec, stationId);

    if (this.scenario.stationBreakdown.enabled) {
      this.scheduleStationBreakdownStart(stationId, this.sampleStationFailureTimeSec(this.currentTimeSec));
    }
  }

  private handleMotionTick(motionWorld: MotionWorld): void {
    const movingAmrs = this.amrs.filter((amr) => amr.status === 'moving');
    if (movingAmrs.length === 0) {
      return;
    }

    const { arrivals } = motionWorld.step(this.amrs, this.scenario.motionDtSec);
    for (const arrival of arrivals) {
      this.handleRouteArrival(motionWorld, arrival.amrId, arrival.nodeId);
    }

    if (motionWorld.hasActiveRoutes()) {
      this.scheduleMotionTick(this.currentTimeSec + this.scenario.motionDtSec);
    }
  }

  private handleRouteArrival(motionWorld: MotionWorld, amrId: string, nodeId: string): void {
    const amr = this.requireAmr(amrId);
    const task = amr.taskId ? this.tasks.get(amr.taskId) : undefined;
    if (!task) {
      amr.setIdle(nodeId);
      return;
    }

    if (amr.phase === 'to-pickup') {
      task.status = 'loading';
      this.beginHandling(amr, 'loading', this.scenario.amr.loadTimeSec);
      return;
    }

    if (amr.phase === 'to-dropoff') {
      task.status = 'unloading';
      this.beginHandling(amr, 'unloading', this.scenario.amr.unloadTimeSec);
      return;
    }

    if (amr.phase === 'to-return') {
      task.status = 'empty-handling';
      this.beginHandling(amr, 'empty-handling', this.scenario.amr.emptyHandlingSec);
      return;
    }

    if (!motionWorld.hasActiveRoutes()) {
      amr.currentNodeId = nodeId;
    }
  }

  private beginHandling(
    amr: AMR,
    phase: Extract<AmrPhase, 'loading' | 'unloading' | 'empty-handling'>,
    durationSec: number
  ): void {
    amr.moveToPhase(phase);
    amr.busyTimeSec += durationSec;

    this.queue.schedule({
      type: 'handling-complete',
      at: this.currentTimeSec + durationSec,
      priority: PRIORITY.handlingComplete,
      payload: { amrId: amr.id, phase }
    });
  }

  private handleHandlingComplete(
    motionWorld: MotionWorld,
    amrId: string,
    phase: Extract<AmrPhase, 'loading' | 'unloading' | 'empty-handling'>
  ): void {
    const amr = this.requireAmr(amrId);
    const task = amr.taskId ? this.tasks.get(amr.taskId) : undefined;
    if (!task) {
      return;
    }

    if (phase === 'loading') {
      task.status = 'to-dropoff';
      amr.moveToPhase('to-dropoff');
      const stationLayout = this.requireStationLayout(task.stationId);
      const plan = motionWorld.routeAmrTo(amr, stationLayout.dropNodeId);
      if (plan.distanceM === 0) {
        this.handleRouteArrival(motionWorld, amr.id, stationLayout.dropNodeId);
      } else {
        this.scheduleMotionTick(this.currentTimeSec + this.scenario.motionDtSec);
      }
      return;
    }

    if (phase === 'unloading') {
      const station = this.requireStation(task.stationId);
      const refillResult = station.refillBin(task.binIndex, this.currentTimeSec);
      task.status = 'to-return';
      this.logEvent(this.currentTimeSec, 'bin-refilled', {
        stationId: station.id,
        binId: task.binId,
        quantity: station.bins[task.binIndex].quantity
      });
      if (refillResult.starvationCleared) {
        this.logEvent(this.currentTimeSec, 'starvation-cleared', {
          stationId: station.id,
          durationSec: round(refillResult.clearedDurationSec, 3)
        });
      }

      amr.moveToPhase('to-return');
      const plan = motionWorld.routeAmrTo(amr, 'empty-return');
      if (plan.distanceM === 0) {
        this.handleRouteArrival(motionWorld, amr.id, 'empty-return');
      } else {
        this.scheduleMotionTick(this.currentTimeSec + this.scenario.motionDtSec);
      }
      return;
    }

    task.markCompleted(this.currentTimeSec);
    this.taskCycleTimesSec.push(task.cycleTimeSec);
    this.dispatchWaitsSec.push(task.waitTimeSec);
    this.logEvent(this.currentTimeSec, 'task-finished', {
      taskId: task.id,
      stationId: task.stationId,
      amrId: amr.id
    });
    amr.setIdle('empty-return');
    this.dispatchPendingTasks();
  }

  private dispatchPendingTasks(): void {
    const motionWorld = this.motionWorld;
    if (!motionWorld) {
      throw new Error('Motion world not initialized');
    }

    const idleAmrs = this.amrs.filter((amr) => amr.status === 'idle');
    if (idleAmrs.length === 0 || this.pendingTaskIds.length === 0) {
      return;
    }

    const pendingTasks = this.pendingTaskIds
      .map((taskId) => this.tasks.get(taskId))
      .filter((task): task is TransportTask => Boolean(task));

    const assignments = computeDispatchPlan(pendingTasks, idleAmrs, (amr, task) => {
      const stationLayout = this.requireStationLayout(task.stationId);
      const travelDistance = motionWorld.estimateTaskDistance(amr, 'supermarket', stationLayout.dropNodeId, 'empty-return');
      const driveTimeSec = travelDistance / amr.maxSpeedMps;
      return driveTimeSec + this.scenario.amr.loadTimeSec + this.scenario.amr.unloadTimeSec + this.scenario.amr.emptyHandlingSec;
    });

    for (const assignment of assignments) {
      const task = this.tasks.get(assignment.taskId);
      const amr = this.amrs.find((candidate) => candidate.id === assignment.amrId);
      if (!task || !amr) {
        continue;
      }

      this.pendingTaskIds.splice(this.pendingTaskIds.indexOf(task.id), 1);
      task.markAssigned(amr.id, this.currentTimeSec);
      task.status = 'to-pickup';
      amr.beginTask(task.id);
      amr.moveToPhase('to-pickup');
      this.logEvent(this.currentTimeSec, 'task-assigned', {
        taskId: task.id,
        stationId: task.stationId,
        amrId: amr.id
      });
      this.logEvent(this.currentTimeSec, 'task-started', {
        taskId: task.id,
        stationId: task.stationId,
        amrId: amr.id
      });

      const plan = motionWorld.routeAmrTo(amr, 'supermarket');
      if (plan.distanceM === 0) {
        this.handleRouteArrival(motionWorld, amr.id, 'supermarket');
      } else {
        this.scheduleMotionTick(this.currentTimeSec + this.scenario.motionDtSec);
      }
    }
  }

  private scheduleBreakdownStart(atSec: number): void {
    if (!this.scenario.breakdown.enabled || atSec > this.scenario.durationSec) {
      return;
    }

    const repairSec = this.sampleRepairDurationSec();
    this.queue.schedule({
      type: 'breakdown-start',
      at: atSec,
      priority: PRIORITY.breakdownStart,
      payload: { reason: 'breakdown', repairSec }
    });
  }

  private computeNextBreakdownAt(baseTimeSec: number): number {
    const interarrivalSec =
      this.scenario.breakdown.mode === 'random'
        ? this.breakdownRandom.exponential(this.scenario.breakdown.mtbfSec)
        : this.scenario.breakdown.mtbfSec;

    return baseTimeSec + interarrivalSec;
  }

  private sampleRepairDurationSec(): number {
    if (this.scenario.breakdown.mode !== 'random' || this.scenario.breakdown.repairJitterRatio <= 0) {
      return this.scenario.breakdown.repairSec;
    }

    const spreadSec = this.scenario.breakdown.repairSec * this.scenario.breakdown.repairJitterRatio;
    return Math.max(
      1,
      this.breakdownRandom.uniform(
        this.scenario.breakdown.repairSec - spreadSec,
        this.scenario.breakdown.repairSec + spreadSec
      )
    );
  }

  private computeStationMtbfSec(): number {
    const { availability, mttrSec } = this.scenario.stationBreakdown;
    return (availability / (1 - availability)) * mttrSec;
  }

  private sampleStationFailureTimeSec(baseTimeSec: number): number {
    return baseTimeSec + this.stationBreakdownRandom.exponential(this.computeStationMtbfSec());
  }

  private sampleStationRepairDurationSec(): number {
    const { mttrSec, mttrDistribution } = this.scenario.stationBreakdown;
    if (mttrDistribution === 'constant') {
      return mttrSec;
    }

    return this.stationBreakdownRandom.exponential(mttrSec / 2) + this.stationBreakdownRandom.exponential(mttrSec / 2);
  }

  private scheduleStationBreakdownStart(stationId: string, atSec: number): void {
    if (!this.scenario.stationBreakdown.enabled || atSec > this.scenario.durationSec) {
      return;
    }

    this.queue.schedule({
      type: 'station-breakdown-start',
      at: atSec,
      priority: PRIORITY.stationBreakdownStart,
      payload: { stationId, repairSec: this.sampleStationRepairDurationSec() }
    });
  }

  private beginLineStop(reason: LineStopReason): void {
    const currentResumeSec = this.lineStopExpectedResumeSec;
    this.activeLineStopReasons.set(reason.key, reason);

    if (this.lineRunning) {
      this.lineRunning = false;
      this.activeDowntimeStartSec = this.currentTimeSec;
      this.lineStopExpectedResumeSec = reason.repairEndSec;
      this.shiftLineDependentEvents(reason.repairSec);
      this.logEvent(this.currentTimeSec, 'line-stopped', {
        lineId: this.conveyor.id,
        reason: reason.reason,
        stationId: reason.stationId ?? null,
        repairSec: round(reason.repairSec, 3)
      });
      return;
    }

    if (currentResumeSec !== null && reason.repairEndSec > currentResumeSec) {
      this.shiftLineDependentEvents(reason.repairEndSec - currentResumeSec);
      this.lineStopExpectedResumeSec = reason.repairEndSec;
    }
  }

  private endLineStop(
    key: string,
    reason: LineStopReason['reason'],
    repairSec: number,
    stationId?: string
  ): void {
    this.activeLineStopReasons.delete(key);
    if (this.activeLineStopReasons.size > 0 || this.lineRunning) {
      return;
    }

    const startSec = this.activeDowntimeStartSec ?? this.currentTimeSec;
    const durationSec = this.currentTimeSec - startSec;
    this.lineRunning = true;
    this.activeDowntimeStartSec = null;
    this.lineStopExpectedResumeSec = null;
    this.lineDowntimeSec += durationSec;
    this.lineDowntimeWindows.push({
      startSec,
      endSec: this.currentTimeSec
    });
    this.logEvent(this.currentTimeSec, 'line-started', {
      lineId: this.conveyor.id,
      reason,
      stationId: stationId ?? null,
      recoveredFromSec: round(durationSec, 4),
      repairSec: round(repairSec, 3)
    });
  }

  private rescheduleLineDependentEvent(
    event: NonNullable<ReturnType<DeterministicEventQueue<SimulationEventType, SimulationEventPayload>['pop']>>
  ): boolean {
    const resumeAtSec = this.lineStopExpectedResumeSec;
    if (resumeAtSec === null || resumeAtSec <= this.currentTimeSec) {
      return false;
    }

    this.queue.schedule({
      ...event,
      at: resumeAtSec
    });
    return true;
  }

  private shiftLineDependentEvents(delaySec: number): void {
    if (delaySec <= 0) {
      return;
    }

    this.queue.rescheduleWhere(
      (event) =>
        event.at >= this.currentTimeSec &&
        (event.type === 'car-release' || event.type === 'station-consume' || event.type === 'car-exit'),
      (event) => event.at + delaySec
    );
  }

  private scheduleMotionTick(atSec: number): void {
    if (this.motionTickScheduledAt !== null && this.motionTickScheduledAt <= atSec) {
      return;
    }

    this.motionTickScheduledAt = atSec;
    this.queue.schedule({
      type: 'motion-tick',
      at: atSec,
      priority: PRIORITY.motionTick,
      payload: {}
    });
  }

  private captureSnapshot(simTimeSec: number): void {
    const activeCars = this.getActiveCars(simTimeSec);
    const activeSkids = this.getActiveSkids(simTimeSec);
    const kpis = this.buildKpis(simTimeSec);
    const lineHead = activeCars[0] ?? null;
    const lineTail = activeCars.at(-1) ?? null;
    const lineWindowStartSec = activeCars.length > 0 ? Math.min(...activeCars.map((car) => car.releaseTimeSec)) : simTimeSec;

    const snapshot: WorldSnapshot = {
      simTimeSec,
      line: {
        isRunning: this.lineRunning,
        speedMps: this.lineRunning ? this.conveyor.speedMps : 0,
        activeCars: activeCars.length,
        completedCars: this.completedCars,
        headCarId: lineHead?.id ?? null,
        tailCarId: lineTail?.id ?? null,
        onlineCarIds: activeCars.map((car) => car.id),
        lineWindowStartSec: round(lineWindowStartSec, 4)
      },
      cars: activeCars,
      skids: activeSkids,
      stations: this.stations.map((station) => this.buildStationSnapshot(station, activeCars, simTimeSec)),
      tasks: [...this.tasks.values()]
        .filter((task) => task.status !== 'done')
        .map((task) => ({
          id: task.id,
          stationId: task.stationId,
          binId: task.binId,
          status: task.status,
          requestTimeSec: task.requestTimeSec,
          assignedAtSec: task.assignedAtSec,
          ageSec: round(Math.max(0, simTimeSec - task.requestTimeSec), 4),
          waitSec: round(task.assignedAtSec === null ? Math.max(0, simTimeSec - task.requestTimeSec) : task.waitTimeSec, 4),
          assignedAmrId: task.assignedAmrId,
          qpc: task.qpc
        })),
      amrs: this.amrs.map((amr) => {
        const routeProgress = this.motionWorld?.getRouteProgress(amr) ?? {
          targetNodeId: null,
          destinationNodeId: null,
          nodeIds: [],
          remainingDistanceM: 0
        };

        return {
          id: amr.id,
          status: amr.status,
          phase: amr.phase,
          taskId: amr.taskId,
          x: round(amr.x, 4),
          y: round(amr.y, 4),
          z: round(amr.z, 4),
          yawRad: round(amr.yawRad, 4),
          speedMps: round(amr.currentSpeedMps, 4),
          totalDistanceM: round(amr.totalDistanceM, 4),
          busyTimeSec: round(amr.busyTimeSec, 4),
          currentNodeId: amr.currentNodeId,
          targetNodeId: routeProgress.targetNodeId,
          routeDestinationNodeId: routeProgress.destinationNodeId,
          routeNodeIds: routeProgress.nodeIds,
          routeRemainingDistanceM: round(routeProgress.remainingDistanceM, 4)
        };
      }),
      kpis,
      alerts: this.buildAlerts()
    };

    this.latestSnapshot = snapshot;
    this.currentAdvanceSnapshots?.push(snapshot);
    this.options.onSnapshot?.(snapshot);
    if (this.retainSnapshots) {
      this.snapshots.push(snapshot);
    }
  }

  private getLineActiveTime(simTimeSec: number): number {
    let downtimeSec = 0;

    for (const window of this.lineDowntimeWindows) {
      if (window.startSec >= simTimeSec) {
        continue;
      }

      downtimeSec += Math.min(window.endSec, simTimeSec) - window.startSec;
    }

    if (this.activeDowntimeStartSec !== null && this.activeDowntimeStartSec < simTimeSec) {
      downtimeSec += simTimeSec - this.activeDowntimeStartSec;
    }

    return Math.max(0, simTimeSec - downtimeSec);
  }

  private getNextStationForDistance(distanceM: number): { id: string; distanceM: number } | null {
    const carX = this.layout.line.start.x + distanceM;
    const nextStation = [...this.layout.stations]
      .sort((left, right) => left.index - right.index)
      .find((station) => station.lineX + 1e-6 >= carX);

    if (!nextStation) {
      return null;
    }

    return {
      id: nextStation.id,
      distanceM: Math.max(0, nextStation.lineX - carX)
    };
  }

  private findCurrentCarAtStation(stationLineX: number, activeCars: WorldSnapshot['cars']): string | null {
    const halfPitchM = this.scenario.line.pitchM / 2;
    let closestCarId: string | null = null;
    let closestDistanceM = Number.POSITIVE_INFINITY;

    for (const car of activeCars) {
      const distanceM = Math.abs(car.x - stationLineX);
      if (distanceM <= halfPitchM && distanceM < closestDistanceM) {
        closestCarId = car.id;
        closestDistanceM = distanceM;
      }
    }

    return closestCarId;
  }

  private buildStationSnapshot(
    station: Station,
    activeCars: WorldSnapshot['cars'],
    simTimeSec: number
  ): WorldSnapshot['stations'][number] {
    const stationLayout = this.requireStationLayout(station.id);
    const currentCarId = this.findCurrentCarAtStation(stationLayout.lineX, activeCars);
    const state = this.deriveStationState(station, stationLayout, currentCarId, activeCars, simTimeSec);

    return {
      id: station.id,
      index: station.index,
      qpc: station.qpc,
      currentCarId,
      state: state.state,
      stateReason: state.reason,
      stateColor: state.color,
      isStarved: station.isStarved,
      activeBinIndex: station.activeBinIndex,
      requestCount: station.requestCount,
      starvationCount: station.starvationCount,
      bins: station.bins.map((bin) => ({
        id: bin.id,
        quantity: bin.quantity,
        capacity: bin.capacity,
        pendingRequest: bin.pendingRequest,
        isActive: bin.active
      }))
    };
  }

  private deriveStationState(
    station: Station,
    stationLayout: LayoutDefinition['stations'][number],
    currentCarId: string | null,
    activeCars: WorldSnapshot['cars'],
    simTimeSec: number
  ): { state: StationOperationalState; reason: string; color: string } {
    if (this.failedStationIds.has(station.id)) {
      return { state: 'down', reason: 'availability downtime / repair active', color: '#e14b4b' };
    }

    if (!this.lineRunning) {
      const failedStations = this.stations.filter((candidate) => this.failedStationIds.has(candidate.id));
      if (failedStations.length > 0) {
        const downstreamFailure = failedStations
          .filter((candidate) => candidate.index > station.index)
          .sort((left, right) => left.index - right.index)[0];
        if (downstreamFailure) {
          return { state: 'blocked', reason: `downstream blocked by ${downstreamFailure.id}`, color: '#4ecbff' };
        }

        const upstreamFailure = failedStations
          .filter((candidate) => candidate.index < station.index)
          .sort((left, right) => right.index - left.index)[0];
        if (upstreamFailure) {
          return { state: 'upstream-starved', reason: `upstream flow stopped by ${upstreamFailure.id}`, color: '#f3c74d' };
        }
      }

      return { state: 'down', reason: 'line availability downtime / repair active', color: '#e14b4b' };
    }

    if (station.isStarved) {
      return { state: 'material-starved', reason: 'line-side 2-bin inventory is empty', color: '#ff7847' };
    }

    if (currentCarId) {
      return { state: 'running', reason: `processing ${currentCarId}`, color: '#45b36b' };
    }

    const hasUpstreamCar = activeCars.some((car) => car.x + this.scenario.line.pitchM / 2 < stationLayout.lineX);
    if (hasUpstreamCar && simTimeSec < this.scenario.durationSec) {
      return { state: 'upstream-starved', reason: 'waiting for upstream car arrival', color: '#f3c74d' };
    }

    return { state: 'idle', reason: 'no car at station window', color: '#8a95a3' };
  }

  private getActiveCars(simTimeSec: number): WorldSnapshot['cars'] {
    const cars: Array<Omit<WorldSnapshot['cars'][number], 'lineOrder'>> = [];
    const lineActiveTimeSec = this.getLineActiveTime(simTimeSec);

    for (const { car, skid, sequence, releaseLineTimeSec, exitLineTimeSec } of this.cars.values()) {
      if (car.releaseTimeSec > simTimeSec || lineActiveTimeSec >= exitLineTimeSec) {
        continue;
      }

      const distanceM = Math.min(
        this.conveyor.totalLengthM,
        Math.max(0, lineActiveTimeSec - releaseLineTimeSec) * this.conveyor.speedMps
      );
      const nextStation = this.getNextStationForDistance(distanceM);
      cars.push({
        id: car.id,
        sequence,
        skidId: skid.id,
        releaseTimeSec: car.releaseTimeSec,
        distanceM: round(distanceM, 4),
        nextStationId: nextStation?.id ?? null,
        distanceToNextStationM: nextStation ? round(nextStation.distanceM, 4) : null,
        timeToExitSec: round((this.conveyor.totalLengthM - distanceM) / this.conveyor.speedMps, 4),
        x: round(this.layout.line.start.x + distanceM, 4),
        y: round(this.layout.line.elevation + car.heightM / 2 + SKID_HEIGHT_M, 4),
        z: 0,
        lengthM: car.lengthM,
        widthM: car.widthM,
        heightM: car.heightM
      });
    }

    return cars
      .sort((left, right) => left.sequence - right.sequence)
      .map((car, lineOrder) => ({
        ...car,
        lineOrder
      }));
  }

  private getActiveSkids(simTimeSec: number): WorldSnapshot['skids'] {
    const skids: WorldSnapshot['skids'] = [];
    const lineActiveTimeSec = this.getLineActiveTime(simTimeSec);

    for (const { car, skid, releaseLineTimeSec, exitLineTimeSec } of this.cars.values()) {
      if (skid.releaseTimeSec > simTimeSec || lineActiveTimeSec >= exitLineTimeSec) {
        continue;
      }

      const distanceM = Math.min(
        this.conveyor.totalLengthM,
        Math.max(0, lineActiveTimeSec - releaseLineTimeSec) * this.conveyor.speedMps
      );
      skids.push({
        id: skid.id,
        carId: car.id,
        releaseTimeSec: skid.releaseTimeSec,
        distanceM: round(distanceM, 4),
        x: round(this.layout.line.start.x + distanceM, 4),
        y: round(this.layout.line.elevation + skid.heightM / 2, 4),
        z: 0,
        lengthM: skid.lengthM,
        widthM: skid.widthM,
        heightM: skid.heightM
      });
    }

    return skids;
  }

  private buildKpis(simTimeSec: number): KpiSummary {
    const starvationSec = this.stations.reduce((sum, station) => {
      return sum + station.starvationDurationSec + (station.isStarved ? simTimeSec - station.starvationStartSec : 0);
    }, 0);
    const stationDowntimeSec = Object.fromEntries(
      this.stations.map((station) => [station.id, round(this.getStationDowntimeSec(station.id, simTimeSec), 4)])
    );
    const stationAvailability = Object.fromEntries(
      this.stations.map((station) => {
        const downtimeSec = stationDowntimeSec[station.id] ?? 0;
        return [station.id, round(simTimeSec > 0 ? Math.max(0, 1 - downtimeSec / simTimeSec) : 1, 4)];
      })
    );

    const steadyStateExitTimes = this.exitTimesSec.filter((exitTimeSec) => exitTimeSec >= this.scenario.report.warmupSec && exitTimeSec <= simTimeSec);
    const steadyIntervals = steadyStateExitTimes.slice(1).map((exitTimeSec, index) => exitTimeSec - steadyStateExitTimes[index]!);
    const steadyStateCycleSec = mean(steadyIntervals);
    const steadyStateUph = steadyStateCycleSec > 0 ? 3600 / steadyStateCycleSec : 0;
    const actualAverageUph = simTimeSec > 0 ? (this.completedCars * 3600) / simTimeSec : 0;
    const expectedUph = 3600 / this.scenario.taktTimeSec;
    const baselinePass =
      this.lineDowntimeSec === 0 &&
      starvationSec === 0 &&
      Math.abs(steadyStateCycleSec - this.scenario.taktTimeSec) <= 0.5 &&
      Math.abs(steadyStateUph - expectedUph) <= expectedUph * 0.01;

    return {
      completedCars: this.completedCars,
      releasedCars: this.releasedCars,
      lineDowntimeSec: round(this.lineDowntimeSec, 4),
      starvationSec: round(starvationSec, 4),
      steadyStateCycleSec: round(steadyStateCycleSec, 4),
      steadyStateUph: round(steadyStateUph, 4),
      actualAverageUph: round(actualAverageUph, 4),
      averageTaskWaitSec: round(mean(this.dispatchWaitsSec), 4),
      averageTaskCycleSec: round(mean(this.taskCycleTimesSec), 4),
      maxQueueLength: this.maxQueueLength,
      amrUtilization: Object.fromEntries(
        this.amrs.map((amr) => [amr.id, round(simTimeSec > 0 ? amr.busyTimeSec / simTimeSec : 0, 4)])
      ),
      stationConsumption: Object.fromEntries(this.stations.map((station) => [station.id, station.consumedUnits])),
      stationDowntimeSec,
      stationAvailability,
      totalAmrDistanceM: round(this.amrs.reduce((sum, amr) => sum + amr.totalDistanceM, 0), 4),
      baselinePass
    };
  }

  private getStationDowntimeSec(stationId: string, simTimeSec: number): number {
    const startedAtSec = this.stationDowntimeStartSec.get(stationId);
    return (this.stationDowntimeSec.get(stationId) ?? 0) + (startedAtSec === undefined ? 0 : Math.max(0, simTimeSec - startedAtSec));
  }

  private buildAlerts(): WorldSnapshot['alerts'] {
    const alerts: WorldSnapshot['alerts'] = [];
    for (const station of this.stations) {
      if (this.failedStationIds.has(station.id)) {
        alerts.push({
          code: `station-down-${station.id.toLowerCase()}`,
          severity: 'critical',
          message: `${station.id} is down for repair`
        });
      }
      if (station.isStarved) {
        alerts.push({
          code: `starvation-${station.id.toLowerCase()}`,
          severity: 'critical',
          message: `${station.id} is starved`
        });
      }
    }

    if (!this.lineRunning) {
      alerts.push({
        code: 'line-stopped',
        severity: 'warning',
        message: 'Main line is stopped'
      });
    }

    return alerts;
  }

  private buildValidationSummary(kpis: KpiSummary): ValidationSummary {
    const checks = [
      this.validateGeometryConsistency(),
      this.validateStationArrivalAlignment(),
      this.validateStationConsumptionAccounting(kpis),
      this.validateLineDowntimeBlackout(),
      this.validateOutstandingRequests(),
      this.validateTaskLifecycle(),
      this.validateCarSkidBinding(),
      this.validateLineOrderMonotonicity(),
      this.validateCarPitchSpacing()
    ];

    return {
      passed: checks.every((check) => check.passed),
      checks
    };
  }

  private validateGeometryConsistency(): ValidationSummary['checks'][number] {
    const issues: string[] = [];
    const orderedStations = [...this.layout.stations].sort((left, right) => left.index - right.index);
    const lineLengthDiff = Math.abs(this.conveyor.totalLengthM - this.scenario.line.stationCount * this.scenario.line.pitchM);
    const speedDiff = Math.abs(this.layout.line.speedMps - this.scenario.line.conveyorSpeedMps);
    const pitchDiff = Math.abs(this.layout.line.pitchM - this.scenario.line.pitchM);

    if (lineLengthDiff > 1e-6) {
      issues.push(`lineLength=${round(this.conveyor.totalLengthM, 4)}m expected=${round(this.scenario.line.stationCount * this.scenario.line.pitchM, 4)}m`);
    }
    if (speedDiff > 1e-6) {
      issues.push(`speed=${round(this.layout.line.speedMps, 4)}m/s expected=${round(this.scenario.line.conveyorSpeedMps, 4)}m/s`);
    }
    if (pitchDiff > 1e-6) {
      issues.push(`pitch=${round(this.layout.line.pitchM, 4)}m expected=${round(this.scenario.line.pitchM, 4)}m`);
    }

    for (let stationIndex = 1; stationIndex < orderedStations.length; stationIndex += 1) {
      const pitchM = orderedStations[stationIndex]!.lineX - orderedStations[stationIndex - 1]!.lineX;
      if (Math.abs(pitchM - this.scenario.line.pitchM) > 1e-6) {
        issues.push(
          `${orderedStations[stationIndex - 1]!.id}->${orderedStations[stationIndex]!.id} pitch=${round(pitchM, 4)}m`
        );
      }
    }

    return {
      id: 'geometry-consistency',
      label: 'Geometry consistency',
      passed: issues.length === 0,
      detail:
        issues.length === 0
          ? `line=${round(this.conveyor.totalLengthM, 2)}m, pitch=${round(this.scenario.line.pitchM, 2)}m, speed=${round(this.conveyor.speedMps, 4)}m/s.`
          : issues.join('; ')
    };
  }

  private validateStationArrivalAlignment(): ValidationSummary['checks'][number] {
    const releaseTimesByCar = new Map<string, number>();
    let actualCount = 0;
    let expectedCount = 0;
    let maxTimingDriftSec = 0;

    for (const event of this.events) {
      if (event.type === 'car-released') {
        const carId = String(event.payload.carId ?? '');
        releaseTimesByCar.set(carId, event.simTimeSec);
        for (const offsetSec of this.stationArrivalOffsetsSec) {
          if (event.simTimeSec + offsetSec <= this.scenario.durationSec) {
            expectedCount += 1;
          }
        }
      }

      if (event.type !== 'station-consumed') {
        continue;
      }

      actualCount += 1;
      const stationId = String(event.payload.stationId ?? '');
      const carId = String(event.payload.carId ?? '');
      const releaseTimeSec = releaseTimesByCar.get(carId);
      const stationLayout = this.stationLayoutById.get(stationId);
      if (releaseTimeSec === undefined || !stationLayout) {
        maxTimingDriftSec = Number.POSITIVE_INFINITY;
        continue;
      }

      const stationActiveOffsetSec = (stationLayout.lineX - this.layout.line.start.x) / this.conveyor.speedMps;
      const expectedLineActiveTimeSec = this.getLineActiveTime(releaseTimeSec) + stationActiveOffsetSec;
      const expectedTimeSec = this.getSimTimeForLineActiveTime(expectedLineActiveTimeSec);
      maxTimingDriftSec = Math.max(maxTimingDriftSec, Math.abs(event.simTimeSec - expectedTimeSec));
    }

    const passed = expectedCount === actualCount && maxTimingDriftSec <= 0.001;
    return {
      id: 'station-arrival-alignment',
      label: 'Station arrival alignment',
      passed,
      detail: `logged=${actualCount}/${expectedCount} consume events, max drift=${round(maxTimingDriftSec, 4)}s.`
    };
  }

  private getSimTimeForLineActiveTime(lineActiveTimeSec: number): number {
    let simTimeSec = lineActiveTimeSec;
    for (const window of [...this.lineDowntimeWindows].sort((left, right) => left.startSec - right.startSec)) {
      if (simTimeSec < window.startSec) {
        break;
      }

      simTimeSec += window.endSec - window.startSec;
    }

    return simTimeSec;
  }

  private validateStationConsumptionAccounting(kpis: KpiSummary): ValidationSummary['checks'][number] {
    const consumedByStation = new Map<string, number>();
    for (const event of this.events) {
      if (event.type !== 'station-consumed') {
        continue;
      }

      const stationId = String(event.payload.stationId ?? '');
      const consumedUnits = Number(event.payload.consumedUnits ?? 0);
      consumedByStation.set(stationId, (consumedByStation.get(stationId) ?? 0) + consumedUnits);
    }

    const mismatches = Object.entries(kpis.stationConsumption).filter(([stationId, consumedUnits]) => {
      return (consumedByStation.get(stationId) ?? 0) !== consumedUnits;
    });

    return {
      id: 'station-consumption-accounting',
      label: 'Station consumption accounting',
      passed: mismatches.length === 0,
      detail:
        mismatches.length === 0
          ? `${Object.keys(kpis.stationConsumption).length} stations matched event-driven consumption totals.`
          : mismatches
              .map(([stationId, consumedUnits]) => `${stationId} events=${consumedByStation.get(stationId) ?? 0} kpi=${consumedUnits}`)
              .join('; ')
    };
  }

  private validateLineDowntimeBlackout(): ValidationSummary['checks'][number] {
    const downtimeEvents = this.events.filter((event) => event.type === 'line-stopped' || event.type === 'line-started');
    if (downtimeEvents.length <= 1) {
      return {
        id: 'line-downtime-blackout',
        label: 'Line downtime blackout',
        passed: true,
        detail: 'No downtime windows were active in this run.'
      };
    }

    let blockedLineEvents = 0;
    for (const event of this.events) {
      if (event.type !== 'car-released' && event.type !== 'station-consumed' && event.type !== 'car-exited') {
        continue;
      }

      const duringDowntime = this.lineDowntimeWindows.some(
        (window) => event.simTimeSec >= window.startSec && event.simTimeSec < window.endSec
      );
      if (duringDowntime) {
        blockedLineEvents += 1;
      }
    }

    return {
      id: 'line-downtime-blackout',
      label: 'Line downtime blackout',
      passed: blockedLineEvents === 0,
      detail: `downtimeWindows=${this.lineDowntimeWindows.length}, blockedLineEvents=${blockedLineEvents}.`
    };
  }

  private validateOutstandingRequests(): ValidationSummary['checks'][number] {
    const openRequestsByBin = new Map<string, number>();
    let duplicateRequests = 0;
    let unexpectedRefills = 0;

    for (const event of this.events) {
      if (event.type === 'task-created') {
        const binId = String(event.payload.binId ?? '');
        const openRequests = openRequestsByBin.get(binId) ?? 0;
        if (openRequests > 0) {
          duplicateRequests += 1;
        }
        openRequestsByBin.set(binId, openRequests + 1);
      }

      if (event.type === 'bin-refilled') {
        const binId = String(event.payload.binId ?? '');
        const openRequests = openRequestsByBin.get(binId) ?? 0;
        if (openRequests <= 0) {
          unexpectedRefills += 1;
          continue;
        }
        openRequestsByBin.set(binId, openRequests - 1);
      }
    }

    const openRequestsAtStop = [...openRequestsByBin.values()].reduce((sum, value) => sum + value, 0);
    return {
      id: 'single-outstanding-request',
      label: 'Single outstanding request per bin',
      passed: duplicateRequests === 0 && unexpectedRefills === 0,
      detail: `duplicateRequests=${duplicateRequests}, unexpectedRefills=${unexpectedRefills}, openAtStop=${openRequestsAtStop}.`
    };
  }

  private validateTaskLifecycle(): ValidationSummary['checks'][number] {
    const stageOrder = new Map([
      ['task-created', 1],
      ['task-assigned', 2],
      ['task-started', 3],
      ['task-finished', 4]
    ]);
    const taskStageById = new Map<string, number>();
    let orderingViolations = 0;

    for (const event of this.events) {
      const nextStage = stageOrder.get(event.type);
      if (!nextStage) {
        continue;
      }

      const taskId = String(event.payload.taskId ?? '');
      const currentStage = taskStageById.get(taskId) ?? 0;
      if (nextStage <= currentStage) {
        orderingViolations += 1;
        continue;
      }

      if (nextStage > currentStage + 1) {
        orderingViolations += 1;
      }

      taskStageById.set(taskId, nextStage);
    }

    const unfinishedAtStop = [...taskStageById.values()].filter((stage) => stage < 4).length;
    return {
      id: 'task-lifecycle-order',
      label: 'Task lifecycle ordering',
      passed: orderingViolations === 0,
      detail: `tasksSeen=${taskStageById.size}, orderingViolations=${orderingViolations}, unfinishedAtStop=${unfinishedAtStop}.`
    };
  }

  private validateCarPitchSpacing(): ValidationSummary['checks'][number] {
    const snapshots = this.snapshots.length > 0 ? this.snapshots : this.latestSnapshot ? [this.latestSnapshot] : [];
    let checkedGaps = 0;
    let pitchViolations = 0;
    let maxDeviationM = 0;

    for (const snapshot of snapshots) {
      const activeCars = [...snapshot.cars].sort((left, right) => left.x - right.x);
      for (let carIndex = 1; carIndex < activeCars.length; carIndex += 1) {
        const gapM = activeCars[carIndex]!.x - activeCars[carIndex - 1]!.x;
        const deviationM = Math.abs(gapM - this.scenario.line.pitchM);
        checkedGaps += 1;
        maxDeviationM = Math.max(maxDeviationM, deviationM);
        if (deviationM > 0.05) {
          pitchViolations += 1;
        }
      }
    }

    return {
      id: 'car-pitch-spacing',
      label: 'Car pitch spacing',
      passed: pitchViolations === 0,
      detail: `checkedGaps=${checkedGaps}, maxDeviation=${round(maxDeviationM, 4)}m, violations=${pitchViolations}.`
    };
  }

  private validateCarSkidBinding(): ValidationSummary['checks'][number] {
    const snapshots = this.snapshots.length > 0 ? this.snapshots : this.latestSnapshot ? [this.latestSnapshot] : [];
    let checkedPairs = 0;
    let missingSkids = 0;
    let bindingViolations = 0;
    let maxOffsetM = 0;

    for (const snapshot of snapshots) {
      const skidsByCarId = new Map(snapshot.skids.map((skid) => [skid.carId, skid]));
      for (const car of snapshot.cars) {
        checkedPairs += 1;
        const skid = skidsByCarId.get(car.id);
        if (!skid) {
          missingSkids += 1;
          continue;
        }

        const offsetM = Math.max(Math.abs(car.x - skid.x), Math.abs(car.z - skid.z), Math.abs(car.distanceM - skid.distanceM));
        maxOffsetM = Math.max(maxOffsetM, offsetM);
        if (skid.id !== car.skidId || offsetM > 0.01) {
          bindingViolations += 1;
        }
      }
    }

    return {
      id: 'car-skid-binding',
      label: 'Car and skid binding',
      passed: missingSkids === 0 && bindingViolations === 0,
      detail: `checkedPairs=${checkedPairs}, missingSkids=${missingSkids}, maxOffset=${round(maxOffsetM, 4)}m, violations=${bindingViolations}.`
    };
  }

  private validateLineOrderMonotonicity(): ValidationSummary['checks'][number] {
    const snapshots = this.snapshots.length > 0 ? this.snapshots : this.latestSnapshot ? [this.latestSnapshot] : [];
    let checkedPairs = 0;
    let orderViolations = 0;
    let metadataViolations = 0;

    for (const snapshot of snapshots) {
      const orderedCars = [...snapshot.cars].sort((left, right) => left.lineOrder - right.lineOrder);
      const orderedIds = orderedCars.map((car) => car.id);

      if (
        orderedIds.length !== snapshot.line.onlineCarIds.length ||
        orderedIds.some((carId, index) => snapshot.line.onlineCarIds[index] !== carId) ||
        (orderedCars[0]?.id ?? null) !== snapshot.line.headCarId ||
        (orderedCars.at(-1)?.id ?? null) !== snapshot.line.tailCarId
      ) {
        metadataViolations += 1;
      }

      for (let carIndex = 1; carIndex < orderedCars.length; carIndex += 1) {
        checkedPairs += 1;
        const headwardCar = orderedCars[carIndex - 1]!;
        const tailwardCar = orderedCars[carIndex]!;
        if (headwardCar.sequence >= tailwardCar.sequence || headwardCar.distanceM + 0.01 < tailwardCar.distanceM) {
          orderViolations += 1;
        }
      }
    }

    return {
      id: 'line-order-monotonicity',
      label: 'Line order monotonicity',
      passed: orderViolations === 0 && metadataViolations === 0,
      detail: `checkedPairs=${checkedPairs}, orderViolations=${orderViolations}, metadataViolations=${metadataViolations}.`
    };
  }

  private logEvent(simTimeSec: number, type: EventLogEntry['type'], payload: EventLogEntry['payload']): void {
    const event: EventLogEntry = {
      id: `log-${String(this.nextLogSequence++).padStart(6, '0')}`,
      simTimeSec: round(simTimeSec, 4),
      type,
      payload
    };

    this.currentAdvanceEvents?.push(event);
    this.options.onEvent?.(event);
    if (this.retainEvents) {
      this.events.push(event);
    }
  }

  private requireStation(stationId: string): Station {
    const station = this.stations.find((candidate) => candidate.id === stationId);
    if (!station) {
      throw new Error(`Unknown station ${stationId}`);
    }

    return station;
  }

  private requireStationLayout(stationId: string): LayoutDefinition['stations'][number] {
    const stationLayout = this.stationLayoutById.get(stationId);
    if (!stationLayout) {
      throw new Error(`Unknown station layout ${stationId}`);
    }

    return stationLayout;
  }

  private requireStationArrivalOffsetSec(stationIndex: number): number {
    const offsetSec = this.stationArrivalOffsetsSec[stationIndex];
    if (offsetSec === undefined) {
      throw new Error(`Missing arrival offset for station index ${stationIndex}`);
    }

    return offsetSec;
  }

  private requireAmr(amrId: string): AMR {
    const amr = this.amrs.find((candidate) => candidate.id === amrId);
    if (!amr) {
      throw new Error(`Unknown AMR ${amrId}`);
    }

    return amr;
  }
}

export async function runSimulation(scenario: ScenarioDefinition, layout: LayoutDefinition): Promise<SimulationResult> {
  const engine = new SimulationEngine(scenario, layout);
  return engine.run();
}
