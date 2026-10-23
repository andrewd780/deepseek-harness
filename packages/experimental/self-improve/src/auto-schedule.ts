/**
 * The automatic mode's daily schedule: while the plugin is loaded, a timer
 * checks whether a run is due and starts the automatic pipeline when every
 * check passes.
 *
 * A run is due once the day's start time has come, no run started since
 * then, and at least `minIntervalHours` passed since the last start; with
 * `windowHours` above 0, only until that many hours after the start time.
 * A due run also needs no self-improve job running in this process, enough
 * memory room, and an owner session. Memory room is the free, inactive, and
 * speculative pages `vm_stat` reports, which macOS can hand to a model load
 * without swapping. The owner is the session that turned the schedule on,
 * or, when the plugin settings turned it on, the first session that ran
 * `/self-improve` afterwards; the background job belongs to that session, so
 * it must be open when a run is due.
 *
 * `schedule.json` keeps the command's choices, which take precedence over
 * the plugin settings, the owner, the last start, and the last check that
 * was due but blocked, with its reason. Checks hold the file's lock without
 * waiting, so two processes never start the same day's run.
 *
 * @module @deepseek-ai/dsh-experimental-self-improve/auto-schedule
 */

import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { SessionId } from '@deepseek-ai/dsh-session'

import type { ProcessRunner } from './process.ts'

/** The plugin settings of the schedule. */
export interface ScheduleSettings {
  /** Whether the schedule is on when the command never set it. */
  readonly enabled: boolean
  /** Local start time, `HH:MM`, when the command never set one. */
  readonly time: string
  /** Least time between two starts. */
  readonly minIntervalHours: number
  /** Least free, inactive, and speculative memory, in GiB (2^30 bytes); 0 skips the check. */
  readonly minFreeMemoryGiB: number
  /** Hours after the start time in which a run may still start; 0 has no limit. */
  readonly windowHours: number
  /** Time between two checks. */
  readonly checkIntervalMinutes: number
}

/** The persisted state of the schedule. */
export interface ScheduleState {
  /** The command's choice; absent defers to the plugin settings. */
  readonly enabled?: boolean
  /** The command's start time; absent defers to the plugin settings. */
  readonly time?: string
  readonly owner?: SessionId
  readonly lastStartedAt?: string
  readonly lastJob?: string
  /** The last check that was due but could not start, or the last start. */
  readonly lastCheck?: { readonly at: string; readonly reason: string }
}

/** Whether a run is due by the clock. */
export type DueCheck = { readonly due: true } | { readonly due: false; readonly reason: string }

/** One check's outcome. */
export type TickOutcome = { readonly started: true; readonly job: string } | { readonly started: false; readonly reason: string }

/** What a scheduler reads and starts. */
export interface SchedulerDependencies {
  readonly settings: ScheduleSettings
  /** Absolute path of `schedule.json`. */
  readonly statePath: string
  readonly now: () => Date
  /** Free, inactive, and speculative memory in bytes. */
  readonly memory: () => Promise<number>
  /** A description of the running self-improve job, or `undefined` when none runs. */
  readonly activeJob: () => string | undefined
  /** Start the automatic pipeline owned by `owner`; resolves to the job id. */
  readonly start: (owner: SessionId) => Promise<string>
}

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/
const HOUR_MS = 3_600_000
const GIB = 2 ** 30
const NO_OWNER = 'waiting: no session owns the schedule; run /self-improve schedule on in the session that should own scheduled runs'

/**
 * Whether `text` is a local start time the schedule accepts.
 * @param text - the candidate time.
 * @returns whether it is `HH:MM` with hours 00-23 and minutes 00-59.
 */
export function isScheduleTime(text: string): boolean {
  return TIME.test(text)
}

/**
 * Whether a run is due at `now` by the clock alone.
 * @param input - the time, the schedule's start time and limits, and the last start.
 * @returns due, or the reason it is not.
 */
