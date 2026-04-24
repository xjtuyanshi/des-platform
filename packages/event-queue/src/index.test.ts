import { DeterministicEventQueue } from './index.js';

describe('DeterministicEventQueue', () => {
  it('orders by time, then priority, then insertion sequence', () => {
    const queue = new DeterministicEventQueue<'a' | 'b', { value: string }>();

    queue.schedule({ type: 'a', at: 10, priority: 20, payload: { value: 'late' } });
    queue.schedule({ type: 'a', at: 5, priority: 30, payload: { value: 'time-first' } });
    queue.schedule({ type: 'b', at: 5, priority: 10, payload: { value: 'priority-first' } });
    queue.schedule({ type: 'a', at: 5, priority: 10, payload: { value: 'sequence-second' } });

    expect(queue.pop()?.payload.value).toBe('priority-first');
    expect(queue.pop()?.payload.value).toBe('sequence-second');
    expect(queue.pop()?.payload.value).toBe('time-first');
    expect(queue.pop()?.payload.value).toBe('late');
  });

  it('can reschedule a subset of queued events and keep deterministic order', () => {
    const queue = new DeterministicEventQueue<'line' | 'meta', { value: string }>();

    queue.schedule({ type: 'line', at: 10, priority: 20, payload: { value: 'car-release' } });
    queue.schedule({ type: 'meta', at: 11, priority: 10, payload: { value: 'snapshot' } });
    queue.schedule({ type: 'line', at: 12, priority: 20, payload: { value: 'car-exit' } });

    const shifted = queue.rescheduleWhere((event) => event.type === 'line', (event) => event.at + 5);

    expect(shifted).toBe(2);
    expect(queue.pop()?.payload.value).toBe('snapshot');
    expect(queue.pop()?.payload.value).toBe('car-release');
    expect(queue.pop()?.payload.value).toBe('car-exit');
  });
});
