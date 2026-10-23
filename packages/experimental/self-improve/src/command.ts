/**
 * The `/self-improve` command. Without arguments it creates the automatic
 * run when none exists and runs its whole pipeline as one background job;
 * it also applies a result to the live configuration, undoes the newest
 * apply, keeps the daily schedule, and reports where runs stand. With a run
 * spec of the operator's own, it measures the baseline, calibrates the noise
 * band, runs rounds, or measures held-out tasks as background jobs.
 *
 * ```text
 * /self-improve [auto]
 * /self-improve status
 * /self-improve apply [spec.json]
 * /self-improve undo
 * /self-improve schedule [on [HH:MM] | off | status]
 * /self-improve help
 * /self-improve status <spec.json>
 * /self-improve baseline <spec.json>
 * /self-improve calibrate <spec.json> [repeats=2]
 * /self-improve round <spec.json> [count=1]
 * /self-improve run <spec.json>
 * /self-improve heldout <spec.json> [trajectory index]
 * ```
 *
 * The command line never reaches a model. A job's roles and trials call
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
import { expandHomePath, resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { JobHandle, JobOutcome, JobRegistry } from '@deepseek-ai/dsh-jobs'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-working-directory'

import { undoLatestApply } from './apply.ts'
import type { ApplyResult, LiveConfiguration } from './apply.ts'
import { applyRevision, generations, latestAccepted, nextGeneration, readAutoRecord, runPipeline } from './auto.ts'
import type { Generation } from './auto.ts'
import { AutoScheduler, isScheduleTime, startScheduleTimer, vmStatMemory } from './auto-schedule.ts'
import type { ScheduleSettings } from './auto-schedule.ts'
import { ensureStarterRun, RUN_SPEC_FILE } from './bootstrap.ts'
import { EvaluationJobId } from './brand.ts'
import { createCritic } from './critic.ts'
import { RunDirectory } from './directory.ts'
import type { Revision } from './directory.ts'
import { SuiteDomain } from './domain.ts'
import { GitRevisionStore, repositoryRoot, runGit } from './git.ts'
import { SelfImproveRun } from './loop.ts'
import { createLlmTextModel } from './model.ts'
import { subprocessRunner } from './process.ts'
import type { ProcessRunner } from './process.ts'
import { createAnalyst, createProposer } from './roles.ts'
import { loadRunSpec } from './spec.ts'
import type { RunSpec } from './spec.ts'
import { loadSuite } from './suite.ts'
import { STARTER_TASKS } from './template.ts'
import { DSH_CRITIC_PATTERNS, DSH_OVERLAY_RULES, EVOLVED_FILE_EXTENSIONS, DSH_COMPONENTS, taskNamePatterns } from './evolved-directory.ts'

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    'self-improve': 'self-improve'
  }
}

/** The automatic run's location, route, and calibration. */
export interface AutoSettings {
  /** The automatic run's repository; empty is `<home>/self-improve/auto`. */
  readonly directory: string
  /** Provider key of the trials' and the search roles' route, written into a new run. */
  readonly provider: string
  readonly model: string
  /** OpenAI-compatible base URL a new run's trials route to. */
  readonly baseUrl: string
  /** Context window a new run's trial route declares. */
  readonly contextWindow: number
  /** Rounds of each generation, written into a new run. */
  readonly rounds: number
  /** Extra baseline measurements the noise band's calibration takes. */
  readonly calibrationRepeats: number
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
  /** Whether the automatic pipeline applies an accepted result to the live configuration. */
  readonly autoApply: boolean
  readonly auto: AutoSettings
  readonly schedule: ScheduleSettings
  /** The Harness home applies write into and the plugin keeps its state under; empty is the running profile's home. */
  readonly home: string
  /** The profile patch applies add overlay entries to; empty is the running profile's `cordis.patch.yml`. */
  readonly profilePatch: string
}

