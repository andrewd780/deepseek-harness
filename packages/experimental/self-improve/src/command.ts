/**
 * The `/self-improve` command: measure a run spec's baseline, calibrate its
 * noise band, run its rounds, or measure held-out tasks as a background job
 * owned by the invoking agent, or report where a run stands.
 *
 * ```text
 * /self-improve status <spec.json>
 * /self-improve baseline <spec.json>
 * /self-improve calibrate <spec.json> [repeats=2]
 * /self-improve round <spec.json> [count=1]
 * /self-improve run <spec.json>
 * /self-improve heldout <spec.json> [trajectory index]
 * ```
 *
 * The command line never reaches a model. The job's roles and trials call
 * models, and its completion reaches the owner agent like any background job.
 *
 * @module @deepseek-ai/dsh-experimental-self-improve/command
 */

import { mkdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import type { JobHandle, JobOutcome, JobSpec } from '@deepseek-ai/dsh-jobs'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-working-directory'

import { createCritic } from './critic.ts'
import { RunDirectory } from './directory.ts'
import { SuiteDomain } from './domain.ts'
import { GitRevisionStore, repositoryRoot } from './git.ts'
import { SelfImproveRun } from './loop.ts'
import { createLlmTextModel } from './model.ts'
import { subprocessRunner } from './process.ts'
import { createAnalyst, createProposer } from './roles.ts'
import { loadRunSpec } from './spec.ts'
import type { RunSpec } from './spec.ts'
import { loadSuite } from './suite.ts'
import { DSH_CRITIC_PATTERNS, DSH_OVERLAY_RULES, EVOLVED_FILE_EXTENSIONS, DSH_COMPONENTS, taskNamePatterns } from './evolved-directory.ts'

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    'self-improve': 'self-improve'
  }
}

/** The plugin configuration with every default filled. */
export interface CommandSettings {
  /** Run directories, relative to the repository root. */
  readonly runsDirectory: string
  /** Absolute parent of each trial's disposable workspace and homes; empty uses the operating system's temporary directory. */
  readonly scratchDirectory: string
  /** Deadline of one git command. */
  readonly gitTimeoutMs: number
  /** Time between a process's termination request and its forced kill. */
  readonly processGraceMs: number
  /** Bytes kept of each process output stream. */
  readonly maxOutputBytes: number
}

/** A run composed from its spec. */
export interface OpenedRun {
  readonly spec: RunSpec
  readonly run: SelfImproveRun
}

const ACTIONS = new Set(['status', 'baseline', 'calibrate', 'round', 'run', 'heldout'])
const USAGE = 'usage: /self-improve <status|baseline|calibrate|round|run|heldout> <spec.json> [number]'
const JOBS_MISSING = 'self-improve needs background jobs: load @deepseek-ai/dsh-jobs-local and @deepseek-ai/dsh-tool-jobs'

/** A job this plugin started and has not seen settle. */
interface ActiveJob {
  readonly controller: AbortController
  readonly done: Promise<JobOutcome>
}

/**
 * Register `/self-improve` for the plugin's lifetime; disposal aborts the jobs it started and waits for them.
 * @param ctx - a context injecting `commands`, `llm`, `subprocess`, and `workingDirectory`.
 * @param settings - the resolved plugin configuration.
 */
export function registerSelfImproveCommand(ctx: Context, settings: CommandSettings): void {
  const active = new Set<ActiveJob>()
  ctx.effect(function* () {
    yield async () => {
      for (const job of active) job.controller.abort(new Error('self-improve plugin disposed'))
      await Promise.allSettled([...active].map(async job => await job.done))
    }
    yield ctx.commands.register({
      definitionId: CommandDefinitionId('@deepseek-ai/dsh-experimental-self-improve'),
      name: 'self-improve',
      description: 'Improve the harness configuration of a run spec by measured search',
      handler: async invocation => await handle(ctx, settings, invocation, active),
    })
  }, 'self-improve command lifecycle')
}

