export type ScheduledEvent<TType extends string = string, TPayload = unknown> = {
  id: string;
  type: TType;
  at: number;
  priority: number;
  sequence: number;
  payload: TPayload;
};

function compareEvents(left: ScheduledEvent, right: ScheduledEvent): number {
  if (left.at !== right.at) {
    return left.at - right.at;
  }

  if (left.priority !== right.priority) {
    return left.priority - right.priority;
  }

  return left.sequence - right.sequence;
}

export class DeterministicEventQueue<TType extends string = string, TPayload = unknown> {
  private readonly heap: Array<ScheduledEvent<TType, TPayload>> = [];
  private nextSequence = 0;

  get size(): number {
    return this.heap.length;
  }

  get isEmpty(): boolean {
    return this.heap.length === 0;
  }

  peek(): ScheduledEvent<TType, TPayload> | undefined {
    return this.heap[0];
  }

  schedule(event: Omit<ScheduledEvent<TType, TPayload>, 'id' | 'sequence'> & { id?: string }): ScheduledEvent<TType, TPayload> {
    const scheduled: ScheduledEvent<TType, TPayload> = {
      ...event,
      id: event.id ?? `evt-${this.nextSequence + 1}`,
      sequence: this.nextSequence++
    };

    this.heap.push(scheduled);
    this.bubbleUp(this.heap.length - 1);
    return scheduled;
  }

  pop(): ScheduledEvent<TType, TPayload> | undefined {
    if (this.heap.length === 0) {
      return undefined;
    }

    const top = this.heap[0];
    const last = this.heap.pop();

    if (last && this.heap.length > 0) {
      this.heap[0] = last;
      this.bubbleDown(0);
    }

    return top;
  }

  clear(): void {
    this.heap.length = 0;
    this.nextSequence = 0;
  }

  rescheduleWhere(
    predicate: (event: ScheduledEvent<TType, TPayload>) => boolean,
    remapAt: (event: ScheduledEvent<TType, TPayload>) => number
  ): number {
    let updated = 0;

    for (const event of this.heap) {
      if (!predicate(event)) {
        continue;
      }

      event.at = remapAt(event);
      updated += 1;
    }

    if (updated > 0) {
      this.heapify();
    }

    return updated;
  }

  private heapify(): void {
    for (let index = Math.floor(this.heap.length / 2) - 1; index >= 0; index -= 1) {
      this.bubbleDown(index);
    }
  }

  private bubbleUp(index: number): void {
    let currentIndex = index;

    while (currentIndex > 0) {
      const parentIndex = Math.floor((currentIndex - 1) / 2);
      if (compareEvents(this.heap[currentIndex], this.heap[parentIndex]) >= 0) {
        break;
      }

      [this.heap[currentIndex], this.heap[parentIndex]] = [this.heap[parentIndex], this.heap[currentIndex]];
      currentIndex = parentIndex;
    }
  }

  private bubbleDown(index: number): void {
    let currentIndex = index;
    const length = this.heap.length;

    while (true) {
      const left = currentIndex * 2 + 1;
      const right = currentIndex * 2 + 2;
      let smallest = currentIndex;

      if (left < length && compareEvents(this.heap[left], this.heap[smallest]) < 0) {
        smallest = left;
      }

      if (right < length && compareEvents(this.heap[right], this.heap[smallest]) < 0) {
        smallest = right;
      }

      if (smallest === currentIndex) {
        break;
      }

      [this.heap[currentIndex], this.heap[smallest]] = [this.heap[smallest], this.heap[currentIndex]];
      currentIndex = smallest;
    }
  }
}
