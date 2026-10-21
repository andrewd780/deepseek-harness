/**
 * Branded identifiers that cross the self-improvement run's persistence and
 * domain boundaries.
 *
 * @module @deepseek-ai/dsh-experimental-self-improve/brand
 */

import { brandString } from '@deepseek-ai/dsh-brand'
import type { Branded } from '@deepseek-ai/dsh-brand'

/** One evaluation task of a domain's task suite. */
export type TaskId = Branded<'SelfImproveTaskId'>

/**
 * Brand a string as a {@link TaskId}.
 * @param id - task identifier from the domain's suite.
 * @returns the same string with the task-id brand.
 */
export function TaskId(id: string): TaskId {
  return brandString<TaskId>(id)
}

/** One evaluation of a harness on a task list with k trials per task. */
export type EvaluationJobId = Branded<'SelfImproveEvaluationJobId'>

/**
 * Brand a string as an {@link EvaluationJobId}.
 * @param id - job identifier chosen by the loop, such as `base` or `r3-a`.
 * @returns the same string with the evaluation-job-id brand.
 */
export function EvaluationJobId(id: string): EvaluationJobId {
  return brandString<EvaluationJobId>(id)
}