/** A run composed from its spec. */
export interface OpenedRun {
  readonly spec: RunSpec
  readonly run: SelfImproveRun
  readonly directory: RunDirectory
  readonly store: GitRevisionStore
  /**
   * Run one git command in the run's repository.
   * @param args - git's arguments.
   * @param signal - cancellation.
   * @returns the command's standard output.
   */
  readonly git: (args: readonly string[], signal?: AbortSignal) => Promise<string>
}

/** Test seams for the schedule's clock and memory reader. */
export const internals: { now(): Date; memory(run: ProcessRunner): Promise<number> } = {
  now: () => new Date(),
  memory: async run => await vmStatMemory(run, VM_STAT_TIMEOUT_MS),
}

const VM_STAT_TIMEOUT_MS = 10_000
const RUN_ACTIONS = new Set(['baseline', 'calibrate', 'round', 'run', 'heldout'])
const JOBS_MISSING = 'self-improve needs background jobs: load @deepseek-ai/dsh-jobs-local and @deepseek-ai/dsh-tool-jobs'

/** Every form of the command. */
export const HELP = [
  '/self-improve                      create the automatic run when none exists, then run its whole pipeline in the background',
  '/self-improve status               where the automatic run stands, its last summary, and the schedule',
  '/self-improve apply                apply the newest accepted result of the automatic run to your dsh configuration',
  '/self-improve undo                 restore the configuration the newest apply replaced',
  '/self-improve schedule on [HH:MM]  run the automatic pipeline daily; this session owns the scheduled jobs',
  '/self-improve schedule off         stop scheduled runs',
  '/self-improve schedule status      the schedule, its checks, and the last due check',
  '/self-improve help                 this text',
  'With a run spec of your own:',
  '/self-improve status <spec.json>',
  '/self-improve baseline <spec.json>',
  '/self-improve calibrate <spec.json> [repeats=2]',
  '/self-improve round <spec.json> [count=1]',
  '/self-improve run <spec.json>',
  '/self-improve heldout <spec.json> [trajectory index]',
  '/self-improve apply <spec.json>',
].join('\n')

/** A job this plugin started and has not seen settle. */
interface ActiveJob {
  readonly id: string
  readonly label: string
  /** Whether the job runs the automatic pipeline. */
  readonly auto: boolean
  readonly startedAt: Date
  readonly controller: AbortController
  readonly done: Promise<JobOutcome>
}

/** A started automatic job. */
interface AutoStart {
  readonly job: string
  /** Whether the job's run was created for it. */
  readonly created: boolean
  /** Whether the job starts a generation after a finished one. */
  readonly advanced: boolean
  readonly generation: Generation
  readonly opened: OpenedRun
}

/**
 * Register `/self-improve` and the schedule's timer for the plugin's lifetime; disposal aborts the jobs it started
 * and waits for them.
 * @param ctx - a context injecting `commands`, `llm`, `subprocess`, and `workingDirectory`.
 * @param settings - the resolved plugin configuration.
 */
export function registerSelfImproveCommand(ctx: Context, settings: CommandSettings): void {
  const plugin = new SelfImprove(ctx, settings)
  ctx.effect(function* () {
    yield async () => {
      await plugin.dispose()
    }
    yield ctx.commands.register({
      definitionId: CommandDefinitionId('@deepseek-ai/dsh-experimental-self-improve'),
      name: 'self-improve',
      description: 'Improve the harness configuration by measured search; without arguments, run the automatic mode',
      handler: async invocation => await plugin.handle(invocation),
    })
    yield startScheduleTimer(plugin.scheduler, settings.schedule)
  }, 'self-improve command lifecycle')
}

/** The command's state: the jobs it started, where it applies results, and the schedule. */
class SelfImprove {
  readonly scheduler: AutoScheduler
  private readonly active = new Set<ActiveJob>()
  private readonly runner: ProcessRunner
  private readonly live: LiveConfiguration
  private readonly autoDirectory: string

