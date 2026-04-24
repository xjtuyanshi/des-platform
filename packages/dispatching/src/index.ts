import type { AMR, TransportTask } from '@des-platform/domain-model';

export type CompletionEstimate = {
  amrId: string;
  completionSec: number;
};

export function selectBestAmrForTask(
  task: TransportTask,
  idleAmrs: AMR[],
  estimateCompletionSec: (amr: AMR, task: TransportTask) => number
): CompletionEstimate | null {
  let best: CompletionEstimate | null = null;

  for (const amr of idleAmrs) {
    const completionSec = estimateCompletionSec(amr, task);
    const candidate = { amrId: amr.id, completionSec };

    if (
      best === null ||
      candidate.completionSec < best.completionSec ||
      (candidate.completionSec === best.completionSec && candidate.amrId < best.amrId)
    ) {
      best = candidate;
    }
  }

  return best;
}

export function computeDispatchPlan(
  pendingTasks: TransportTask[],
  idleAmrs: AMR[],
  estimateCompletionSec: (amr: AMR, task: TransportTask) => number
): Array<{ taskId: string; amrId: string }> {
  const remainingTasks = [...pendingTasks].sort((left, right) => left.requestTimeSec - right.requestTimeSec || left.id.localeCompare(right.id));
  const freeAmrs = [...idleAmrs].sort((left, right) => left.id.localeCompare(right.id));
  const assignments: Array<{ taskId: string; amrId: string }> = [];

  while (remainingTasks.length > 0 && freeAmrs.length > 0) {
    let bestPair: { taskIndex: number; amrIndex: number; completionSec: number } | null = null;

    for (let taskIndex = 0; taskIndex < remainingTasks.length; taskIndex += 1) {
      const task = remainingTasks[taskIndex];

      for (let amrIndex = 0; amrIndex < freeAmrs.length; amrIndex += 1) {
        const amr = freeAmrs[amrIndex];
        const completionSec = estimateCompletionSec(amr, task);

        if (
          bestPair === null ||
          completionSec < bestPair.completionSec ||
          (completionSec === bestPair.completionSec && task.id < remainingTasks[bestPair.taskIndex].id) ||
          (completionSec === bestPair.completionSec &&
            task.id === remainingTasks[bestPair.taskIndex].id &&
            amr.id < freeAmrs[bestPair.amrIndex].id)
        ) {
          bestPair = { taskIndex, amrIndex, completionSec };
        }
      }
    }

    if (bestPair === null) {
      break;
    }

    const [task] = remainingTasks.splice(bestPair.taskIndex, 1);
    const [amr] = freeAmrs.splice(bestPair.amrIndex, 1);
    assignments.push({ taskId: task.id, amrId: amr.id });
  }

  return assignments;
}
