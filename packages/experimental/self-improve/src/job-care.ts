/**
 * What a job does around each trial and each role stage to keep a local
 * model's memory in bounds. After every trial, and after every analyst,
 * proposer, or critic stage, it unloads the run's local model from its
 * Ollama server, so the server's prefix cache holds at most one trial or
 * stage; every unload, and every unload that failed, is a line of the job's
 * output, and a failed unload never stops the job. Before a fresh trial it
 * checks the room `vm_stat` reports; when the room is under the schedule's
 * `minFreeMemoryGiB`, it unloads the run's local models and waits for the
 * room up to `memoryGuard.roomWaitMinutes`, then stops the job with the
 * reason.
 *
 * @module @deepseek-ai/dsh-experimental-self-improve/job-care
 */

import { setTimeout as sleep } from 'node:timers/promises'

import { gib, MEMORY_STOP } from './memory-guard.ts'
import type { VmStatSample } from './memory-guard.ts'
import { NotOllama, unloadOllamaModel } from './ollama.ts'
import type { Fetch, LocalRoute, UnloadSettings } from './ollama.ts'

/** The calls a run makes around its trials and role stages. */
export interface TrialCare {
  /**
   * Before a trial that runs, not one whose result is stored.
   * @param label - the trial, such as `base-1a2b r0A alpha#0`.
   * @param signal - cancellation of the wait.
   * @returns once the trial may start.
   * @throws Error after stopping the job when the room did not come back.
   */
  beforeTrial(label: string, signal?: AbortSignal): Promise<void>
  /**
   * After a trial ran, whatever its outcome; never rejects.
   * @param label - the trial.
   */
  afterTrial(label: string): Promise<void>
  /**
   * After an analyst, proposer, or critic stage, whatever its outcome; never rejects.
   * @param stage - the stage, such as `the analysis of round 1`.
   */
  afterRole(stage: string): Promise<void>
}

/** Calls that do nothing, for a run outside any job. */
export const NO_CARE: TrialCare = {
  beforeTrial: async () => {},
  afterTrial: async () => {},
  afterRole: async () => {},
}

/** The local models of a run: the trials' and the search roles'. */
export interface LocalRoutes {
  readonly trial?: LocalRoute
  readonly role?: LocalRoute
}

/** The room a fresh trial waits for. */
export interface RoomWait {
  /** Least room, in GiB; 0 skips the check. */
  readonly minGiB: number
  readonly waitMs: number
  /** Time between two samples while waiting. */
  readonly pollMs: number
}

/** What one job's care unloads, samples, and stops. */
export interface JobCareDependencies {
  readonly routes: LocalRoutes
  /** How unloads are bounded; `undefined` turns unloads off. */
  readonly unload: UnloadSettings | undefined
  /** The room a fresh trial waits for; `undefined` turns the check off. */
  readonly room: RoomWait | undefined
  readonly sample: () => Promise<VmStatSample>
  /** Abort the job with `reason`. */
  readonly stop: (reason: string) => void
  /** Receives one line per unload and per wait for the job's output. */
  readonly log: (line: string) => void
  readonly fetch?: Fetch
}

/** The care of one job. */
export class JobCare implements TrialCare {
  private readonly notOllama = new Set<string>()
  private sampleFailed = false

  /**
   * @param deps - the run's local models, the unload bounds, the room wait, the sampler, the stop, and the log.
   */
  constructor(private readonly deps: JobCareDependencies) {}

  async beforeTrial(label: string, signal?: AbortSignal): Promise<void> {
    const room = this.deps.room
    if (room === undefined || room.minGiB === 0) return
    const needed = room.minGiB * 2 ** 30
    let current = await this.sample()
    if (current === undefined || current.room >= needed) return
    const minutes = room.waitMs / 60_000
    const unloading = this.deps.unload === undefined ? '' : 'unloading the run\'s local models and '
    this.deps.log(`${gib(current.room)} GiB of memory is free before trial ${label}, under ${room.minGiB} GiB; ${unloading}waiting up to ${minutes} min`)
    await this.unload(this.deps.routes.trial, `to make room for trial ${label}`)
    await this.unload(this.deps.routes.role, `to make room for trial ${label}`)
    const deadline = Date.now() + room.waitMs
    while (current.room < needed) {
      if (Date.now() >= deadline) {
        const reason = `${MEMORY_STOP}: ${gib(current.room)} GiB of memory was free before trial ${label} after waiting ${minutes} min; ${room.minGiB} GiB needed`
        this.deps.stop(reason)
        throw new Error(reason)
      }
      await sleep(room.pollMs, undefined, { signal })
      const next = await this.sample()
      if (next === undefined) return
      current = next
    }
    this.deps.log(`${gib(current.room)} GiB of memory is free; trial ${label} starts`)
  }

  async afterTrial(label: string): Promise<void> {
    await this.unload(this.deps.routes.trial, `after trial ${label}`)
  }

  async afterRole(stage: string): Promise<void> {
    await this.unload(this.deps.routes.role, `after ${stage}`)
  }

  /**
   * Unload one route's model and log the outcome; never rejects.
   * @param occasion - why, such as `after trial base-1 alpha#0`.
   */
  private async unload(route: LocalRoute | undefined, occasion: string): Promise<void> {
    const settings = this.deps.unload
    if (settings === undefined || route === undefined || this.notOllama.has(route.origin)) return
    try {
      const outcome = await unloadOllamaModel(route, settings, this.deps.fetch)
      if (outcome.status === 'unloaded') {
        this.deps.log(`unloaded ${route.model} from ${route.origin} ${occasion} (${(outcome.milliseconds / 1000).toFixed(1)} s)`)
      } else if (outcome.status === 'still-loaded') {
        this.deps.log(`${route.model} is still loaded at ${route.origin} ${settings.timeoutMs / 1000} s after the unload request ${occasion}`)
      }
    } catch (error) {
      if (error instanceof NotOllama) {
        this.notOllama.add(route.origin)
        this.deps.log(`no unloads at ${route.origin}: ${error.message}`)
        return
      }
      this.deps.log(`unloading ${route.model} from ${route.origin} ${occasion} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** One sample, or `undefined` when `vm_stat` cannot be read, noted once per job. */
  private async sample(): Promise<VmStatSample | undefined> {
    try {
      return await this.deps.sample()
    } catch (error) {
      if (!this.sampleFailed) this.deps.log(`memory check before trials skipped: ${error instanceof Error ? error.message : String(error)}`)
      this.sampleFailed = true
      return undefined
    }
  }
}
