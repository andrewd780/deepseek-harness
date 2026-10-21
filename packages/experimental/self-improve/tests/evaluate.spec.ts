import { describe, expect, it } from 'vitest'
import { EvaluationJobId, TaskId } from '../src/brand.ts'
import { aggregate, relativeCostChange, taskMean, taskResult } from '../src/evaluate.ts'
import { evaluation } from './fixtures.ts'

describe('aggregate', () => {
  it('scores the weighted mean of every trial, missing trials included as 0', () => {
    const perTask = new Map([
      [TaskId('a'), { rewards: [1, 0], weights: [3, 1], tokens: [100, undefined], missing: 1 }],
      [TaskId('b'), taskResult([0.5, 0.5], [300, 0])],
    ])
    const result = aggregate(EvaluationJobId('job'), 2, perTask, { promptTokens: 7 })
    expect(result.score).toBeCloseTo((3 + 0 + 0.5 + 0.5) / 6)
    expect(result.cost).toBe(200)
    expect(result.expectedTrials).toBe(4)
    expect(result.missing).toBe(1)
    expect(result.measures).toEqual({ promptTokens: 7 })
  })

  it('weights a trial without a stated weight as 1', () => {
    const perTask = new Map([[TaskId('a'), { rewards: [1, 0, 1], weights: [2], tokens: [], missing: 0 }]])
    expect(aggregate(EvaluationJobId('job'), 3, perTask).score).toBeCloseTo(3 / 4)
    expect(taskMean(perTask.get(TaskId('a'))!)).toBeCloseTo(3 / 4)
  })

  it('builds a unit-weight task result that reported no tokens', () => {
    expect(taskResult([1, 0])).toEqual({ rewards: [1, 0], weights: [1, 1], tokens: [undefined, undefined], missing: 0 })
  })

  it('reports no cost when no trial reported tokens, and scores an empty job 0', () => {
    expect(evaluation('job', { a: [1, 1] }).cost).toBeUndefined()
    const empty = aggregate(EvaluationJobId('empty'), 2, new Map())
    expect(empty.score).toBe(0)
    expect(empty.measures).toEqual({})
    expect(taskMean({ rewards: [], weights: [], tokens: [], missing: 0 })).toBe(0)
  })
})

describe('relativeCostChange', () => {
  it('is the relative change, and 0 when either side reported no tokens', () => {
    expect(relativeCostChange(150, 100)).toBeCloseTo(0.5)
    expect(relativeCostChange(undefined, 100)).toBe(0)
    expect(relativeCostChange(100, undefined)).toBe(0)
    expect(relativeCostChange(0, 100)).toBe(0)
    expect(relativeCostChange(100, 0)).toBe(0)
  })
})