async function handle(
  ctx: Context,
  config: CommandSettings,
  invocation: CommandInvocation,
  active: Set<ActiveJob>,
): Promise<CommandResult> {
  const [action = '', specArgument = '', count, ...rest] = invocation.rawInput.trim().split(/\s+/)
  const number = count === undefined ? undefined : Number(count)
  const malformedNumber = number !== undefined && !(Number.isInteger(number) && number >= 0)
  if (!ACTIONS.has(action) || specArgument.length === 0 || rest.length > 0 || malformedNumber) return { kind: 'error', text: USAGE }
  const narration = new Narration()
  let opened: OpenedRun
  try {
    const cwd = await ctx.workingDirectory.ensure(invocation.agent, invocation.signal)
    opened = await openRun(ctx, config, resolve(cwd, specArgument), (line) => {
      narration.write(line)
    }, invocation.signal)
  } catch (error) {
    return { kind: 'error', text: messageOf(error) }
  }
  if (action === 'status') return { kind: 'success', text: await statusText(opened) }
  const jobs = ctx.get('jobs')
  if (jobs === undefined) return { kind: 'error', text: JOBS_MISSING }
  let jobId: string
  try {
    jobId = jobs.start(jobSpec(opened, action, number, invocation.agent.id, narration, active))
  } catch (error) {
    return { kind: 'error', text: messageOf(error) }
  }
  return { kind: 'success', text: `started job ${jobId}: self-improve ${action} ${opened.spec.name}` }
}

/** A run's log lines: kept until its job starts, then appended to the job's output. */
class Narration {
  private readonly pending: string[] = []
  private job: JobHandle | undefined

  write(line: string): void {
    if (this.job === undefined) this.pending.push(line)
    else this.job.append(`${line}\n`)
  }

  attach(job: JobHandle): void {
    this.job = job
    for (const line of this.pending.splice(0)) job.append(`${line}\n`)
  }
}

function jobSpec(
  opened: OpenedRun,
  action: string,
  number: number | undefined,
  owner: SessionId,
  narration: Narration,
  active: Set<ActiveJob>,
): JobSpec {
  return {
    kind: 'self-improve',
    label: `self-improve ${action} ${opened.spec.name}`,
    owner,
    run: (job) => {
      narration.attach(job)
      const controller = new AbortController()
      const done = (async (): Promise<JobOutcome> => {
        try {
          return { status: 'completed', result: await perform(opened.run, opened.spec, action, number, controller.signal) }
        } catch (error) {
          return { status: controller.signal.aborted ? 'killed' : 'failed', detail: messageOf(error) }
        }
      })()
      const entry = { controller, done }
      active.add(entry)
      void done.finally(() => {
        active.delete(entry)
      })
      return {
        cancel: (reason?: string) => {
          controller.abort(new Error(reason ?? 'self-improve job killed'))
        },
        done,
      }
    },
  }
}

/**
 * Compose a run from its spec: the suite domain, the git revision store, the model roles, and the run directory.
 * @param ctx - a context injecting `llm` and `subprocess`.
 * @param config - the resolved plugin configuration.
 * @param specPath - absolute path of the run spec.
 * @param log - receives one line per stage of the run.
 * @param signal - cancellation of the composition's git commands.
 * @returns the run and its spec.
 * @throws Error for an invalid spec or suite, an unset forwarded variable, or an evolved directory inside the runs directory.
 */
