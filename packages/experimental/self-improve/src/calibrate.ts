/**
 * The noise band δ of a run: how far two independent evaluations of the same
 * harness revision differ.
 *
 * With two or more evaluations of the unchanged base revision the null
 * difference is observed directly: its standard deviation is the sample
 * standard deviation of the scores times √2. With one evaluation, or when the
 * scores coincide, the standard error of the score is bootstrapped over trials
 * within each task, and two independent evaluations differ with standard
 * deviation √2 times that error. Either way δ = z × deviation, so an unchanged
 * revision clears the floor S* − δ about 97.5% of the time at z = 2. Repeated
 * evaluations are the stronger estimate: a bootstrap over few trials per task
 * understates variance that only a second run exposes.
 *
 * @module @deepseek-ai/dsh-experimental-self-improve/calibrate
 */

import type { EvaluationResult } from './evaluate.ts'

/** The calibrated noise band and the estimates behind it. */
export interface Calibration {
  readonly delta: number
  readonly z: number
  /** The deviation δ rests on. */
  readonly deviation: number
  readonly method: 'repeated' | 'bootstrap'
  /** The bootstrapped deviation, reported for either method. */
  readonly bootstrapDeviation: number
  readonly scores: readonly number[]
}

/** Bootstrap settings. */
export interface CalibrationSettings {
  /** Multiple of the null deviation that forms δ. */
  readonly z: number
  readonly resamples: number
  /** Seed of the resampling generator, so a calibration is reproducible. */
  readonly seed: number
}

/**
 * Calibrate δ from evaluations of the unchanged base revision.
 * @param evaluations - one or more evaluations of the same revision on the same tasks.
 * @param settings - z, resamples, and seed.
 * @returns the calibration.
 * @throws Error when `evaluations` is empty.
 */
export function calibrate(evaluations: readonly EvaluationResult[], settings: CalibrationSettings): Calibration {
  const first = evaluations[0]
  if (first === undefined) throw new Error('self-improve calibration needs at least one base evaluation')
  const scores = evaluations.map(evaluation => evaluation.score)
  const pooled = poolTrials(evaluations)
  const pooledTrials = evaluations.reduce((sum, evaluation) => sum + evaluation.trials, 0)
  const error = bootstrapError(pooled, settings.resamples, settings.seed)
  const bootstrapDeviation = Math.SQRT2 * error * Math.sqrt(pooledTrials / first.trials)
  const observed = scores.length >= 2 ? sampleDeviation(scores) * Math.SQRT2 : 0
  const method = observed > 0 ? 'repeated' : 'bootstrap'
  const deviation = method === 'repeated' ? observed : bootstrapDeviation
  return { delta: settings.z * deviation, z: settings.z, deviation, method, bootstrapDeviation, scores }
}

interface Trial {
  readonly reward: number
  readonly weight: number
}

/** Every task's trials across the evaluations; tasks without trials are dropped. */
function poolTrials(evaluations: readonly EvaluationResult[]): readonly (readonly Trial[])[] {
  const pooled = new Map<string, Trial[]>()
  for (const evaluation of evaluations) {
    for (const [task, result] of evaluation.perTask) {
      const trials = pooled.get(task) ?? []
      result.rewards.forEach((reward, index) => {
        trials.push({ reward, weight: result.weights[index] ?? 1 })
      })
      pooled.set(task, trials)
    }
  }
  return [...pooled.values()].filter(trials => trials.length > 0)
}

/** Population standard deviation of the weighted mean over resamples of trials within each task. */
function bootstrapError(tasks: readonly (readonly Trial[])[], resamples: number, seed: number): number {
  const random = generator(seed)
  const values: number[] = []
  for (let resample = 0; resample < resamples; resample += 1) {
    let weighted = 0
    let weight = 0
    for (const trials of tasks) {
      for (let draw = 0; draw < trials.length; draw += 1) {
        const trial = trials[Math.floor(random() * trials.length)]
        /* v8 ignore next -- the index is drawn from [0, trials.length). */
        if (trial === undefined) continue
        weighted += trial.reward * trial.weight
        weight += trial.weight
      }
    }
    values.push(weight === 0 ? 0 : weighted / weight)
  }
  return values.length > 1 ? Math.sqrt(variance(values, values.length)) : 0
}

function sampleDeviation(values: readonly number[]): number {
  return Math.sqrt(variance(values, values.length - 1))
}

function variance(values: readonly number[], divisor: number): number {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  return values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / divisor
}

/** Mulberry32: a small seeded generator of uniform values in `[0, 1)`. */
function generator(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6D2B79F5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}
