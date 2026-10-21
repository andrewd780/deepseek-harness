import { describe, expect, it, vi } from 'vitest'
import { EvaluationJobId, TaskId } from '../src/brand.ts'
import { renderEvidence, selectTraces } from '../src/evidence.ts'
import type { SelfImproveDomain } from '../src/types.ts'
import { evaluation } from './fixtures.ts'

const perTask = evaluation('base', { a: [1, 1], b: [0, 0.5], c: [0.5, 0.5], d: [1, 0], e: [] }).perTask

describe('selectTraces', () => {
  it('shows the worst trial of the weakest tasks and the best trial of the strongest', () => {
    expect(selectTraces(perTask, 2, 2)).toEqual([
      { task: 'b', trial: 0, kind: 'failure', reward: 0 },
      { task: 'c', trial: 0, kind: 'failure', reward: 0.5 },
      { task: 'd', trial: 0, kind: 'success', reward: 1 },
      { task: 'a', trial: 0, kind: 'success', reward: 1 },
    ])
  })

  it('shows no successes when asked for none, and every task at most once', () => {
    expect(selectTraces(perTask, 1, 0).map(trace => trace.task)).toEqual(['b'])
    expect(selectTraces(perTask, 9, 9).map(trace => trace.task)).toEqual(['b', 'c', 'd', 'a'])
  })
})

describe('renderEvidence', () => {
  it('renders each trial and drops trials without a trajectory', async () => {
    const renderTrace = vi.fn(async (_job: string, task: string) => (task === 'c' ? undefined : `trace ${task}`))
    const domain = { renderTrace } as Pick<SelfImproveDomain, 'renderTrace'> as SelfImproveDomain
    const signal = new AbortController().signal
    const rendered = await renderEvidence(domain, EvaluationJobId('base'), selectTraces(perTask, 2, 1), signal)
    expect(rendered.map(trace => [trace.task, trace.text])).toEqual([['b', 'trace b'], ['a', 'trace a']])
    expect(renderTrace).toHaveBeenCalledWith('base', TaskId('b'), 0, signal)
  })
})