  constructor(private readonly ctx: Context, private readonly settings: CommandSettings) {
    this.runner = subprocessRunner(ctx, { maxOutputBytes: settings.maxOutputBytes, graceMs: settings.processGraceMs })
    const profile: unknown = ctx.get('profileContext')
    const launched = isRecord(profile) && typeof profile['home'] === 'string' && typeof profile['patchPath'] === 'string'
      ? { home: profile['home'], patchPath: profile['patchPath'] }
      : undefined
    const home = settings.home !== '' ? resolveDshHome(settings.home) : launched?.home ?? resolveDshHome()
    const state = join(home, 'self-improve')
    this.live = {
      home,
      profilePatch: settings.profilePatch !== '' ? resolve(expandHomePath(settings.profilePatch)) : launched?.patchPath ?? join(home, 'cordis.patch.yml'),
      backups: join(state, 'backups'),
    }
    this.autoDirectory = settings.auto.directory !== '' ? resolve(expandHomePath(settings.auto.directory)) : join(state, 'auto')
    this.scheduler = new AutoScheduler({
      settings: settings.schedule,
      statePath: join(state, 'schedule.json'),
      now: () => internals.now(),
      memory: async () => await internals.memory(this.runner),
      activeJob: () => {
        const [job] = this.active
        return job === undefined ? undefined : `job ${job.id} (${job.label})`
      },
      start: async owner => (await this.startAuto(owner)).job,
    })
  }

  async dispose(): Promise<void> {
    for (const job of this.active) job.controller.abort(new Error('self-improve plugin disposed'))
    await Promise.allSettled([...this.active].map(async job => await job.done))
  }

  async handle(invocation: CommandInvocation): Promise<CommandResult> {
    const [action = 'auto', ...args] = invocation.rawInput.trim().split(/\s+/).filter(word => word.length > 0)
    let reply: CommandResult
    try {
      reply = await this.dispatch(action, args, invocation)
    } catch (error) {
      return { kind: 'error', text: messageOf(error) }
    }
    const note = await this.scheduler.claim(invocation.agent.id).then(
      claimed => (claimed ? 'This session now owns scheduled runs.' : undefined),
      (error: unknown) => `The schedule could not record an owner: ${messageOf(error)}`,
    )
    return note === undefined ? reply : { ...reply, text: `${reply.text}\n${note}` }
  }

  private async dispatch(action: string, args: readonly string[], invocation: CommandInvocation): Promise<CommandResult> {
    const signal = invocation.signal
    const takes = (count: number): void => {
      if (args.length > count) throw new Error(`/self-improve ${action} takes ${count === 0 ? 'no arguments' : `at most ${count} argument`}; got ${args.join(' ')}\n\n${HELP}`)
    }
    switch (action) {
      case 'auto':
        takes(0)
        return await this.auto(invocation)
      case 'help':
        return { kind: 'success', text: HELP }
      case 'status':
        takes(1)
        return { kind: 'success', text: args[0] === undefined ? await this.autoStatus() : await specStatus(await this.openSpec(invocation, args[0])) }
      case 'apply':
        takes(1)
        return { kind: 'success', text: args[0] === undefined ? await this.applyAuto(signal) : await this.applyOpened(await this.openSpec(invocation, args[0]), signal) }
      case 'undo':
        takes(0)
        return { kind: 'success', text: await this.undo() }
      case 'schedule':
        return { kind: 'success', text: await this.schedule(args, invocation) }
      default:
        if (!RUN_ACTIONS.has(action)) throw new Error(`/self-improve has no action "${action}"\n\n${HELP}`)
        return await this.runAction(action, args, invocation)
    }
  }

