/**
 * The automatic pipeline: one background job that measures the baseline,
 * calibrates the noise band, runs every remaining round, measures the
 * held-out tasks, applies the result, and writes a plain-language summary.
 * Each stage reads the run's stored state first and is skipped when already
 * done, so a job interrupted by a crash or a restart resumes where it
 * stopped; a round resumes from its own stored drafts and evaluations.
 *
 * The automatic run is a sequence of generations in one repository. The
 * first generation's spec is `run.json`; once a generation finished, the
 * next pipeline writes `run-<n>.json`, a copy of `run.json` named
 * `<name>-<n>` whose evolve branch starts from the previous generation's
 * branch, so each generation measures and improves the previous one's
 * result. A generation is finished once its record, `auto.json` in its run
 * directory, exists.
 *
 * @module @deepseek-ai/dsh-experimental-self-improve/auto
 */

import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

import { applyEvolved } from './apply.ts'
import type { ApplyResult, LiveConfiguration } from './apply.ts'
import { RUN_SPEC_FILE } from './bootstrap.ts'
import type { OpenedRun } from './command.ts'
import type { Revision, Trajectory } from './directory.ts'
import type { RunDirectory } from './directory.ts'
import { loadSuite } from './suite.ts'

/** One generation of the automatic run. */
export interface Generation {
  /** 1 for `run.json`, n for `run-<n>.json`. */
  readonly index: number
  /** Absolute path of the generation's spec. */
  readonly spec: string
}

/** A finished generation's record. */
export interface AutoRecord {
  readonly completedAt: string
  /** The summary the pipeline returned. */
  readonly summary: string
  /** One line saying whether and where the result was applied. */
  readonly applied: string
}

/** What the pipeline does with an accepted result. */
export type AutoApply =
  | { readonly enabled: false }
  | { readonly enabled: true; readonly live: LiveConfiguration; readonly now: () => Date }

/** One pipeline job. */
export interface PipelineOptions {
  readonly opened: OpenedRun
  /** Extra baseline measurements of the calibration. */
  readonly calibrationRepeats: number
  readonly apply: AutoApply
  /** Receives one line per stage. */
  readonly log: (line: string) => void
  readonly signal: AbortSignal
}

const RECORD_FILE = 'auto.json'
const GENERATION_SPEC = /^run-(\d+)\.json$/

/**
 * The generations of the automatic run, oldest first.
 * @param repository - absolute root of the automatic run's repository.
 * @returns `run.json` as generation 1, then each `run-<n>.json` with n of 2 or more.
 */
export async function generations(repository: string): Promise<readonly [Generation, ...Generation[]]> {
  const later = (await readdir(repository))
    .map(name => ({ name, index: Number(GENERATION_SPEC.exec(name)?.[1] ?? 0) }))
    .filter(entry => entry.index >= 2)
    .sort((left, right) => left.index - right.index)
    .map(entry => ({ index: entry.index, spec: join(repository, entry.name) }))
  return [{ index: 1, spec: join(repository, RUN_SPEC_FILE) }, ...later]
}

/**
 * Write the spec of the generation after `previous`: `run.json` renamed to `<name>-<n>`, whose evolve branch starts
 * from the previous generation's evolve branch.
 * @param repository - absolute root of the automatic run's repository.
 * @param previous - the finished generation.
 * @param previousBranch - the previous generation's evolve branch.
 * @returns the new generation.
 * @throws Error when `run.json` is not a JSON object with a name, or when the new spec already exists.
 */
export async function nextGeneration(repository: string, previous: Generation, previousBranch: string): Promise<Generation> {
  const path = join(repository, RUN_SPEC_FILE)
  const first = parseJson(await readFile(path, 'utf8'), path)
  const name = isRecord(first) ? first['name'] : undefined
  if (!isRecord(first) || typeof name !== 'string') throw new Error(`self-improve ${path} is not a run spec with a name`)
  const index = previous.index + 1
  const branch = first['branch']
  const next = {
    ...first,
    name: `${name}-${index}`,
    startPoint: previousBranch,
    ...typeof branch === 'string' ? { branch: `${branch}-${index}` } : {},
  }
  const spec = join(repository, `run-${index}.json`)
  await writeFile(spec, `${JSON.stringify(next, undefined, 2)}\n`, { flag: 'wx', mode: 0o600 })
  return { index, spec }
}

