/**
 * The durable state of one self-improvement run, kept as files under one
 * directory: the trajectory of incumbents, the edit history, every
 * evaluation, and each round's records. Every file is replaced atomically and
 * validated when read; derived values are recomputed from stored trials.
 *
 * ```
 * <root>/trajectory.json        incumbents H_0, H_1, ... (the authoritative frontier)
 * <root>/history.jsonl          one record per edit
 * <root>/calibration.json       the noise band, when calibrated
 * <root>/jobs/<job>.json        one evaluation's trials
 * <root>/rounds/<t>/<name>      a round's records (analysis, directives, decisions)
 * <root>/rounds/<t>/<v>/<name>  a candidate's records (candidate, diff, critic verdicts)
 * ```
 *
 * @module @deepseek-ai/dsh-experimental-self-improve/directory
 */

import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

import { EvaluationJobId, TaskId } from './brand.ts'
import type { Calibration } from './calibrate.ts'
import type { ComponentSet } from './components.ts'
import { aggregate } from './evaluate.ts'
import type { EvaluationResult, TaskResult } from './evaluate.ts'
import { EditHistory } from './history.ts'
import type { GateOutcome } from './history.ts'
import type { CandidateEdit } from './selection.ts'

/** One incumbent of the trajectory: H_t for the entry at index t. */
export interface Revision {
  readonly commit: string
  readonly job: EvaluationJobId
  readonly score: number
  readonly cost: number | undefined
  /** The winning candidate's label; absent for the baseline and for rounds without a winner. */
  readonly variant?: string
}

/** Every incumbent of a run, H_0 first. */
export type Trajectory = readonly [Revision, ...Revision[]]

/** A candidate drafted, screened, and committed, waiting for or holding its evaluation. */
export interface ReadyCandidate {
  readonly status: 'ready'
  readonly variant: string
  readonly commit: string
  readonly branch: string
  readonly summary: string
  readonly edits: readonly CandidateEdit[]
}

/** A candidate stopped by a gate before evaluation. */
export interface GatedCandidate {
  readonly status: 'gated'
  readonly variant: string
  readonly outcome: GateOutcome
  readonly detail: string
  readonly edits: readonly CandidateEdit[]
}

/** A candidate's durable draft record. */
export type CandidateRecord = ReadyCandidate | GatedCandidate

const PRIVATE_FILE = { mode: 0o600, dirMode: 0o700 } as const
const JOB_NAME = /^[\w.-]+$/
const GATE_OUTCOMES: ReadonlySet<string> = new Set(['draft-failed', 'critic-rejected', 'smoke-failed', 'evaluation-invalid'])

/** The files of one run. */
export class RunDirectory {
  /**
   * @param root - absolute path of the run's directory; created on first write.
   */
  constructor(readonly root: string) {}