export function dueCheck(input: {
  readonly now: Date
  readonly time: string
  readonly lastStartedAt: Date | undefined
  readonly minIntervalHours: number
  readonly windowHours: number
}): DueCheck {
  const { now, time, lastStartedAt } = input
  const match = TIME.exec(time)
  if (match === null) throw new Error(`self-improve schedule time ${JSON.stringify(time)} is not HH:MM`)
  const slot = new Date(now)
  slot.setHours(Number(match[1]), Number(match[2]), 0, 0)
  if (now < slot) return { due: false, reason: `waiting for ${time}` }
  if (input.windowHours > 0 && now.getTime() >= slot.getTime() + input.windowHours * HOUR_MS) {
    return { due: false, reason: `today's window, ${time} plus ${input.windowHours} h, has passed` }
  }
  if (lastStartedAt !== undefined && lastStartedAt >= slot) return { due: false, reason: `already started today at ${localTime(lastStartedAt)}` }
  if (lastStartedAt !== undefined && now.getTime() - lastStartedAt.getTime() < input.minIntervalHours * HOUR_MS) {
    return { due: false, reason: `the last start, ${localTime(lastStartedAt)}, is less than ${input.minIntervalHours} h ago` }
  }
  return { due: true }
}

/**
 * Memory macOS can give a new process without swapping: free, inactive, and speculative pages.
 * @param text - the output of `vm_stat`.
 * @returns the bytes.
 * @throws Error when the output lacks the page size or one of the three counts.
 */
export function parseVmStat(text: string): number {
  const size = /page size of (\d+) bytes/.exec(text)?.[1]
  const pages = (label: string): number | undefined => {
    const count = new RegExp(`^Pages ${label}:\\s+(\\d+)\\.?$`, 'm').exec(text)?.[1]
    return count === undefined ? undefined : Number(count)
  }
  const free = pages('free')
  const inactive = pages('inactive')
  const speculative = pages('speculative')
  if (size === undefined || free === undefined || inactive === undefined || speculative === undefined) {
    throw new Error('vm_stat printed no page size or no free, inactive, or speculative page count')
  }
  return (free + inactive + speculative) * Number(size)
}

/**
 * Run `vm_stat` and read the memory room from it.
 * @param run - the process runner.
 * @param timeoutMs - the command's deadline.
 * @returns free, inactive, and speculative memory in bytes.
 * @throws Error when `vm_stat` fails or prints something else.
 */
export async function vmStatMemory(run: ProcessRunner, timeoutMs: number): Promise<number> {
  const result = await run({ argv: ['vm_stat'], cwd: '/', timeoutMs })
  if (result.exitCode !== 0) throw new Error(`vm_stat exited with ${result.exitCode}: ${result.stderr.trim()}`)
  return parseVmStat(result.stdout)
}

/**
 * Read the persisted schedule.
 * @param path - absolute path of `schedule.json`.
 * @returns the state; empty when the file does not exist.
 * @throws Error when the file is not a valid schedule.
 */
export async function readScheduleState(path: string): Promise<ScheduleState> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new Error(`${path} is not JSON`, { cause: error })
  }
  const invalid = new Error(`${path} is not a self-improve schedule`)
  if (!isRecord(value)) throw invalid
  const { enabled, time, owner, lastStartedAt, lastJob, lastCheck } = value
  if (enabled !== undefined && typeof enabled !== 'boolean') throw invalid
  if (time !== undefined && (typeof time !== 'string' || !isScheduleTime(time))) throw invalid
  if (!optionalText(owner) || !optionalText(lastStartedAt) || !optionalText(lastJob)) throw invalid
  const at = isRecord(lastCheck) ? lastCheck['at'] : undefined
  const reason = isRecord(lastCheck) ? lastCheck['reason'] : undefined
  if (lastCheck !== undefined && (typeof at !== 'string' || typeof reason !== 'string')) throw invalid
  return {
    ...enabled === undefined ? {} : { enabled },
    ...typeof time === 'string' ? { time } : {},
    ...owner === undefined ? {} : { owner: SessionId(owner) },
    ...lastStartedAt === undefined ? {} : { lastStartedAt },
    ...lastJob === undefined ? {} : { lastJob },
    ...typeof at === 'string' && typeof reason === 'string' ? { lastCheck: { at, reason } } : {},
  }
}

