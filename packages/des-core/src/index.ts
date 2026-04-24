import { DeterministicEventQueue, type ScheduledEvent } from '@des-platform/event-queue';

export type DesPrimitive = string | number | boolean | null;
export type DesEventPayload = Record<string, DesPrimitive | DesPrimitive[] | Record<string, DesPrimitive>>;

export type DesEventLogEntry = {
  id: string;
  type: string;
  simTimeSec: number;
  priority: number;
  sequence: number;
  payload: DesEventPayload;
};

export type DesScheduleOptions = {
  id?: string;
  priority?: number;
};

export type DesRunOptions = {
  untilSec: number;
  maxEvents?: number;
};

export type DesRunResult = {
  nowSec: number;
  executedEvents: number;
  remainingEvents: number;
  stoppedBy: 'until' | 'empty' | 'max-events';
};

export type DesEventHandlerContext<TState extends object> = {
  sim: DesSimulation<TState>;
  state: TState;
  event: ScheduledEvent<string, DesEventPayload>;
};

export type DesEventHandler<TState extends object> = (context: DesEventHandlerContext<TState>) => void;

export class DesSimulation<TState extends object = Record<string, never>> {
  private readonly queue = new DeterministicEventQueue<string, DesEventPayload>();
  private readonly handlers = new Map<string, Array<DesEventHandler<TState>>>();
  private executedEvents = 0;
  private currentTimeSec = 0;
  readonly eventLog: DesEventLogEntry[] = [];

  constructor(readonly state: TState) {}

  get nowSec(): number {
    return this.currentTimeSec;
  }

  get pendingEvents(): number {
    return this.queue.size;
  }

  get executedEventCount(): number {
    return this.executedEvents;
  }

  on(type: string, handler: DesEventHandler<TState>): void {
    const handlers = this.handlers.get(type) ?? [];
    handlers.push(handler);
    this.handlers.set(type, handlers);
  }

  scheduleAt(type: string, atSec: number, payload: DesEventPayload = {}, options: DesScheduleOptions = {}): ScheduledEvent<string, DesEventPayload> {
    if (!Number.isFinite(atSec) || atSec < 0) {
      throw new Error(`Event ${type} must be scheduled at a finite nonnegative time`);
    }

    if (atSec + 1e-9 < this.currentTimeSec) {
      throw new Error(`Event ${type} cannot be scheduled in the past at ${atSec}`);
    }

    return this.queue.schedule({
      id: options.id,
      type,
      at: atSec,
      priority: options.priority ?? 100,
      payload
    });
  }

  scheduleIn(type: string, delaySec: number, payload: DesEventPayload = {}, options: DesScheduleOptions = {}): ScheduledEvent<string, DesEventPayload> {
    if (!Number.isFinite(delaySec) || delaySec < 0) {
      throw new Error(`Event ${type} must use a finite nonnegative delay`);
    }

    return this.scheduleAt(type, this.currentTimeSec + delaySec, payload, options);
  }

  peek(): ScheduledEvent<string, DesEventPayload> | undefined {
    return this.queue.peek();
  }

  step(): ScheduledEvent<string, DesEventPayload> | null {
    const event = this.queue.pop();
    if (!event) {
      return null;
    }

    this.currentTimeSec = event.at;
    this.executedEvents += 1;
    this.eventLog.push({
      id: event.id,
      type: event.type,
      simTimeSec: event.at,
      priority: event.priority,
      sequence: event.sequence,
      payload: event.payload
    });

    for (const handler of this.handlers.get(event.type) ?? []) {
      handler({ sim: this, state: this.state, event });
    }

    return event;
  }

  run(options: DesRunOptions): DesRunResult {
    const maxEvents = options.maxEvents ?? 100_000;
    let executedThisRun = 0;

    while (this.queue.peek() && this.queue.peek()!.at <= options.untilSec + 1e-9) {
      if (executedThisRun >= maxEvents) {
        return {
          nowSec: this.currentTimeSec,
          executedEvents: executedThisRun,
          remainingEvents: this.queue.size,
          stoppedBy: 'max-events'
        };
      }

      this.step();
      executedThisRun += 1;
    }

    const stoppedBy = this.queue.isEmpty ? 'empty' : 'until';
    this.currentTimeSec = Math.max(this.currentTimeSec, options.untilSec);
    return {
      nowSec: this.currentTimeSec,
      executedEvents: executedThisRun,
      remainingEvents: this.queue.size,
      stoppedBy
    };
  }

  runUntil(untilSec: number, maxEvents?: number): DesRunResult {
    return this.run({ untilSec, maxEvents });
  }
}