/**
 * Read a generation's record.
 * @param directory - the generation's run directory.
 * @returns the record, or `undefined` while the generation is unfinished.
 * @throws Error when the file is not a valid record.
 */
export async function readAutoRecord(directory: RunDirectory): Promise<AutoRecord | undefined> {
  const path = join(directory.root, RECORD_FILE)
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const value = parseJson(text, path)
  const field = (key: keyof AutoRecord): unknown => (isRecord(value) ? value[key] : undefined)
  const completedAt = field('completedAt')
  const summary = field('summary')
  const applied = field('applied')
  if (typeof completedAt !== 'string' || typeof summary !== 'string' || typeof applied !== 'string') {
    throw new Error(`${path} is not a self-improve automatic run record`)
  }
  return { completedAt, summary, applied }
}

/**
 * The newest accepted revision of a run's trajectory.
 * @param opened - the run.
 * @returns the revision, or `undefined` when the incumbent is still the baseline.
 */
export async function latestAccepted(opened: OpenedRun): Promise<Revision | undefined> {
  const trajectory = await opened.directory.readTrajectory()
  if (trajectory === undefined) return undefined
  const final = latest(trajectory)
  return final.commit === trajectory[0].commit ? undefined : final
}

/**
 * Write one revision's evolved directory into the live configuration.
 * @param opened - the run holding the revision.
 * @param commit - the revision.
 * @param live - where the apply writes.
 * @param now - the backup's time.
 * @param signal - cancellation of the checkout's git commands.
 * @returns the apply's outcome.
 * @throws Error when the apply is refused or a git command fails.
 */
export async function applyRevision(
  opened: OpenedRun,
  commit: string,
  live: LiveConfiguration,
  now: Date,
  signal?: AbortSignal,
): Promise<ApplyResult> {
  const checkout = await opened.store.create('apply', commit, signal)
  try {
    return await applyEvolved({ evolved: checkout.evolvedDirectory, description: `run ${opened.spec.name} at ${commit}` }, live, now)
  } finally {
    await opened.store.release('apply', signal)
  }
}

/**
 * Run every stage the run has not finished, apply the result, and record the summary.
 * @param options - the run, the calibration repeats, the apply settings, the log, and cancellation.
 * @returns the summary.
 * @throws Error when a measurement fails; an apply that fails is reported in the summary instead.
 */
export async function runPipeline(options: PipelineOptions): Promise<string> {
  const { opened, log, signal } = options
  const { run, spec, directory } = opened
  const measured = (await run.status()).trajectory.length > 0
  log(`stage 1/5, baseline: ${measured ? 'already measured' : 'measuring'}`)
  if (!measured) await run.baseline(signal)
  const calibrated = await directory.readCalibration() !== undefined
  const roundsDone = (await run.status()).trajectory.length - 1
  if (spec.calibration !== undefined && !calibrated && roundsDone === 0) {
    log(`stage 2/5, noise band: measuring the baseline ${options.calibrationRepeats} more time(s)`)
    await run.calibrate(options.calibrationRepeats, spec.calibration, signal)
  } else {
    log(`stage 2/5, noise band: ${calibrated ? 'already calibrated' : 'fixed by the spec'}`)
  }
  log(`stage 3/5, rounds: ${roundsDone} of ${spec.settings.rounds} done`)
  for (let status = await run.status(); status.nextRound !== undefined; status = await run.status()) {
    const outcome = await run.round(signal)
    log(`round ${outcome.round + 1} of ${spec.settings.rounds}: ${outcome.winner === undefined ? 'no admissible candidate' : `accepted candidate ${outcome.winner}`}, score ${outcome.incumbent.score.toFixed(4)}`)
  }
  const trajectory = await directory.readTrajectory()
  /* v8 ignore next -- the baseline stage leaves a trajectory or throws */
  if (trajectory === undefined) throw new Error(`self-improve run ${directory.root} has no baseline`)
  const base = trajectory[0]
  const final = latest(trajectory)
  log('stage 4/5, held-out tasks')
  const after = await run.heldout(undefined, signal)
  const before = final.commit === base.commit ? after : await run.heldout(0, signal)
  log('stage 5/5, apply')
  const applied = await applyStage(opened, options.apply, base, final, signal)
  log(applied)
  const summary = await summarize(opened, trajectory, { before: before.score, after: after.score, tasks: after.perTask.size }, applied)
  const record: AutoRecord = { completedAt: new Date().toISOString(), summary, applied }
  await writeFileAtomic(join(directory.root, RECORD_FILE), `${JSON.stringify(record, undefined, 1)}\n`, { mode: 0o600, dirMode: 0o700 })
  return summary
}