/** The automatic mode's daily schedule. */
export class AutoScheduler {
  private checking = false

  /**
   * @param deps - the settings, the state file, the clock, the memory reader, the running job, and the starter.
   */
  constructor(private readonly deps: SchedulerDependencies) {}

  /**
   * Check whether a run is due and start it when every check passes. A check that is due but blocked is recorded.
   * @returns the started job, or why none started; never rejects.
   */
  async tick(): Promise<TickOutcome> {
    if (this.checking) return { started: false, reason: 'the previous check is still running' }
    this.checking = true
    try {
      await mkdir(dirname(this.deps.statePath), { recursive: true, mode: 0o700 })
      return await withFileLock(this.deps.statePath, async () => await this.check(), { waitMs: 0 })
    } catch (error) {
      return { started: false, reason: `the check failed: ${messageOf(error)}` }
    } finally {
      this.checking = false
    }
  }

  /**
   * Turn the schedule on or off for every later check, and record the owner of scheduled runs.
   * @param enabled - whether the schedule is on.
   * @param time - a new local start time, `HH:MM`; omitted keeps the current one.
   * @param owner - the session that owns scheduled runs from now on; omitted keeps the current one.
   * @returns the state written.
   */
  async set(enabled: boolean, time: string | undefined, owner: SessionId | undefined): Promise<ScheduleState> {
    return await this.update(state => ({
      ...state,
      enabled,
      ...time === undefined ? {} : { time },
      ...owner === undefined ? {} : { owner },
    }))
  }

  /**
   * Make `session` the owner when the schedule is on and no session owns it.
   * @param session - the session that ran a command.
   * @returns whether `session` became the owner.
   */
  async claim(session: SessionId): Promise<boolean> {
    const current = await readScheduleState(this.deps.statePath)
    if (!this.enabled(current) || current.owner !== undefined) return false
    let claimed = false
    await this.update((state) => {
      if (!this.enabled(state) || state.owner !== undefined) return state
      claimed = true
      return { ...state, owner: session }
    })
    return claimed
  }

  /**
   * Describe the schedule for `/self-improve schedule status`.
   * @returns one line per fact.
   */
  async describe(): Promise<string> {
    const { settings } = this.deps
    const state = await readScheduleState(this.deps.statePath)
    const enabled = this.enabled(state)
    const source = state.enabled === undefined ? 'the plugin settings' : '/self-improve schedule'
    const time = state.time ?? settings.time
    const lines = [
      `schedule: ${enabled ? `on, daily at ${time} local time` : 'off'} (set by ${source})`,
      `checks every ${settings.checkIntervalMinutes} min: at least ${settings.minIntervalHours} h between starts${settings.windowHours > 0 ? `, starts until ${settings.windowHours} h after ${time}` : ''}, ${settings.minFreeMemoryGiB > 0 ? `at least ${settings.minFreeMemoryGiB} GiB of free, inactive, and speculative memory` : 'no memory check'}, and no other self-improve job running`,
      `owner: ${state.owner === undefined ? 'none yet; the next session to run /self-improve schedule on, or any /self-improve command while the schedule is on, owns scheduled runs' : `session ${state.owner}, which must be open when a run is due`}`,
    ]
    if (state.lastStartedAt !== undefined) lines.push(`last start: ${localTime(new Date(state.lastStartedAt))}${state.lastJob === undefined ? '' : ` (job ${state.lastJob})`}`)
    if (state.lastCheck !== undefined) lines.push(`last due check: ${localTime(new Date(state.lastCheck.at))}: ${state.lastCheck.reason}`)
    if (enabled) {
      const due = this.due(this.deps.now(), state)
      lines.push(`now: ${due.due ? 'due; the next check starts it when the other checks pass' : due.reason}`)
    }
    return lines.join('\n')
  }