  /** `baseline`, `calibrate`, `round`, `run`, or `heldout` on an operator's spec. */
  private async runAction(action: string, args: readonly string[], invocation: CommandInvocation): Promise<CommandResult> {
    const [spec, count, ...rest] = args
    const number = count === undefined ? undefined : Number(count)
    if (spec === undefined || rest.length > 0 || (number !== undefined && !(Number.isInteger(number) && number >= 0))) {
      throw new Error(`/self-improve ${action} takes a run spec and an optional non-negative whole number\n\n${HELP}`)
    }
    const jobs = this.jobs()
    const narration = new Narration()
    const opened = await this.openSpec(invocation, spec, (line) =>{  narration.write(line) })
    const job = this.start(jobs, {
      label: `self-improve ${action} ${opened.spec.name}`,
      owner: invocation.agent.id,
      auto: false,
      narration,
      work: async signal => await perform(opened.run, opened.spec, action, number, signal),
    })
    return { kind: 'success', text: `started job ${job}: self-improve ${action} ${opened.spec.name}` }
  }

  private async auto(invocation: CommandInvocation): Promise<CommandResult> {
    const running = [...this.active].find(job => job.auto)
    if (running !== undefined) {
      return {
        kind: 'success',
        text: `The automatic run is already running as job ${running.id}, started ${clock(running.startedAt)}. Its output narrates each stage, and /self-improve status shows where the run stands.`,
      }
    }
    const started = await this.startAuto(invocation.agent.id, invocation.signal)
    const { spec } = started.opened
    const evolve = STARTER_TASKS.filter(task => task.split === 'evolve').length
    return {
      kind: 'success',
      text: [
        `started job ${started.job}: self-improve auto ${spec.name}`,
        started.created
          ? `Created the automatic run at ${this.autoDirectory}: ${evolve} practice and ${STARTER_TASKS.length - evolve} held-out starter tasks; trials and search roles use ${spec.trial.provider} model ${spec.trial.model}.`
          : started.advanced
            ? `Starting generation ${started.generation.index}, which improves on generation ${started.generation.index - 1}'s result, in ${this.autoDirectory}.`
            : `Continuing generation ${started.generation.index} in ${this.autoDirectory}.`,
        `Stages: baseline, noise band, ${spec.settings.rounds} round(s), held-out tasks, ${this.settings.autoApply ? 'apply to your dsh configuration' : 'no apply (autoApply is off)'}, then a summary. Stages already done are skipped.`,
        'The job\'s output narrates each stage; /self-improve status shows where the run stands.',
      ].join('\n'),
    }
  }

  /** Create the automatic run when needed, pick its generation, and start the pipeline as a job owned by `owner`. */
  private async startAuto(owner: SessionId, signal?: AbortSignal): Promise<AutoStart> {
    const jobs = this.jobs()
    const { auto } = this.settings
    const created = await ensureStarterRun(this.autoDirectory, {
      provider: auto.provider,
      model: auto.model,
      baseUrl: auto.baseUrl,
      contextWindow: auto.contextWindow,
      rounds: auto.rounds,
    }, { run: this.runner, timeoutMs: this.settings.gitTimeoutMs, signal })
    const narration = new Narration()
    let generation = newest(await generations(this.autoDirectory))
    let opened = await this.open(generation.spec, () => {}, signal)
    const advanced = await readAutoRecord(opened.directory) !== undefined
    if (advanced) {
      generation = await nextGeneration(this.autoDirectory, generation, opened.spec.branch)
      opened = await this.open(generation.spec, () => {}, signal)
    }
    await this.checkRoleModel(opened.spec)
    narration.write(`self-improve auto: generation ${generation.index}, run ${opened.spec.name} in ${this.autoDirectory}`)
    const job = this.start(jobs, {
      label: `self-improve auto ${opened.spec.name}`,
      owner,
      auto: true,
      narration,
      work: async jobSignal => await runPipeline({
        opened: await this.open(generation.spec, (line) =>{  narration.write(line) }, jobSignal),
        calibrationRepeats: auto.calibrationRepeats,
        apply: this.settings.autoApply ? { enabled: true, live: this.live, now: () => internals.now() } : { enabled: false },
        log: (line) =>{  narration.write(line) },
        signal: jobSignal,
      }),
    })
    return { job, created: created.created, advanced, generation, opened }
  }

