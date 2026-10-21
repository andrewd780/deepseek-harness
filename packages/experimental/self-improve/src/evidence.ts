/**
 * The trajectories a round shows its analyst and proposer: the worst trial of
 * the weakest tasks, and the best trial of the strongest ones, whose habits a
 * candidate must not break.
 *
 * @module @deepseek-ai/dsh-experimental-self-improve/evidence
 */

import type { EvaluationJobId, TaskId } from './brand.ts'
import { taskMean } from './evaluate.ts'
import type { TaskResult } from './evaluate.ts'
import type { RenderedTrace, SelfImproveDomain, TraceReference } from './types.ts'

/**
 * Choose the evidence trials of an evaluation. Tasks are ranked by mean reward,
 * ties in evaluation order; the lowest `failures` give their worst trial and
 * the highest `successes`, when not already chosen, give their best.
 * @param perTask - the evaluation's trials.
 * @param failures - weakest tasks shown.
 * @param successes - strongest tasks shown.
 * @returns the chosen trials, failures first.
 */
export function selectTraces(
  perTask: ReadonlyMap<TaskId, TaskResult>,
  failures: number,
  successes: number,
): readonly TraceReference[] {
  const ranked = [...perTask]
    .filter(([, result]) => result.rewards.length > 0)
    .map(([task, result]) => ({ task, result, mean: taskMean(result) }))
    .sort((left, right) => left.mean - right.mean)
  const weak = ranked.slice(0, failures)
  const chosen = new Set(weak.map(entry => entry.task))
  const strong = successes > 0 ? ranked.slice(-successes).filter(entry => !chosen.has(entry.task)) : []
  return [
    ...weak.map(entry => reference(entry.task, entry.result, 'failure')),
    ...strong.map(entry => reference(entry.task, entry.result, 'success')),
  ]
}

/**
 * Render the chosen trials, dropping those that left no trajectory.
 * @param domain - renders one trial.
 * @param job - the evaluation the trials belong to.
 * @param references - the chosen trials.
 * @param signal - cancellation.
 * @returns the rendered trials, in the order chosen.
 */
export async function renderEvidence(
  domain: SelfImproveDomain,
  job: EvaluationJobId,
  references: readonly TraceReference[],
  signal?: AbortSignal,
): Promise<readonly RenderedTrace[]> {
  const rendered: RenderedTrace[] = []
  for (const trace of references) {
    const text = await domain.renderTrace(job, trace.task, trace.trial, signal)
    if (text !== undefined) rendered.push({ ...trace, text })
  }
  return rendered
}

function reference(task: TaskId, result: TaskResult, kind: TraceReference['kind']): TraceReference {
  const target = kind === 'failure' ? Math.min(...result.rewards) : Math.max(...result.rewards)
  const trial = result.rewards.indexOf(target)
  return { task, trial, kind, reward: target }
}