export async function openRun(
  ctx: Context,
  config: CommandSettings,
  specPath: string,
  log: (line: string) => void,
  signal?: AbortSignal,
): Promise<OpenedRun> {
  const spec = await loadRunSpec(specPath)
  const suite = await loadSuite(spec.suite)
  const runner = subprocessRunner(ctx, { maxOutputBytes: config.maxOutputBytes, graceMs: config.processGraceMs })
  const repository = await repositoryRoot(runner, spec.repository, config.gitTimeoutMs, signal)
  const runsDirectory = resolve(repository, config.runsDirectory)
  const evolved = resolve(repository, spec.evolvedDirectory)
  if (evolved === runsDirectory || evolved.startsWith(`${runsDirectory}${sep}`)) {
    throw new Error(`self-improve evolved directory ${spec.evolvedDirectory} lies inside the runs directory ${config.runsDirectory}, which git ignores`)
  }
  const environment: Record<string, string> = { ...spec.trial.env }
  for (const variable of spec.trial.forwardEnv) {
    const value = process.env[variable]
    if (value === undefined) throw new Error(`self-improve run spec forwards ${variable}, which is not set`)
    environment[variable] = value
  }
  await mkdir(runsDirectory, { recursive: true, mode: 0o700 })
  const ignore = join(runsDirectory, '.gitignore')
  if (!await stat(ignore).then(() => true, () => false)) await writeFile(ignore, '*\n', { mode: 0o600 })
  const runRoot = join(runsDirectory, spec.name)
  const model = createLlmTextModel(ctx, {
    provider: spec.roles.provider,
    model: spec.roles.model,
    maxOutputTokens: spec.roles.maxOutputTokens,
    timeoutMs: spec.roles.timeoutMs,
  })
  const domain = new SuiteDomain({
    suite,
    componentSet: DSH_COMPONENTS,
    overlayRules: DSH_OVERLAY_RULES,
    runRoot,
    evolvedDirectory: spec.evolvedDirectory,
    scratch: config.scratchDirectory.length > 0 ? config.scratchDirectory : join(tmpdir(), 'dsh-self-improve'),
    profile: spec.trial.profile,
    policyPatches: spec.trial.policyPatches,
    provider: spec.trial.provider,
    model: spec.trial.model,
    environment: () => environment,
    trialTimeoutMs: spec.trial.timeoutMs,
    shutdownTimeoutMs: spec.trial.shutdownTimeoutMs,
    concurrency: spec.trial.concurrency,
    runCommand: async (argv, cwd, timeoutMs, commandSignal) => {
      const result = await runner({ argv, cwd, timeoutMs, signal: commandSignal })
      return result.exitCode === 0
    },
    maxTraceCharacters: spec.trial.maxTraceCharacters,
    maxPromptGrowth: spec.trial.maxPromptGrowth,
  })
  const run = new SelfImproveRun({
    domain,
    store: new GitRevisionStore({
      repository,
      branch: spec.branch,
      startPoint: spec.startPoint,
      checkouts: join(runRoot, 'checkouts'),
      evolvedDirectory: relative(repository, evolved),
      run: runner,
      timeoutMs: config.gitTimeoutMs,
    }),
    analyst: createAnalyst(model),
    proposer: createProposer({
      model,
      maxTurns: spec.roles.proposerTurns,
      maxReadCharacters: spec.roles.maxReadCharacters,
      writableExtensions: EVOLVED_FILE_EXTENSIONS,
    }),
    critic: createCritic({
      model,
      brief: suite.briefs.critic,
      patterns: [...DSH_CRITIC_PATTERNS, ...suite.criticPatterns, ...taskNamePatterns([...suite.tasks.keys()])],
      attempts: spec.roles.criticAttempts,
      maxDiffCharacters: spec.roles.maxDiffCharacters,
    }),
    directory: new RunDirectory(runRoot),
    log,
  }, spec.settings)
  log(`run ${spec.name}: evolved directory ${spec.evolvedDirectory} of ${repository}, evolve branch ${spec.branch}`)
  return { spec, run }
}

async function perform(
  run: SelfImproveRun,
  spec: RunSpec,
  action: string,
  number: number | undefined,
  signal: AbortSignal,
): Promise<string> {
  switch (action) {
    case 'baseline': {
      const revision = await run.baseline(signal)
      return `baseline ${revision.commit}: score ${revision.score.toFixed(4)}`
    }
    case 'calibrate': {
      const calibration = await run.calibrate(number ?? 2, spec.calibration, signal)
      return `noise band ${calibration.delta.toFixed(5)} (${calibration.method}, scores ${calibration.scores.map(score => score.toFixed(4)).join(', ')})`
    }
    case 'heldout': {
      const evaluation = await run.heldout(number, signal)
      return `held-out score ${evaluation.score.toFixed(4)} over ${evaluation.perTask.size} task(s)`
    }
    default: {
      const outcomes: string[] = []
      const limit = action === 'round' ? number ?? 1 : Number.POSITIVE_INFINITY
      let status = await run.status()
      // Before the baseline, the round itself reports what is missing.
      if (status.trajectory.length === 0) await run.round(signal)
      while (outcomes.length < limit && status.nextRound !== undefined) {
        const outcome = await run.round(signal)
        outcomes.push(`round ${outcome.round}: ${outcome.winner === undefined ? 'no admissible candidate' : `accepted ${outcome.winner}`}, score ${outcome.incumbent.score.toFixed(4)}`)
        status = await run.status()
      }
      return outcomes.length === 0 ? 'the run has no round left' : outcomes.join('\n')
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function statusText({ spec, run }: OpenedRun): Promise<string> {
  const status = await run.status()
  if (status.trajectory.length === 0) return `${spec.name}: no baseline yet`
  const lines = status.trajectory.map((revision, index) =>
    `H${index}: score ${revision.score.toFixed(4)}, cost ${revision.cost?.toFixed(0) ?? 'not reported'}, ${revision.commit}${revision.variant === undefined ? '' : ` (${revision.variant})`}`)
  return [`${spec.name}: next round ${status.nextRound ?? 'none (complete)'}`, ...lines].join('\n')
}
