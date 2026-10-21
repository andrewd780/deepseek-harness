/**
 * The run spec: one JSON file naming what a run evolves, how trials and the
 * search roles run, and the run's constants. Omitted constants take the values
 * of the reference coding instance of regularized recursive self-improvement
 * (89 tasks, k = 2, T = 20, m = 2); `delta` has no default because the noise
 * band belongs to the suite, so a spec names a value or `"calibrate"`. The
 * cost allowance per gain defaults to 25% more tokens per passing trial
 * (`selection.costPerPass`), which is the reference's β₁ of 44.5 on its 178
 * trials; `selection.costPerGain` sets β₁ per unit of score instead, and
 * `scoreWeightPerPass` and `scoreWeight` set w_s the same two ways.
 *
 * ```json
 * {
 *   "name": "small-window",
 *   "suite": "suite.json",
 *   "evolvedDirectory": "harness/evolved",
 *   "trial": {
 *     "policyPatches": ["policy.patch.yml"],
 *     "provider": "deepseek",
 *     "model": "deepseek-v4-flash",
 *     "forwardEnv": ["DEEPSEEK_API_KEY"]
 *   },
 *   "roles": { "provider": "deepseek", "model": "deepseek-v4-pro" },
 *   "delta": "calibrate"
 * }
 * ```
 *
 * @module @deepseek-ai/dsh-experimental-self-improve/spec
 */

import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'

import type { CalibrationSettings } from './calibrate.ts'
import type { RunSettings } from './loop.ts'
import type { ScoreRate } from './selection.ts'

/** How each trial's runtime starts. */
export interface TrialSpec {
  readonly profile: string
  /** Absolute frozen patches applied after the candidate's overlay. */
  readonly policyPatches: readonly string[]
  readonly provider: string
  readonly model: string
  /** Names of operator environment variables each trial receives, such as the policy's credential. */
  readonly forwardEnv: readonly string[]
  /** Literal variables each trial receives. */
  readonly env: Readonly<Record<string, string>>
  readonly timeoutMs: number
  readonly shutdownTimeoutMs: number
  readonly concurrency: number
  /** Longest rendering of one message or tool payload in a trace. */
  readonly maxTraceCharacters: number
  /** Largest relative growth of the first request's prompt; `undefined` sets no guard. */
  readonly maxPromptGrowth: number | undefined
}

/** How the analyst, proposer, and critic call their model. */
export interface RolesSpec {
  readonly provider: string
  readonly model: string
  readonly maxOutputTokens: number
  readonly timeoutMs: number
  readonly proposerTurns: number
  readonly maxReadCharacters: number
  readonly criticAttempts: number
  readonly maxDiffCharacters: number
}

/** A resolved run spec. */
export interface RunSpec {
  /** The run's name: its directory under the runs directory and its default branch. */
  readonly name: string
  /** Absolute path of the suite file. */
  readonly suite: string
  /** The evolved directory's path relative to the repository root. */
  readonly evolvedDirectory: string
  /** Absolute directory inside the repository that holds the evolved directory. */
  readonly repository: string
  readonly branch: string
  readonly startPoint: string
  readonly trial: TrialSpec
  readonly roles: RolesSpec
  readonly settings: RunSettings
  readonly calibration: CalibrationSettings
}

const NAME = /^[\w.-]+$/

/**
 * Read and resolve a run spec. Relative paths resolve against the spec file's directory.
 * @param path - absolute path of the spec file.
 * @returns the spec.
 * @throws Error naming every problem found.
 */
export async function loadRunSpec(path: string): Promise<RunSpec> {
  const text = await readFile(path, 'utf8')
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new Error(`self-improve run spec ${path} is not JSON`, { cause: error })
  }
  const problems: string[] = []
  const spec = resolveRunSpec(value, dirname(path), problems)
  if (problems.length > 0) throw new Error(`self-improve run spec ${path} is invalid:\n- ${problems.join('\n- ')}`)
  return spec
}

/**
 * Resolve a parsed run spec, filling the reference defaults.
 * @param value - the parsed JSON.
 * @param base - the directory relative paths resolve against.
 * @param problems - receives one line per invalid field.
 * @returns the spec; meaningful only when `problems` stayed empty.
 */
