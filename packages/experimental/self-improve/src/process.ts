/**
 * Bounded child processes through `ctx.subprocess`: git for the revision
 * store, and the suite's check commands.
 *
 * @module @deepseek-ai/dsh-experimental-self-improve/process
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-subprocess'
import { deadline } from '@deepseek-ai/dsh-timeout'

/** The code on a process's timeout reason. */
export const PROCESS_TIMEOUT_CODE = 'SELF_IMPROVE_PROCESS_TIMEOUT'

/** How one process ended and what it wrote. */
export interface ProcessResult {
  /** `null` when a signal ended the process, including after its deadline. */
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
}

/** One program to run. */
export interface ProcessRequest {
  /** The program, named or absolute, and its literal arguments. */
  readonly argv: readonly [string, ...string[]]
  readonly cwd: string
  readonly timeoutMs: number
  readonly signal?: AbortSignal | undefined
  /** Overrides of the scrubbed environment; an `undefined` value removes the variable. */
  readonly env?: NodeJS.ProcessEnv | undefined
}

/** Runs one program with a deadline. */
export type ProcessRunner = (request: ProcessRequest) => Promise<ProcessResult>

/** Output and termination limits of every process. */
export interface ProcessLimits {
  /** Bytes kept of each output stream; a longer stream keeps its tail. */
  readonly maxOutputBytes: number
  /** Time between the termination request and the forced kill. */
  readonly graceMs: number
}

/**
 * A runner over `ctx.subprocess` that resolves the program name and collects both output streams.
 * @param ctx - a context injecting `subprocess`.
 * @param limits - output and termination limits.
 * @returns the runner.
 */
export function subprocessRunner(ctx: Context, limits: ProcessLimits): ProcessRunner {
  return async ({ argv, cwd, timeoutMs, signal, env }) => {
    const [program, ...args] = argv
    using processDeadline = deadline(signal, timeoutMs, PROCESS_TIMEOUT_CODE)
    const executable = await ctx.subprocess.resolveExecutable(program, undefined, processDeadline.signal)
    const handle = ctx.subprocess.spawn({
      argv: [executable, ...args],
      cwd,
      stdio: { stdin: 'ignore', stdout: { maxBytes: limits.maxOutputBytes }, stderr: { maxBytes: limits.maxOutputBytes } },
      graceMs: limits.graceMs,
      signal: processDeadline.signal,
      env,
    })
    const { exitCode } = await handle.done
    signal?.throwIfAborted()
    return {
      exitCode,
      stdout: handle.collected.stdout?.readFrom(0).text ?? '',
      stderr: handle.collected.stderr?.readFrom(0).text ?? '',
    }
  }
}
