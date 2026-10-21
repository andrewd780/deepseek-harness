import { describe, expect, it } from 'vitest'
import { EvaluationJobId, TaskId } from '../src/brand.ts'
import { calibrate } from '../src/calibrate.ts'
import type { Calibration, DeviationCalibration, DeviationSettings } from '../src/calibrate.ts'
import { aggregate } from '../src/evaluate.ts'
import { evaluation } from './fixtures.ts'

const settings: DeviationSettings = { method: 'z', z: 2, resamples: 500, seed: 7 }

function deviation(calibration: Calibration): DeviationCalibration {
  if (calibration.method !== 'z') throw new Error(`expected a z calibration, got ${calibration.method}`)
  return calibration
}

describe('calibrate', () => {
  it('needs a base evaluation', () => {
    expect(() => calibrate([], settings)).toThrow('self-improve calibration needs at least one base evaluation')
    expect(() => calibrate([], { method: 'spread' })).toThrow('self-improve calibration needs at least one base evaluation')
  })

  it('bootstraps the band from one evaluation, reproducibly', () => {
    const base = evaluation('base', { a: [1, 0], b: [1, 1], c: [0, 0], d: [1, 0] })
    const first = deviation(calibrate([base], settings))
    expect(first.estimate).toBe('bootstrap')
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
    const result = deviation(calibrate(runs, settings))
    expect(result.estimate).toBe('repeated')
    expect(result.deviation).toBeCloseTo(0.25 * Math.SQRT2)
    expect(result.delta).toBeCloseTo(0.5 * Math.SQRT2)
  })

  it('falls back to the bootstrap when repeated scores coincide', () => {
    const runs = [evaluation('base', { a: [1, 0] }), evaluation('base-1', { a: [0, 1] })]
    expect(deviation(calibrate(runs, settings)).estimate).toBe('bootstrap')
  })

  it('is zero for constant or weightless trials', () => {
    expect(calibrate([evaluation('base', { a: [1, 1], b: [] })], settings).delta).toBe(0)
    const weightless = aggregate(EvaluationJobId('w'), 2, new Map([[TaskId('a'), { rewards: [1, 0], weights: [0, 0], tokens: [], missing: 0 }]]))
    expect(calibrate([weightless], settings).delta).toBe(0)
    const missingWeights = aggregate(EvaluationJobId('m'), 2, new Map([[TaskId('a'), { rewards: [1, 0], weights: [], tokens: [], missing: 0 }]]))
    expect(calibrate([missingWeights], settings).delta).toBeGreaterThan(0)
    expect(calibrate([evaluation('base', { a: [1, 0] })], { ...settings, resamples: 1 }).delta).toBe(0)
  })

  it('takes the largest difference between evaluations as the spread, half of z = 2 on two evaluations', () => {
    const tasks = (passes: number) => Object.fromEntries(Array.from({ length: 89 }, (_, task) => [`t${task}`, [task * 2 < passes ? 1 : 0, task * 2 + 1 < passes ? 1 : 0]]))
    const two = [evaluation('base', tasks(120)), evaluation('base-1', tasks(123))]
    const spread = calibrate(two, { method: 'spread' })
    expect(spread).toMatchObject({ method: 'spread', scores: [120 / 178, 123 / 178] })
    expect(spread.delta).toBeCloseTo(3 / 178)
    expect(calibrate(two, settings).delta).toBeCloseTo(2 * spread.delta)
    const three = [...two, evaluation('base-2', tasks(118))]
    expect(calibrate(three, { method: 'spread' }).delta).toBeCloseTo(5 / 178)
  })

  it('needs two evaluations for the spread', () => {
    expect(() => calibrate([evaluation('base', { a: [1, 0] })], { method: 'spread' }))
      .toThrow('self-improve spread calibration needs at least two base evaluations; calibrate with repeats')
  })
})