export function resolveRunSpec(value: unknown, base: string, problems: string[]): RunSpec {
  const root = new Fields(isRecord(value) ? value : {}, '', problems)
  if (!isRecord(value)) problems.push('the run spec must be a JSON object')
  const name = root.text('name')
  if (name !== '' && !NAME.test(name)) problems.push('name must be letters, digits, \'.\', \'_\', or \'-\'')
  const trial = root.child('trial')
  const roles = root.child('roles')
  const selection = root.child('selection')
  const calibration = root.child('calibration')
  const delta = root.raw('delta')
  if (delta !== 'calibrate' && !(typeof delta === 'number' && Number.isFinite(delta) && delta >= 0)) {
    problems.push('delta must be a non-negative number or "calibrate"')
  }
  const evolvedDirectory = root.text('evolvedDirectory')
  if (isAbsolute(evolvedDirectory)) problems.push('evolvedDirectory must be relative to the repository root')
  const policyPatches = trial.texts('policyPatches').map(patch => resolve(base, patch))
  if (policyPatches.length === 0) problems.push('trial.policyPatches must name at least one frozen patch')
  const settings: RunSettings = {
    rounds: root.count('rounds', 20),
    variants: root.count('variants', 2, 26),
    trials: root.count('trials', 2),
    minEdits: root.count('minEdits', 1),
    maxEdits: root.count('maxEdits', 4),
    stallWindow: root.count('stallWindow', 3),
    reservedSlots: root.count('reservedSlots', 1, undefined, 0),
    pruneWindow: root.count('pruneWindow', 4),
    repairRounds: root.count('repairRounds', 5, undefined, 0),
    failureTraces: root.count('failureTraces', 30, undefined, 0),
    successTraces: root.count('successTraces', 6, undefined, 0),
    maxMissingFraction: root.fraction('maxMissingFraction', 0.2),
    historyLimit: root.count('historyLimit', 40),
    delta: typeof delta === 'number' ? delta : undefined,
    selection: {
      costAllowance: selection.number('costAllowance', 0.1),
      costPerGain: selection.rate('costPerGain', 'costPerPass', 0.25),
      scoreWeight: selection.rate('scoreWeight', 'scoreWeightPerPass', 0),
      costWeight: selection.number('costWeight', 15),
      noveltyWeight: selection.number('noveltyWeight', 0.5),
    },
  }
  if (settings.minEdits > settings.maxEdits) problems.push('minEdits must not exceed maxEdits')
  const growth = trial.raw('maxPromptGrowth')
  if (growth !== undefined && !(typeof growth === 'number' && Number.isFinite(growth) && growth >= 0)) {
    problems.push('trial.maxPromptGrowth must be a non-negative number')
  }
  return {
    name,
    suite: resolve(base, root.text('suite')),
    evolvedDirectory,
    repository: resolve(base, root.text('repository', '.')),
    branch: root.text('branch', `self-improve/${name}`),
    startPoint: root.text('startPoint', 'HEAD'),
    trial: {
      profile: trial.text('profile', 'sdk'),
      policyPatches,
      provider: trial.text('provider'),
      model: trial.text('model'),
      forwardEnv: trial.texts('forwardEnv'),
      env: trial.textMap('env'),
      timeoutMs: trial.count('timeoutMs', 1_800_000),
      shutdownTimeoutMs: trial.count('shutdownTimeoutMs', 10_000),
      concurrency: trial.count('concurrency', 1),
      maxTraceCharacters: trial.count('maxTraceCharacters', 2_000),
      maxPromptGrowth: typeof growth === 'number' ? growth : undefined,
    },
    roles: {
      provider: roles.text('provider'),
      model: roles.text('model'),
      maxOutputTokens: roles.count('maxOutputTokens', 16_384),
      timeoutMs: roles.count('timeoutMs', 600_000),
      proposerTurns: roles.count('proposerTurns', 40),
      maxReadCharacters: roles.count('maxReadCharacters', 150_000),
      criticAttempts: roles.count('criticAttempts', 3),
      maxDiffCharacters: roles.count('maxDiffCharacters', 120_000),
    },
    settings,
    calibration: {
      z: calibration.number('z', 2),
      resamples: calibration.count('resamples', 2_000),
      seed: calibration.count('seed', 7, undefined, 0),
    },
  }
}

/** Reads typed fields of one object, recording a problem per invalid field. */
class Fields {
  constructor(
    private readonly value: Readonly<Record<string, unknown>>,
    private readonly prefix: string,
    private readonly problems: string[],
  ) {}

  raw(key: string): unknown {
    return this.value[key]
  }

  child(key: string): Fields {
    const value = this.value[key]
    if (value !== undefined && !isRecord(value)) this.problems.push(`${this.prefix}${key} must be an object`)
    return new Fields(isRecord(value) ? value : {}, `${this.prefix}${key}.`, this.problems)
  }

  /** A string, required when `fallback` is absent. */
  text(key: string, fallback?: string): string {
    const value = this.value[key]
    if (value === undefined && fallback !== undefined) return fallback
    if (typeof value === 'string' && value.length > 0) return value
    this.problems.push(`${this.prefix}${key} must be non-empty text`)
    return ''
  }

  texts(key: string): readonly string[] {
    const value = this.value[key]
    if (value === undefined) return []
    if (Array.isArray(value) && value.every((entry): entry is string => typeof entry === 'string' && entry.length > 0)) return value
    this.problems.push(`${this.prefix}${key} must be an array of non-empty strings`)
    return []
  }

  textMap(key: string): Readonly<Record<string, string>> {
    const value = this.value[key]
    if (value === undefined) return {}
    if (isRecord(value) && Object.values(value).every(entry => typeof entry === 'string')) return value as Readonly<Record<string, string>>
    this.problems.push(`${this.prefix}${key} must map names to strings`)
    return {}
  }

  number(key: string, fallback: number): number {
    const value = this.value[key]
    if (value === undefined) return fallback
    if (typeof value === 'number' && Number.isFinite(value)) return value
    this.problems.push(`${this.prefix}${key} must be a number`)
    return fallback
  }

  /** A rate per unit of score or per passing trial, never both; when neither is set, `fallback` per passing trial. */
  rate(perScore: string, perPass: string, fallback: number): ScoreRate {
    const score = this.value[perScore]
    if (score !== undefined && this.value[perPass] !== undefined) {
      this.problems.push(`${this.prefix}${perScore} and ${this.prefix}${perPass} must not both be set`)
    }
    if (score !== undefined) return { value: this.number(perScore, fallback), perPass: false }
    return { value: this.number(perPass, fallback), perPass: true }
  }

  /** An integer in `[minimum, maximum]`. */
  count(key: string, fallback: number, maximum = Number.MAX_SAFE_INTEGER, minimum = 1): number {
    const value = this.value[key]
    if (value === undefined) return fallback
    if (typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum) return value
    this.problems.push(`${this.prefix}${key} must be an integer from ${minimum} to ${maximum}`)
    return fallback
  }

  fraction(key: string, fallback: number): number {
    const value = this.number(key, fallback)
    if (value < 0 || value > 1) this.problems.push(`${this.prefix}${key} must be between 0 and 1`)
    return value
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