  /** Refuse a search-role route the model runtime lists but without the run's model. */
  private async checkRoleModel(spec: RunSpec): Promise<void> {
    const { provider, model } = spec.roles
    const listed = await this.ctx.llm.listModels(provider).catch((error: unknown) => {
      throw new Error(`self-improve search roles use provider ${provider}, which dsh has no route for (${messageOf(error)}); add the provider to your dsh configuration, or change roles.provider in ${spec.name}'s run spec`)
    })
    if (listed.length > 0 && !listed.some(entry => entry.id === model)) {
      throw new Error(`self-improve search roles use ${provider} model ${model}, which your dsh configuration does not list; add "- id: ${model}" under providers.${provider}.models of the llm-pi-ai entry in your profile's cordis.patch.yml, or change roles.model in the run spec. Listed: ${listed.map(entry => entry.id).join(', ')}`)
    }
  }

  private async autoStatus(): Promise<string> {
    const schedule = await this.scheduler.describe()
    if (!await exists(join(this.autoDirectory, RUN_SPEC_FILE))) {
      return `No automatic run yet: /self-improve creates one at ${this.autoDirectory} and runs it in the background.\n${schedule}`
    }
    const all = await generations(this.autoDirectory)
    const current = newest(all)
    const opened = await this.open(current.spec, () => {})
    const record = await readAutoRecord(opened.directory)
    const { trajectory, nextRound } = await opened.run.status()
    const running = [...this.active].find(job => job.auto)
    const state = running !== undefined
      ? `running as job ${running.id} since ${clock(running.startedAt)}; its output narrates each stage`
      : record !== undefined ? 'finished; /self-improve starts the next generation from its result'
        : trajectory.length === 0 ? 'not started; /self-improve starts it' : 'stopped before it finished; /self-improve resumes it'
    const lines = [`Automatic run in ${this.autoDirectory}, generation ${current.index} (run ${opened.spec.name}): ${state}.`]
    if (trajectory.length > 0) {
      const heldout = await opened.directory.readEvaluation(EvaluationJobId(`heldout-${trajectory.length - 1}`))
      lines.push(`Stages: baseline measured; noise band ${await opened.run.noiseBand().then(delta => delta.toFixed(4), () => 'not calibrated')}; ${nextRound === undefined ? `all ${opened.spec.settings.rounds} round(s) done` : `round ${nextRound + 1} of ${opened.spec.settings.rounds} next`}; held-out ${heldout === undefined ? 'not measured' : `score ${heldout.score.toFixed(4)}`}.`)
      lines.push(...trajectoryLines(trajectory))
    }
    if (opened.spec.roles.provider !== this.settings.auto.provider || opened.spec.roles.model !== this.settings.auto.model) {
      lines.push(`This run uses ${opened.spec.roles.provider} model ${opened.spec.roles.model}; the plugin settings name ${this.settings.auto.provider} model ${this.settings.auto.model}, which only a new automatic run directory picks up.`)
    }
    const [previous] = all.slice(-2, -1)
    const previousRecord = async (generation: Generation) => await readAutoRecord((await this.open(generation.spec, () => {})).directory)
    const finished = record ?? (previous === undefined ? undefined : await previousRecord(previous))
    if (finished !== undefined) lines.push(`Last summary (${clock(new Date(finished.completedAt))}):`, finished.summary)
    lines.push(schedule)
    return lines.join('\n')
  }

  /** Apply the newest generation's accepted result. */
  private async applyAuto(signal: AbortSignal): Promise<string> {
    if (!await exists(join(this.autoDirectory, RUN_SPEC_FILE))) return `Nothing to apply: there is no automatic run in ${this.autoDirectory} yet.`
    for (const generation of [...await generations(this.autoDirectory)].reverse()) {
      const opened = await this.open(generation.spec, () => {}, signal)
      if (await latestAccepted(opened) !== undefined) return await this.applyOpened(opened, signal)
    }
    return 'Nothing to apply: no generation of the automatic run has accepted a candidate yet.'
  }

