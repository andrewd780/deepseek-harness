import { describe, expect, it } from 'vitest'
import { EvaluationJobId, TaskId } from '../src/brand.ts'
import { calibrate } from '../src/calibrate.ts'
import { aggregate } from '../src/evaluate.ts'
import { evaluation } from './fixtures.ts'

const settings = { z: 2, resamples: 500, seed: 7 }

describe('calibrate', () => {
  it('needs a base evaluation', () => {
    expect(() => calibrate([], settings)).toThrow('self-improve calibration needs at least one base evaluation')
  })

  it('bootstraps the band from one evaluation, reproducibly', () => {
    const base = evaluation('base', { a: [1, 0], b: [1, 1], c: [0, 0], d: [1, 0] })
    const first = calibrate([base], settings)
    expect(first.method).toBe('bootstrap')
    expect(first.deviation).toBe(first.bootstrapDeviation)
    expect(first.delta).toBeCloseTo(2 * first.deviation)
    expect(first.delta).toBeGreaterThan(0)
    expect(first.scores).toEqual([base.score])
    expect(calibrate([base], settings)).toEqual(first)
    expect(calibrate([base], { ...settings, seed: 8 }).delta).not.toBe(first.delta)
  })

  it('observes the band directly from repeated evaluations', () => {
    const runs = [
      evaluation('base', { a: [1, 0], b: [1, 1] }),
      evaluation('base-1', { a: [0, 0], b: [1, 1] }),
      evaluation('base-2', { a: [1, 1], b: [1, 1] }),
    ]
    const result = calibrate(runs, settings)
    expect(result.method).toBe('repeated')
    expect(result.deviation).toBeCloseTo(0.25 * Math.SQRT2)
    expect(result.delta).toBeCloseTo(0.5 * Math.SQRT2)
  })

  it('falls back to the bootstrap when repeated scores coincide', () => {
    const runs = [evaluation('base', { a: [1, 0] }), evaluation('base-1', { a: [0, 1] })]
    expect(calibrate(runs, settings).method).toBe('bootstrap')
  })

  it('is zero for constant or weightless trials', () => {
    expect(calibrate([evaluation('base', { a: [1, 1], b: [] })], settings).delta).toBe(0)
    const weightless = aggregate(EvaluationJobId('w'), 2, new Map([[TaskId('a'), { rewards: [1, 0], weights: [0, 0], tokens: [], missing: 0 }]]))
    expect(calibrate([weightless], settings).delta).toBe(0)
    const missingWeights = aggregate(EvaluationJobId('m'), 2, new Map([[TaskId('a'), { rewards: [1, 0], weights: [], tokens: [], missing: 0 }]]))
    expect(calibrate([missingWeights], settings).delta).toBeGreaterThan(0)
    expect(calibrate([evaluation('base', { a: [1, 0] })], { ...settings, resamples: 1 }).delta).toBe(0)
  })
})