  /**
   * Hold the run for one operation, so two processes never advance one run.
   * @param operation - the work done while holding the run.
   * @returns the operation's result.
   * @throws Error when another live process holds the run.
   */
  async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(this.root, { recursive: true, mode: PRIVATE_FILE.dirMode })
    return await withFileLock(join(this.root, 'run'), operation, { waitMs: 0 })
  }

  /**
   * Read the trajectory: every accepted incumbent, H_0 first.
   * @returns the trajectory, or `undefined` before the baseline exists.
   * @throws Error when the file is not a valid trajectory.
   */
  async readTrajectory(): Promise<Trajectory | undefined> {
    const value = await this.readJson('trajectory.json')
    if (value === undefined) return undefined
    const invalid = new Error(`${join(this.root, 'trajectory.json')} is not a self-improve trajectory`)
    if (!Array.isArray(value) || !value.every(isRevision)) throw invalid
    const [first, ...rest] = value.map((entry): Revision => ({
      commit: entry.commit,
      job: EvaluationJobId(entry.job),
      score: entry.score,
      cost: entry.cost ?? undefined,
      ...entry.variant === undefined ? {} : { variant: entry.variant },
    }))
    if (first === undefined) throw invalid
    return [first, ...rest]
  }

  /**
   * Replace the trajectory: the run's commit point for a round.
   * @param trajectory - every incumbent, H_0 first.
   */
  async writeTrajectory(trajectory: Trajectory): Promise<void> {
    await this.writeJson('trajectory.json', trajectory.map(entry => ({ ...entry, cost: entry.cost ?? null })))
  }

  /**
   * Read the edit history: one record per drafted candidate.
   * @param componentSet - the domain's components.
   * @returns the edit history; empty before the first round.
   * @throws Error naming the first invalid line.
   */
  async readHistory(componentSet: ComponentSet): Promise<EditHistory> {
    const text = await this.readText('history.jsonl')
    return EditHistory.fromJsonl(text ?? '', componentSet)
  }

  /**
   * Replace the edit history.
   * @param history - the complete history.
   */
  async writeHistory(history: EditHistory): Promise<void> {
    await this.writeText('history.jsonl', history.toJsonl())
  }

  /**
   * Read one stored evaluation job.
   * @param job - the evaluation job.
   * @returns the evaluation, re-aggregated from its stored trials, or `undefined` when none is stored.
   * @throws Error when the file is not a valid evaluation.
   */
  async readEvaluation(job: EvaluationJobId): Promise<EvaluationResult | undefined> {
    const path = this.jobPath(job)
    const value = await this.readJson(path)
    if (value === undefined) return undefined
    const evaluation = evaluationOf(value, job)
    if (evaluation === undefined) throw new Error(`${join(this.root, path)} is not a self-improve evaluation of ${job}`)
    return evaluation
  }

  /**
   * Store an evaluation under its job, replacing an earlier one.
   * @param evaluation - the evaluation to store under its job.
   */
  async writeEvaluation(evaluation: EvaluationResult): Promise<void> {
    await this.writeJson(this.jobPath(evaluation.job), {
      job: evaluation.job,
      trials: evaluation.trials,
      perTask: Object.fromEntries([...evaluation.perTask].map(([task, result]) => [task, {
        rewards: result.rewards,
        weights: result.weights,
        tokens: result.tokens.map(tokens => tokens ?? null),
        missing: result.missing,
      }])),
      measures: evaluation.measures,
    })
  }

  /**
   * Read the calibration of δ.
   * @returns the stored calibration, or `undefined` when the run was never calibrated.
   * @throws Error when the file is not a valid calibration.
   */
  async readCalibration(): Promise<Calibration | undefined> {
    const value = await this.readJson('calibration.json')
    if (value === undefined) return undefined
    if (!isCalibration(value)) throw new Error(`${join(this.root, 'calibration.json')} is not a self-improve calibration`)
    return value
  }

  /**
   * Store the calibration of δ, replacing an earlier one.
   * @param calibration - the calibration to store.
   */
  async writeCalibration(calibration: Calibration): Promise<void> {
    await this.writeJson('calibration.json', calibration)
  }

  /**
   * Read one candidate's draft record.
   * @param round - the round.
   * @param variant - the candidate's label.
   * @returns the candidate's draft record, or `undefined` when it was never drafted to a decision.
   * @throws Error when the file is not a valid candidate record.
   */
  async readCandidate(round: number, variant: string): Promise<CandidateRecord | undefined> {
    const path = join(this.roundPath(round), variant, 'candidate.json')
    const value = await this.readJson(path)
    if (value === undefined) return undefined
    if (!isCandidateRecord(value, variant)) throw new Error(`${join(this.root, path)} is not a self-improve candidate record`)
    return value
  }

  /**
   * Store one candidate's draft record, replacing an earlier one.
   * @param round - the round.
   * @param record - the candidate's draft record.
   */
  async writeCandidate(round: number, record: CandidateRecord): Promise<void> {
    await this.writeJson(join(this.roundPath(round), record.variant, 'candidate.json'), record)
  }

  /**
   * Read one text record of a round, or of one of its candidates.
   * @param round - the round.
   * @param name - the record's file name, prefixed by the candidate's label for a candidate record.
   * @returns the text, or `undefined` when absent.
   */
  async readRoundText(round: number, name: string): Promise<string | undefined> {
    return await this.readText(join(this.roundPath(round), name))
  }

  /**
   * Write one record of a round, or of one of its candidates.
   * @param round - the round.
   * @param name - the record's file name, prefixed by the candidate's label for a candidate record.
   * @param content - text, or a value stored as JSON.
   */
  async writeRoundRecord(round: number, name: string, content: unknown): Promise<void> {
    const path = join(this.roundPath(round), name)
    if (typeof content === 'string') await this.writeText(path, content)
    else await this.writeJson(path, content)
  }

  private roundPath(round: number): string {
    return join('rounds', String(round))
  }

  private jobPath(job: EvaluationJobId): string {
    if (!JOB_NAME.test(job)) throw new Error(`self-improve job id ${JSON.stringify(job)} is not a file name`)
    return join('jobs', `${job}.json`)
  }

  private async readText(path: string): Promise<string | undefined> {
    try {
      return await readFile(join(this.root, path), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return undefined
      throw error
    }
  }

  private async readJson(path: string): Promise<unknown> {
    const text = await this.readText(path)
    if (text === undefined) return undefined
    try {
      const value: unknown = JSON.parse(text)
      return value
    } catch (error) {
      throw new Error(`${join(this.root, path)} is not JSON`, { cause: error })
    }
  }

  private async writeText(path: string, content: string): Promise<void> {
    await writeFileAtomic(join(this.root, path), content, PRIVATE_FILE)
  }

  private async writeJson(path: string, value: unknown): Promise<void> {
    await this.writeText(path, `${JSON.stringify(value, undefined, 1)}\n`)
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNumberArray(value: unknown): value is readonly number[] {
  return Array.isArray(value) && value.every(item => typeof item === 'number' && Number.isFinite(item))
}

function isRevision(value: unknown): value is {
  readonly commit: string
  readonly job: string
  readonly score: number
  readonly cost: number | null
  readonly variant?: string
} {
  return isRecord(value)
    && typeof value['commit'] === 'string'
    && typeof value['job'] === 'string'
    && typeof value['score'] === 'number'
    && (value['cost'] === null || typeof value['cost'] === 'number')
    && (value['variant'] === undefined || typeof value['variant'] === 'string')
}

function evaluationOf(value: unknown, job: EvaluationJobId): EvaluationResult | undefined {
  if (!isRecord(value) || value['job'] !== job || !Number.isInteger(value['trials'])) return undefined
  const perTask = value['perTask']
  const measures = value['measures']
  if (!isRecord(perTask) || !isRecord(measures)) return undefined
  if (!Object.values(measures).every(measure => typeof measure === 'number')) return undefined
  const results = new Map<TaskId, TaskResult>()
  for (const [task, entry] of Object.entries(perTask)) {
    const result = taskResultOf(entry)
    if (result === undefined) return undefined
    results.set(TaskId(task), result)
  }
  return aggregate(job, value['trials'] as number, results, measures as Readonly<Record<string, number>>)
}

function taskResultOf(value: unknown): TaskResult | undefined {
  if (!isRecord(value)) return undefined
  const { rewards, weights, tokens, missing } = value
  if (!isNumberArray(rewards) || !isNumberArray(weights) || weights.length !== rewards.length) return undefined
  if (!Array.isArray(tokens) || tokens.length !== rewards.length) return undefined
  if (!tokens.every(item => item === null || typeof item === 'number')) return undefined
  if (!Number.isInteger(missing)) return undefined
  return {
    rewards,
    weights,
    tokens: tokens.map(item => (item === null ? undefined : item as number)),
    missing: missing as number,
  }
}

function isCalibration(value: unknown): value is Calibration {
  if (!isRecord(value) || typeof value['delta'] !== 'number' || !isNumberArray(value['scores'])) return false
  if (value['method'] === 'spread') return true
  return value['method'] === 'z'
    && typeof value['z'] === 'number'
    && typeof value['deviation'] === 'number'
    && (value['estimate'] === 'repeated' || value['estimate'] === 'bootstrap')
    && typeof value['bootstrapDeviation'] === 'number'
}

function isEdit(value: unknown): value is CandidateEdit {
  return isRecord(value)
    && typeof value['id'] === 'string'
    && typeof value['component'] === 'string'
    && typeof value['hypothesis'] === 'string'
}

function isCandidateRecord(value: unknown, variant: string): value is CandidateRecord {
  if (!isRecord(value) || value['variant'] !== variant) return false
  if (!Array.isArray(value['edits']) || !value['edits'].every(isEdit)) return false
  if (value['status'] === 'ready') {
    return typeof value['commit'] === 'string' && typeof value['branch'] === 'string' && typeof value['summary'] === 'string'
  }
  return value['status'] === 'gated'
    && typeof value['outcome'] === 'string'
    && GATE_OUTCOMES.has(value['outcome'])
    && typeof value['detail'] === 'string'
}
