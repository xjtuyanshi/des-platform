import { AMR, TransportTask } from '@des-platform/domain-model';

import { computeDispatchPlan, selectBestAmrForTask } from './index.js';

describe('dispatching', () => {
  const amrA = new AMR('AMR-1', 'home-1', 1.5, 1.5, 0.35, 1.5, 0, 0);
  const amrB = new AMR('AMR-2', 'home-2', 1.5, 1.5, 0.35, 1.5, 0, 0);

  it('selects the earliest completion and tie-breaks by AMR id', () => {
    const task = new TransportTask('TASK-1', 'S1', 'S1-A', 0, 180, 100);
    const best = selectBestAmrForTask(task, [amrB, amrA], (amr) => (amr.id === 'AMR-1' ? 10 : 10));
    expect(best).toEqual({ amrId: 'AMR-1', completionSec: 10 });
  });

  it('produces a deterministic multi-assignment plan', () => {
    const task1 = new TransportTask('TASK-1', 'S1', 'S1-A', 0, 180, 100);
    const task2 = new TransportTask('TASK-2', 'S2', 'S2-A', 0, 200, 110);
    const plan = computeDispatchPlan([task1, task2], [amrA, amrB], (amr, task) => {
      if (task.id === 'TASK-1') {
        return amr.id === 'AMR-1' ? 20 : 30;
      }
      return amr.id === 'AMR-2' ? 15 : 40;
    });

    expect(plan).toEqual([
      { taskId: 'TASK-2', amrId: 'AMR-2' },
      { taskId: 'TASK-1', amrId: 'AMR-1' }
    ]);
  });
});
