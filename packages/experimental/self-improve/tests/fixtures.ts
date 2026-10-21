import { EvaluationJobId, TaskId } from '../src/brand.ts'
import type { ComponentSet } from '../src/components.ts'
import { aggregate, taskResult } from '../src/evaluate.ts'
import type { EvaluationResult, TaskResult } from '../src/evaluate.ts'
import type { SelectionPolicy } from '../src/selection.ts'

export const componentSet: ComponentSet = {
  names: ['prompt', 'control_flow', 'config', 'context_mgmt', 'skill', 'subagent'],
  structural: ['skill', 'subagent'],
  signals: [
    { component: 'skill', patterns: [/skills\//] },
    { component: 'subagent', patterns: [/subagent/] },
    { component: 'context_mgmt', patterns: [/compaction/] },
    { component: 'config', patterns: [/timeoutMs/] },
  ],
  fallback: 'prompt',
}

export const policy: SelectionPolicy = {
  delta: 0.05,
  costAllowance: 0.1,
  costPerGain: 2,
  scoreWeight: 0,
  costWeight: 15,
  noveltyWeight: 0.5,
}

/** An evaluation whose tasks carry the given per-trial rewards and, optionally, tokens. */
export function evaluation(
  job: string,
  rewards: Readonly<Record<string, readonly number[]>>,
  tokens: Readonly<Record<string, readonly (number | undefined)[]>> = {},
  measures: Readonly<Record<string, number>> = {},
): EvaluationResult {
  const perTask = new Map<TaskId, TaskResult>()
  let trials = 0
  for (const [task, values] of Object.entries(rewards)) {
    trials = Math.max(trials, values.length)
    perTask.set(TaskId(task), taskResult(values, tokens[task] ?? values.map(() => undefined)))
  }
  return aggregate(EvaluationJobId(job), trials, perTask, measures)
}
