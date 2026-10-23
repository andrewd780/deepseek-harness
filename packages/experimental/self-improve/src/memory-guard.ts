/**
 * The memory guard of a self-improve job. While a job runs on macOS, the
 * guard samples `vm_stat` every `intervalSeconds`: the swap-outs since the
 * job started, and the room, the free, inactive, and speculative memory. It
 * stops the job when the swap-outs exceed `maxSwapOutMiB`, or when the room
 * stays under `minFreeGiB` for three samples in a row. Stopping aborts the
 * job like a kill, so every stage the job finished stays stored and the run
 * resumes from there; nothing after the stop runs, the apply included.
 *
 * @module @deepseek-ai/dsh-experimental-self-improve/memory-guard
 */

import { parseVmStat } from './auto-schedule.ts'
import type { ProcessRunner } from './process.ts'

/** One `vm_stat` sample. */
export interface VmStatSample {
  /** Free, inactive, and speculative memory, in bytes. */
  readonly room: number
  /** Bytes swapped out since boot. */
  readonly swapOutBytes: number
}

/** The guard's limits. */
export interface MemoryGuardSettings {
  /** Whether jobs run under the guard and fresh trials wait for room. */
  readonly enabled: boolean
  /** Most swap-outs since the job started, in MiB. */
  readonly maxSwapOutMiB: number
  /** Least room, in GiB, before three low samples in a row stop the job. */
  readonly minFreeGiB: number
  /** Time between two samples. */
  readonly intervalSeconds: number
  /** Longest wait for room before a fresh trial, after unloading the run's local models. */
  readonly roomWaitMinutes: number
}

/** What a guard samples, and how it stops its job. */
export interface MemoryGuardDependencies {
  readonly settings: Pick<MemoryGuardSettings, 'maxSwapOutMiB' | 'minFreeGiB' | 'intervalSeconds'>
  readonly sample: () => Promise<VmStatSample>
  /** Abort the job with `reason`. */
  readonly stop: (reason: string) => void
  /** Receives the guard's notes for the job's output. */
  readonly log: (line: string) => void
}

const MIB = 2 ** 20
const GIB = 2 ** 30
/** Low samples in a row that stop a job. */
const LOW_SAMPLES = 3

/** A text's prefix for every stop the guard or a room wait makes. */
export const MEMORY_STOP = 'stopped by the memory guard'

/**
 * Read the room and the swap-outs from `vm_stat`'s output.
 * @param text - the output of `vm_stat`.
 * @returns the sample.
 * @throws Error when the output lacks the page size, a room count, or the swap-outs.
 */
export function parseVmStatSample(text: string): VmStatSample {
  const room = parseVmStat(text)
  const size = Number(/page size of (\d+) bytes/.exec(text)?.[1])
  const swapouts = /^Swapouts:\s+(\d+)\.?$/m.exec(text)?.[1]
  if (swapouts === undefined) throw new Error('vm_stat printed no Swapouts count')
  return { room, swapOutBytes: Number(swapouts) * size }
}

/**
 * Run `vm_stat` and read a sample from it.
 * @param run - the process runner.
 * @param timeoutMs - the command's deadline.
 * @returns the sample.
 * @throws Error when `vm_stat` fails or prints something else.
 */
export async function vmStatSample(run: ProcessRunner, timeoutMs: number): Promise<VmStatSample> {
  const result = await run({ argv: ['vm_stat'], cwd: '/', timeoutMs })
  if (result.exitCode !== 0) throw new Error(`vm_stat exited with ${result.exitCode}: ${result.stderr.trim()}`)
  return parseVmStatSample(result.stdout)
}

/**
 * A number of bytes in GiB, to one decimal.
 * @param bytes - the bytes.
 * @returns the text, such as `21.5`.
 */
export function gib(bytes: number): string {
  return (bytes / GIB).toFixed(1)
}

/** The guard of one job; {@link MemoryGuard.start} it when the job starts and {@link MemoryGuard.dispose} it when the job settles. */
export class MemoryGuard {
  private baseline: VmStatSample | undefined
  private timer: ReturnType<typeof setInterval> | undefined
  private low = 0
  private sampling = false
  private failureLogged = false

  /**
   * @param deps - the limits, the sampler, the stop, and the log.
   */
  constructor(private readonly deps: MemoryGuardDependencies) {}

  /**
   * Take the baseline sample and start sampling; a baseline that cannot be sampled leaves the job unguarded, with a note.
   * @returns once the baseline is taken.
   */
  async start(): Promise<void> {
    try {
      this.baseline = await this.deps.sample()
    } catch (error) {
      this.deps.log(`memory guard off for this job: ${messageOf(error)}`)
      return
    }
    this.timer = setInterval(() => {
      void this.check()
    }, this.deps.settings.intervalSeconds * 1000)
    this.timer.unref()
  }

  /** Stop sampling. */
  dispose(): void {
    clearInterval(this.timer)
  }

  /**
   * Take one sample and stop the job when it breaks a limit.
   * @returns once the sample is judged; never rejects.
   */
  async check(): Promise<void> {
    const baseline = this.baseline
    if (this.sampling || baseline === undefined) return
    this.sampling = true
    try {
      const sample = await this.deps.sample()
      const { maxSwapOutMiB, minFreeGiB } = this.deps.settings
      const swapped = sample.swapOutBytes - baseline.swapOutBytes
      this.low = sample.room < minFreeGiB * GIB ? this.low + 1 : 0
      if (swapped > maxSwapOutMiB * MIB) {
        this.halt(`${MEMORY_STOP}: ${(swapped / MIB).toFixed(0)} MiB swapped out since the job started, over the ${maxSwapOutMiB} MiB limit`)
      } else if (this.low >= LOW_SAMPLES) {
        this.halt(`${MEMORY_STOP}: ${gib(sample.room)} GiB of free, inactive, and speculative memory for ${LOW_SAMPLES} samples in a row, under the ${minFreeGiB} GiB limit`)
      }
    } catch (error) {
      if (!this.failureLogged) this.deps.log(`memory guard: a vm_stat sample failed: ${messageOf(error)}`)
      this.failureLogged = true
    } finally {
      this.sampling = false
    }
  }

  private halt(reason: string): void {
    this.dispose()
    this.deps.stop(reason)
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
