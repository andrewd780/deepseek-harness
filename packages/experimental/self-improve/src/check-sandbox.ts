/**
 * Confinement of a task's check commands. A check can import and run code a
 * trial wrote, so each check command runs under macOS `sandbox-exec` with a
 * fixed policy: file writes only inside the trial's workspace and its own
 * temporary directory, plus the character devices a process writes to; no
 * network; reads and process execution as usual. The two directories reach the
 * policy as `-D` parameters, never as policy text, so no path is quoted into
 * it, and the check's `TMPDIR` is its temporary directory.
 *
 * Grading never falls back to running a check unconfined: when
 * `sandbox-exec` cannot run, or reports a failure of its own on standard
 * error, the runner throws {@link GradingRefused}. A check's own exit code
 * decides only whether the check passed.
 *
 * @module @deepseek-ai/dsh-experimental-self-improve/check-sandbox
 */

import type { ProcessResult, ProcessRunner } from './process.ts'
import type { CommandOutcome, CommandRunner } from './suite.ts'

/** Where `sandbox-exec` lives on macOS. */
export const SANDBOX_EXEC = '/usr/bin/sandbox-exec'

/** The policy every confined check runs under; `WORKSPACE` and `TEMP` are `-D` parameters. */
export const CHECK_SANDBOX_POLICY = [
  '(version 1)',
  '(allow default)',
  '(deny network*)',
  '(deny file-write*)',
  '(allow file-write* (subpath (param "WORKSPACE")) (subpath (param "TEMP"))',
  '  (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (literal "/dev/dtracehelper") (regex #"^/dev/fd/"))',
].join('\n')

/** The directories one trial's checks may write: both absolute, with symbolic links resolved. */
export interface CheckArea {
  readonly workspace: string
  readonly temp: string
}

/** A check could not be graded under confinement, so grading stops instead of running it unconfined. */
export class GradingRefused extends Error {
  override readonly name = 'GradingRefused'
}

/** How a confined runner starts processes. */
export interface ConfinedRunnerSettings {
  readonly run: ProcessRunner
  /**
   * Resolve a check's program the way the unconfined runner would.
   * @param program - the program's name or path.
   * @param signal - cancellation.
   * @returns the absolute executable.
   */
  readonly resolve: (program: string, signal?: AbortSignal) => Promise<string>
  /** Absolute path of `sandbox-exec`. */
  readonly executable: string
}

/** Longest reason kept from a failed check's standard error. */
const DETAIL_CHARACTERS = 300

/**
 * A check runner that confines every command to `area` with no network.
 * @param settings - the process runner, the program resolver, and `sandbox-exec`'s path.
 * @param area - the trial's workspace and temporary directory.
 * @returns the runner; it throws {@link GradingRefused} when the sandbox cannot confine a check.
 */
export function confinedCheckRunner(settings: ConfinedRunnerSettings, area: CheckArea): CommandRunner {
  return async ([program, ...args], cwd, timeoutMs, signal) => {
    const executable = await settings.resolve(program, signal)
    let result: ProcessResult
    try {
      result = await settings.run({
        argv: [settings.executable, '-D', `WORKSPACE=${area.workspace}`, '-D', `TEMP=${area.temp}`, '-p', CHECK_SANDBOX_POLICY, executable, ...args],
        cwd,
        timeoutMs,
        signal,
        env: { TMPDIR: area.temp },
      })
    } catch (error) {
      signal?.throwIfAborted()
      throw new GradingRefused(`grading refused: ${settings.executable} could not run (${error instanceof Error ? error.message : String(error)}); `
        + 'checks never run unconfined while sandboxChecks is on')
    }
    if (result.exitCode !== 0 && result.stderr.startsWith('sandbox-exec:')) {
      throw new GradingRefused(`grading refused: ${result.stderr.split('\n', 1).join('').trim()}`)
    }
    return outcomeOf(result)
  }
}

/**
 * A check runner without confinement, for compositions that turn `sandboxChecks` off.
 * @param run - the process runner.
 * @returns the runner.
 */
export function unconfinedCheckRunner(run: ProcessRunner): CommandRunner {
  return async (argv, cwd, timeoutMs, signal) => outcomeOf(await run({ argv, cwd, timeoutMs, signal }))
}

/**
 * A check's outcome: it passed when the command exited 0; otherwise the first error line of its standard error, or
 * its last line, says why.
 * @param result - the finished command.
 * @returns whether it passed, and why not.
 */
export function outcomeOf(result: ProcessResult): CommandOutcome {
  if (result.exitCode === 0) return { passed: true }
  const lines = result.stderr.split('\n').map(line => line.trim()).filter(line => line.length > 0)
  const reason = lines.find(line => /\b\w*Error\b.*:/.test(line)) ?? lines.at(-1) ?? `exited ${result.exitCode === null ? 'by a signal or its deadline' : `with ${result.exitCode}`}`
  return { passed: false, detail: reason.slice(0, DETAIL_CHARACTERS) }
}