  private async applyOpened(opened: OpenedRun, signal: AbortSignal): Promise<string> {
    const accepted = await latestAccepted(opened)
    if (accepted === undefined) return `Nothing to apply: run ${opened.spec.name} has accepted no candidate.`
    const result: ApplyResult = await applyRevision(opened, accepted.commit, this.live, internals.now(), signal)
    if (result.status === 'unchanged') return `Your dsh configuration already holds run ${opened.spec.name}'s result at ${accepted.commit}.`
    return [
      `Applied run ${opened.spec.name} at ${accepted.commit}: ${result.changed.join(', ')}.`,
      `The previous files are in ${result.backup}. New sessions use the change; /self-improve undo restores the backup.`,
    ].join('\n')
  }

  private async undo(): Promise<string> {
    const result = await undoLatestApply(this.live, internals.now())
    return [
      `Restored ${result.restored.join(', ')} from ${result.backup}.`,
      `What the undo replaced is saved in ${result.snapshot}. New sessions use the restored configuration.`,
    ].join('\n')
  }

  private async schedule(args: readonly string[], invocation: CommandInvocation): Promise<string> {
    const [mode = 'status', time, ...rest] = args
    const usage = `usage: /self-improve schedule on [HH:MM] | off | status\n\n${HELP}`
    if (rest.length > 0 || (mode !== 'on' && time !== undefined)) throw new Error(usage)
    if (time !== undefined && !isScheduleTime(time)) throw new Error(`self-improve schedule time ${time} is not HH:MM in 24-hour local time`)
    if (mode === 'on') {
      await this.scheduler.set(true, time, invocation.agent.id)
      return `${await this.scheduler.describe()}\nThis session owns scheduled runs; keep it open so a due run can start.`
    }
    if (mode === 'off') await this.scheduler.set(false, undefined, undefined)
    else if (mode !== 'status') throw new Error(usage)
    return await this.scheduler.describe()
  }

  private jobs(): JobRegistry {
    const jobs = this.ctx.get('jobs')
    if (jobs === undefined) throw new Error(JOBS_MISSING)
    return jobs
  }

  private async openSpec(invocation: CommandInvocation, spec: string, log: (line: string) => void = () => {}): Promise<OpenedRun> {
    const cwd = await this.ctx.workingDirectory.ensure(invocation.agent, invocation.signal)
    return await this.open(resolve(cwd, spec), log, invocation.signal)
  }

  private async open(spec: string, log: (line: string) => void, signal?: AbortSignal): Promise<OpenedRun> {
    return await openRun(this.ctx, this.settings, spec, log, signal)
  }