/** Apply the final incumbent when it is an accepted candidate; returns the summary's line. */
async function applyStage(opened: OpenedRun, apply: AutoApply, base: Revision, final: Revision, signal: AbortSignal): Promise<string> {
  if (final.commit === base.commit) return 'Not applied: no candidate beat the baseline, so your configuration is unchanged.'
  if (!apply.enabled) return 'Not applied: autoApply is off. Run /self-improve apply to apply it.'
  let result: ApplyResult
  try {
    result = await applyRevision(opened, final.commit, apply.live, apply.now(), signal)
  } catch (error) {
    signal.throwIfAborted()
    // Every failure here is a refusal, a filesystem Error, or a git command's Error.
    return `Not applied: ${(error as Error).message}`
  }
  if (result.status === 'unchanged') return 'Already applied: your configuration holds this result.'
  return `Applied to your dsh configuration: ${result.changed.join(', ')}. New sessions use it. Undo with /self-improve undo, which restores the backup in ${result.backup}.`
}

async function summarize(
  opened: OpenedRun,
  trajectory: Trajectory,
  heldout: { readonly before: number; readonly after: number; readonly tasks: number },
  applied: string,
): Promise<string> {
  const { spec, directory, run } = opened
  const base = trajectory[0]
  const final = latest(trajectory)
  const suite = await loadSuite(spec.suite)
  const practice = [...suite.tasks.values()].filter(task => task.split === 'evolve').length
  const accepted = trajectory.flatMap((entry, index) => (index > 0 && entry.variant !== undefined
    ? [{ round: index - 1, variant: entry.variant }]
    : []))
  const lines = [
    `Self-improvement run ${spec.name} finished ${trajectory.length - 1} round(s) and accepted ${accepted.length} change(s).`,
    `Score on the ${practice} practice task(s): ${base.score.toFixed(3)} before, ${final.score.toFixed(3)} after; differences up to ${(await run.noiseBand()).toFixed(3)} count as noise.`,
    `Score on the ${heldout.tasks} held-out task(s), which the search never sees: ${heldout.before.toFixed(3)} before, ${heldout.after.toFixed(3)} after.`,
  ]
  if (accepted.length === 0) {
    lines.push('What changed: nothing.')
  } else {
    lines.push('What changed:')
    for (const { round, variant } of accepted) {
      const candidate = await directory.readCandidate(round, variant)
      const detail = candidate?.status === 'ready'
        ? `${candidate.summary} (${candidate.edits.map(edit => `${edit.component}: ${edit.hypothesis}`).join('; ')})`
        : 'its candidate record is missing'
      lines.push(`- Round ${round + 1}, candidate ${variant}: ${detail}`)
    }
    const prefix = `${spec.evolvedDirectory}/`
    const files = (await opened.git(['diff', '--numstat', base.commit, final.commit, '--', spec.evolvedDirectory]))
      .trim().split('\n')
      .map(line => line.replace(/^(\S+)\t(\S+)\t(.*)$/, (_line, added: string, removed: string, path: string) => `${path.slice(prefix.length)} (+${added} -${removed})`))
    lines.push(`- Files in ${prefix}: ${files.join(', ')}`)
  }
  lines.push(applied)
  return lines.join('\n')
}

/** The newest incumbent of a trajectory. */
function latest(trajectory: Trajectory): Revision {
  return trajectory.reduce((_previous, entry) => entry)
}

function parseJson(text: string, path: string): unknown {
  try {
    const value: unknown = JSON.parse(text)
    return value
  } catch (error) {
    throw new Error(`${path} is not JSON`, { cause: error })
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
