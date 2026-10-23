/**
 * Regularized recursive self-improvement of a harness configuration: the
 * `/self-improve` command and its automatic mode, the loop and its
 * regularizers, the roles, domain, and revision store a run composes, and
 * the apply, undo, and schedule of the automatic mode.
 *
 * @module @deepseek-ai/dsh-experimental-self-improve
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

import { registerSelfImproveCommand } from './command.ts'
import type { CommandSettings } from './command.ts'

export { HELP, openRun, registerSelfImproveCommand } from './command.ts'
export type { AutoSettings, CommandSettings, OpenedRun } from './command.ts'
export * from './apply.ts'
export * from './auto.ts'
export * from './auto-schedule.ts'
export * from './bootstrap.ts'
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
export * from './overlay.ts'
export * from './loop.ts'
export * from './model.ts'
export * from './process.ts'
export * from './roles.ts'
export * from './schedule.ts'
export * from './selection.ts'
export * from './spec.ts'
export * from './suite.ts'
export * from './template.ts'
export * from './trial.ts'
export type * from './types.ts'

/** Plugin name. */
export const name = 'dsh-experimental-self-improve'

/** Required services. */
export const inject = ['commands', 'llm', 'subprocess', 'workingDirectory']

/** Where runs keep their files, the limits of the processes they start, and the automatic mode's run, apply, and schedule. */
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
  /** Whether the automatic pipeline writes an accepted result into the live configuration, after a backup. */
  autoApply?: boolean
  /** The automatic run; the route and rounds are written into a new run and do not change an existing one. */
  auto?: {
    /** The automatic run's git repository, created on first use; empty is `<home>/self-improve/auto`. */
    directory?: string
    /** Provider key of the trials' route and of the search roles' route in the operator's configuration. */
    provider?: string
    /** Model of the trials and the search roles. */
    model?: string
    /** OpenAI-compatible base URL the trials' frozen policy patch routes to. */
    baseUrl?: string
    /** Context window, in tokens, the trials' route declares. */
    contextWindow?: number
    /** Rounds of each generation. */
    rounds?: number
    /** Extra baseline measurements the noise band's calibration takes. */
    calibrationRepeats?: number
  }
  /** The daily schedule of the automatic pipeline; `/self-improve schedule` overrides `enabled` and `time`. */
  schedule?: {
    /** Whether scheduled runs start. */
    enabled?: boolean
    /** Local start time, `HH:MM` in 24-hour time. */
    time?: string
    /** Least hours between two starts. */
    minIntervalHours?: number
    /** Least free, inactive, and speculative memory `vm_stat` reports, in GiB; 0 skips the check. */
    minFreeMemoryGiB?: number
    /** Hours after the start time in which a missed run may still start; 0 allows it until the next start time. */
    windowHours?: number
    /** Minutes between two checks. */
    checkIntervalMinutes?: number
  }
  /** The Harness home that applies write `AGENTS.md` and `skills/` into, holding the plugin's state; empty is the running profile's. */
  home?: string
  /** The patch layer that applies add overlay entries to; empty is `<home>/cordis.patch.yml`, which every profile applies last. */
  overlayPatch?: string
}

/** Configuration schema. */
export const Config: z<Config, CommandSettings> = z.object({
  runsDirectory: z.string().default('.agents/self-improve'),
  scratchDirectory: z.string().default(''),
  gitTimeoutMs: z.number().default(60_000),
  processGraceMs: z.number().default(3_000),
  maxOutputBytes: z.number().default(65_536),
  autoApply: z.boolean().default(true),
  auto: z.object({
    directory: z.string().default(''),
    provider: z.string().min(1).default('ollama'),
    model: z.string().min(1).default('qwen38-27b-abliterated-mlx-q4:latest'),
    baseUrl: z.string().min(1).default('http://localhost:11434/v1'),
    contextWindow: z.natural().min(1).default(32_768),
    rounds: z.natural().min(1).default(3),
    calibrationRepeats: z.natural().min(1).default(1),
  }),
  schedule: z.object({
    enabled: z.boolean().default(false),
    time: z.string().pattern(/^([01]\d|2[0-3]):[0-5]\d$/).default('03:00'),
    minIntervalHours: z.number().min(0).default(20),
    minFreeMemoryGiB: z.number().min(0).default(22),
    windowHours: z.number().min(0).default(0),
    checkIntervalMinutes: z.number().min(0.001).default(5),
  }),
  home: z.string().default(''),
  overlayPatch: z.string().default(''),
})

/**
 * Register the `/self-improve` command and the schedule's timer.
 * @param ctx - the plugin context.
 * @param config - the configuration, with defaults filled by {@link Config}.
 */
export function apply(ctx: Context, config: CommandSettings): void {
  registerSelfImproveCommand(ctx, config)
}
