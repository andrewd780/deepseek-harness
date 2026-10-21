/**
 * Score and cost of one evaluation: a harness measured on a task list with k
 * trials per task.
 *
 * @module @deepseek-ai/dsh-experimental-self-improve/evaluate
 */

import type { EvaluationJobId, TaskId } from './brand.ts'

/** Trials of one task. A trial that never produced a result counts as reward 0 and stays in the denominator. */
export interface TaskResult {
  /** One reward in `[0, 1]` per trial; a missing trial is 0. */
  readonly rewards: readonly number[]
  /** One positive weight per trial; an unweighted suite uses 1. */
  readonly weights: readonly number[]
  /** Policy tokens per trial, or `undefined` when the trial reported none. */
  readonly tokens: readonly (number | undefined)[]
  /** Trials that produced no result. */
  readonly missing: number
}

/** The measured score and cost of one evaluation job. */
export interface EvaluationResult {
  readonly job: EvaluationJobId
  /** Trials per task. */
  readonly trials: number
  readonly perTask: ReadonlyMap<TaskId, TaskResult>
  /** Weighted mean reward over every trial, in `[0, 1]`. */
  readonly score: number
  /** Mean policy tokens over trials that reported a positive count, or `undefined` when none did. */
  readonly cost: number | undefined
  /** Tasks × trials. */
  readonly expectedTrials: number
  /** Trials that produced no result. */
  readonly missing: number
  /** Domain measurements beyond score and cost, such as mean prompt tokens; guards read them. */
  readonly measures: Readonly<Record<string, number>>
}

/**
 * Build one task's result with unit weights.
 * @param rewards - one reward per trial, missing trials already 0.
 * @param tokens - policy tokens per trial; omitted means none reported.
 * @param missing - trials that produced no result.
 * @returns the task result.
 */
export function taskResult(
  rewards: readonly number[],
  tokens: readonly (number | undefined)[] = rewards.map(() => undefined),
  missing = 0,
): TaskResult {
  return { rewards, weights: rewards.map(() => 1), tokens, missing }
}

/**
 * Fold per-task trials into the job's score and cost. The score is the
 * weighted mean of every trial's reward, so a candidate cannot raise it by
 * losing the trials it finds hard; the cost is the mean of the positive token
 * counts reported.
 * @param job - the evaluation job.
 * @param trials - trials per task.
 * @param perTask - every task's trials.
 * @param measures - the domain's measurements of the job.
 * @returns the aggregated result.
 */
export function aggregate(
  job: EvaluationJobId,
  trials: number,
  perTask: ReadonlyMap<TaskId, TaskResult>,
  measures: Readonly<Record<string, number>> = {},
): EvaluationResult {
  let weighted = 0
  let weight = 0
  let tokenSum = 0
  let tokenCount = 0
  let missing = 0
  for (const result of perTask.values()) {
    result.rewards.forEach((reward, index) => {
      const trialWeight = result.weights[index] ?? 1
      weighted += reward * trialWeight
      weight += trialWeight
    })
    for (const tokens of result.tokens) {
      if (tokens !== undefined && tokens > 0) {
        tokenSum += tokens
        tokenCount += 1
      }
    }
    missing += result.missing
  }
  return {
    job,
    trials,
    perTask,
    score: weight === 0 ? 0 : weighted / weight,
    cost: tokenCount === 0 ? undefined : tokenSum / tokenCount,
    expectedTrials: perTask.size * trials,
    missing,
    measures,
  }
}

/**
 * One task's weighted mean reward.
 * @param result - the task's trials.
 * @returns the mean, or 0 when the task has no weight.
 */
export function taskMean(result: TaskResult): number {
  let weighted = 0
  let weight = 0
  result.rewards.forEach((reward, index) => {
    const trialWeight = result.weights[index] ?? 1
    weighted += reward * trialWeight
    weight += trialWeight
  })
  return weight === 0 ? 0 : weighted / weight
}

/**
 * Relative change of a candidate's cost against the incumbent's.
 * @param candidate - the candidate's mean policy tokens.
 * @param incumbent - the incumbent's mean policy tokens.
 * @returns `(candidate − incumbent) / incumbent`, or 0 when either side reported no tokens.
 */
export function relativeCostChange(candidate: number | undefined, incumbent: number | undefined): number {
  if (candidate === undefined || incumbent === undefined || candidate === 0 || incumbent === 0) return 0
  return (candidate - incumbent) / incumbent
}
