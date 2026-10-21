/**
 * Regularized recursive self-improvement of a harness configuration: the
 * `/self-improve` command, the loop and its regularizers, and the roles,
 * domain, and revision store a run composes.
 *
 * @module @deepseek-ai/dsh-experimental-self-improve
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

import { registerSelfImproveCommand } from './command.ts'

export { openRun, registerSelfImproveCommand } from './command.ts'
export type { CommandSettings, OpenedRun } from './command.ts'
export * from './brand.ts'
export * from './calibrate.ts'
export * from './components.ts'
export * from './critic.ts'
export * from './directory.ts'
export * from './domain.ts'
export * from './evaluate.ts'
export * from './evidence.ts'
export * from './evolved-directory.ts'
export * from './git.ts'
export * from './history.ts'
export * from './loop.ts'
export * from './model.ts'
export * from './process.ts'
export * from './roles.ts'
export * from './schedule.ts'
export * from './selection.ts'
export * from './spec.ts'
export * from './suite.ts'
export * from './trial.ts'
export type * from './types.ts'

/** Plugin name. */
export const name = 'dsh-experimental-self-improve'

/** Required services. */
export const inject = ['commands', 'llm', 'subprocess', 'workingDirectory']

/** Where runs keep their files, and the limits of the processes they start. */
export interface Config {
  /** Run directories, relative to the repository root; a `.gitignore` excluding everything is written when absent. */
  runsDirectory?: string
  /** Absolute parent of each trial's disposable workspace and homes; empty uses the operating system's temporary directory. */
  scratchDirectory?: string
  /** Deadline of one git command. */
  gitTimeoutMs?: number
  /** Time between a process's termination request and its forced kill. */
  processGraceMs?: number
  /** Bytes kept of each process output stream. */
  maxOutputBytes?: number
}

/** Configuration schema. */
export const Config: z<Config> = z.object({
  runsDirectory: z.string().default('.agents/self-improve'),
  scratchDirectory: z.string().default(''),
  gitTimeoutMs: z.number().default(60_000),
  processGraceMs: z.number().default(3_000),
  maxOutputBytes: z.number().default(65_536),
})

/**
 * Register the `/self-improve` command.
 * @param ctx - the plugin context.
 * @param config - the configuration, with defaults filled by {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  // The exported schema has already filled every defaulted field; the assertion records that resolution.
  registerSelfImproveCommand(ctx, config as Required<Config>)
}
