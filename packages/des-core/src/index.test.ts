import { DesSimulation } from './index.js';

describe('DesSimulation', () => {
  it('executes events deterministically and lets handlers schedule follow-up work', () => {
    const sim = new DesSimulation({ seen: [] as string[] });

    sim.on('work', ({ sim: runtime, state, event }) => {
      state.seen.push(String(event.payload.name));
      if (event.payload.name === 'first') {
        runtime.scheduleIn('work', 2, { name: 'follow-up' }, { priority: 10 });
      }
    });

    sim.scheduleAt('work', 5, { name: 'late' }, { priority: 20 });
    sim.scheduleAt('work', 1, { name: 'first' }, { priority: 20 });
    sim.scheduleAt('work', 1, { name: 'priority' }, { priority: 10 });

    const result = sim.runUntil(10);

    expect(result.stoppedBy).toBe('empty');
    expect(sim.state.seen).toEqual(['priority', 'first', 'follow-up', 'late']);
    expect(sim.eventLog.map((entry) => entry.simTimeSec)).toEqual([1, 1, 3, 5]);
  });

  it('stops at the max-event guard for runaway models', () => {
    const sim = new DesSimulation({});
    sim.on('loop', ({ sim: runtime }) => runtime.scheduleIn('loop', 0));
    sim.scheduleAt('loop', 0);

    const result = sim.run({ untilSec: 1, maxEvents: 3 });

    expect(result.stoppedBy).toBe('max-events');
    expect(result.executedEvents).toBe(3);
    expect(result.remainingEvents).toBe(1);
  });
});