  /** Start one job whose work runs until it settles, is killed, or the plugin is disposed. */
  private start(jobs: JobRegistry, job: {
    readonly label: string
    readonly owner: SessionId
    readonly auto: boolean
    readonly narration: Narration
    readonly work: (signal: AbortSignal) => Promise<string>
  }): string {
    return jobs.start({
      kind: 'self-improve',
      label: job.label,
      owner: job.owner,
      run: (handle) => {
        job.narration.attach(handle)
        const controller = new AbortController()
        const done = (async (): Promise<JobOutcome> => {
          try {
            return { status: 'completed', result: await job.work(controller.signal) }
          } catch (error) {
            return { status: controller.signal.aborted ? 'killed' : 'failed', detail: messageOf(error) }
          }
        })()
        const entry: ActiveJob = { id: handle.id, label: job.label, auto: job.auto, startedAt: internals.now(), controller, done }
        this.active.add(entry)
        void done.finally(() => {
          this.active.delete(entry)
        })
        return {
          cancel: (reason?: string) => {
            controller.abort(new Error(reason ?? 'self-improve job killed'))
          },
          done,
        }
      },
    })
  }
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

/**
 * Compose a run from its spec: the suite domain, the git revision store, the model roles, and the run directory.
 * @param ctx - a context injecting `llm` and `subprocess`.
 * @param config - the resolved plugin configuration.
 * @param specPath - absolute path of the run spec.
 * @param log - receives one line per stage of the run.
 * @param signal - cancellation of the composition's git commands.
 * @returns the run, its spec, its directory, its revision store, and its repository's git.
 * @throws Error for an invalid spec or suite, an unset forwarded variable, or an evolved directory inside the runs directory.
 */
export async function openRun(
  ctx: Context,
  config: Pick<CommandSettings, 'runsDirectory' | 'scratchDirectory' | 'gitTimeoutMs' | 'processGraceMs' | 'maxOutputBytes'>,
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
  if (!await exists(ignore)) await writeFile(ignore, '*\n', { mode: 0o600 })
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
  const directory = new RunDirectory(runRoot)
  const store = new GitRevisionStore({
    repository,
    branch: spec.branch,
    startPoint: spec.startPoint,
    checkouts: join(runRoot, 'checkouts'),
    evolvedDirectory: relative(repository, evolved),
    run: runner,
    timeoutMs: config.gitTimeoutMs,
  })
  const run = new SelfImproveRun({
    domain,
    store,
    analyst: createAnalyst(model),
    proposer: createProposer({
      model,
      maxTurns: spec.roles.proposerTurns,
      maxReadCharacters: spec.roles.maxReadCharacters,
      maxHistoryDiffCharacters: spec.roles.maxHistoryDiffCharacters,
      writableExtensions: EVOLVED_FILE_EXTENSIONS,
    }),
    critic: createCritic({
      model,
      brief: suite.briefs.critic,
      patterns: [...DSH_CRITIC_PATTERNS, ...suite.criticPatterns, ...taskNamePatterns([...suite.tasks.keys()])],
      attempts: spec.roles.criticAttempts,
      maxDiffCharacters: spec.roles.maxDiffCharacters,
    }),
    directory,
    log,
  }, spec.settings)
  log(`run ${spec.name}: evolved directory ${spec.evolvedDirectory} of ${repository}, evolve branch ${spec.branch}`)
  return {
    spec,
    run,
    directory,
    store,
    git: async (args, gitSignal) => await runGit(runner, args, repository, config.gitTimeoutMs, gitSignal),
  }
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
      if (spec.calibration === undefined) throw new Error('self-improve calibrate needs calibration.method, "spread" or "z", in the run spec')
      const calibration = await run.calibrate(number ?? 2, spec.calibration, signal)
      const method = calibration.method === 'spread' ? 'spread' : `z ${calibration.z}, ${calibration.estimate}`
      return `noise band ${calibration.delta.toFixed(5)} (${method}, scores ${calibration.scores.map(score => score.toFixed(4)).join(', ')})`
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

async function specStatus({ spec, run }: OpenedRun): Promise<string> {
  const status = await run.status()
  if (status.trajectory.length === 0) return `${spec.name}: no baseline yet`
  return [`${spec.name}: next round ${status.nextRound ?? 'none (complete)'}`, ...trajectoryLines(status.trajectory)].join('\n')
}

function trajectoryLines(trajectory: readonly Revision[]): string[] {
  return trajectory.map((revision, index) =>
    `H${index}: score ${revision.score.toFixed(4)}, cost ${revision.cost?.toFixed(0) ?? 'not reported'}, ${revision.commit}${revision.variant === undefined ? '' : ` (${revision.variant})`}`)
}

/** A local time to the minute, such as `03:00`, with the date when it is not today. */
function clock(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  return date.toDateString() === internals.now().toDateString() ? time : `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`
}

async function exists(path: string): Promise<boolean> {
  return await stat(path).then(() => true, () => false)
}

/** The newest generation. */
function newest(all: readonly [Generation, ...Generation[]]): Generation {
  return all.reduce((_previous, generation) => generation)
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