  private enabled(state: ScheduleState): boolean {
    return state.enabled ?? this.deps.settings.enabled
  }

  private due(now: Date, state: ScheduleState): DueCheck {
    const { settings } = this.deps
    return dueCheck({
      now,
      time: state.time ?? settings.time,
      lastStartedAt: state.lastStartedAt === undefined ? undefined : new Date(state.lastStartedAt),
      minIntervalHours: settings.minIntervalHours,
      windowHours: settings.windowHours,
    })
  }

  private async check(): Promise<TickOutcome> {
    const now = this.deps.now()
    const state = await readScheduleState(this.deps.statePath)
    if (!this.enabled(state)) return { started: false, reason: 'the schedule is off' }
    const due = this.due(now, state)
    if (!due.due) return { started: false, reason: due.reason }
    const record = async (reason: string): Promise<TickOutcome> => {
      await this.write({ ...state, lastCheck: { at: now.toISOString(), reason } })
      return { started: false, reason }
    }
    const blocked = await this.blocked()
    if (blocked !== undefined) return await record(blocked)
    const owner = state.owner
    if (owner === undefined) return await record(NO_OWNER)
    let job: string
    try {
      job = await this.deps.start(owner)
    } catch (error) {
      return await record(`could not start the run for session ${owner}: ${messageOf(error)}`)
    }
    await this.write({ ...state, lastStartedAt: now.toISOString(), lastJob: job, lastCheck: { at: now.toISOString(), reason: `started job ${job}` } })
    return { started: true, job }
  }

  /** Why a due run cannot start now for lack of room, or `undefined` when there is room. */
  private async blocked(): Promise<string | undefined> {
    const active = this.deps.activeJob()
    if (active !== undefined) return `waiting: ${active} is running`
    const minimum = this.deps.settings.minFreeMemoryGiB
    if (minimum === 0) return undefined
    let room: number
    try {
      room = await this.deps.memory()
    } catch (error) {
      return `waiting: the memory check failed: ${messageOf(error)}`
    }
    return room < minimum * GIB ? `waiting: ${(room / GIB).toFixed(1)} GiB of memory is free, inactive, or speculative; ${minimum} GiB needed` : undefined
  }

  private async update(change: (state: ScheduleState) => ScheduleState): Promise<ScheduleState> {
    await mkdir(dirname(this.deps.statePath), { recursive: true, mode: 0o700 })
    return await withFileLock(this.deps.statePath, async () => {
      const before = await readScheduleState(this.deps.statePath)
      const after = change(before)
      if (after !== before) await this.write(after)
      return after
    })
  }

  private async write(state: ScheduleState): Promise<void> {
    await writeFileAtomic(this.deps.statePath, `${JSON.stringify(state, undefined, 1)}\n`, { mode: 0o600, dirMode: 0o700 })
  }
}

/**
 * Run the scheduler's checks every `checkIntervalMinutes` until the returned disposer runs.
 * @param scheduler - the scheduler.
 * @param settings - the check interval.
 * @returns a disposer that stops the timer.
 */
export function startScheduleTimer(scheduler: AutoScheduler, settings: Pick<ScheduleSettings, 'checkIntervalMinutes'>): () => void {
  const timer = setInterval(() => {
    void scheduler.tick()
  }, settings.checkIntervalMinutes * 60_000)
  timer.unref()
  return () => {
    clearInterval(timer)
  }
}

/** A local date and time to the minute, such as `2026-10-23 03:00`. */
function localTime(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalText(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string'
}
