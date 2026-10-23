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
export type { AutoSettings, CommandSettings, OllamaSettings, OpenedRun } from './command.ts'
export * from './apply.ts'
export * from './auto.ts'
export * from './auto-schedule.ts'
export * from './bootstrap.ts'
export * from './brand.ts'
export * from './check-sandbox.ts'
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
export * from './job-care.ts'
export * from './overlay.ts'
export * from './loop.ts'
export * from './memory-guard.ts'
export * from './model.ts'
export * from './ollama.ts'
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
  /** Whether every task-check command runs under macOS `sandbox-exec`, writing only inside its trial's directories, without network. */
  sandboxChecks?: boolean
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
  /** How a job unloads a run's local model from its Ollama server. */
  ollama?: {
    /** Whether a job unloads the trials' model after each trial and the roles' model after each role stage, on an Ollama server. */
    unloadBetweenTrials?: boolean
    /** Bound on one unload, in seconds. */
    unloadTimeoutSeconds?: number
  }
  /** The memory guard of every job on macOS, and the room a fresh trial waits for. */
  memoryGuard?: {
    /** Whether jobs run under the guard and fresh trials wait for `schedule.minFreeMemoryGiB` of room. */
    enabled?: boolean
    /** Most swap-outs since a job started, in MiB, before the guard stops it. */
    maxSwapOutMiB?: number
    /** Least room, in GiB; three samples in a row under it stop the job. */
    minFreeGiB?: number
    /** Seconds between two `vm_stat` samples. */
    intervalSeconds?: number
    /** Longest wait for room before a fresh trial, in minutes, after unloading the run's local models. */
    roomWaitMinutes?: number
  }
}

/** Configuration schema. */
export const Config: z<Config, CommandSettings> = z.object({
  runsDirectory: z.string().default('.agents/self-improve'),
  scratchDirectory: z.string().default(''),
  gitTimeoutMs: z.number().default(60_000),
  processGraceMs: z.number().default(3_000),
  maxOutputBytes: z.number().default(65_536),
  sandboxChecks: z.boolean().default(true),
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
  ollama: z.object({
    unloadBetweenTrials: z.boolean().default(true),
    unloadTimeoutSeconds: z.number().min(1).default(30),
  }),
  memoryGuard: z.object({
    enabled: z.boolean().default(true),
    maxSwapOutMiB: z.number().min(0).default(256),
    minFreeGiB: z.number().min(0).default(2),
    intervalSeconds: z.number().min(0.01).default(5),
    roomWaitMinutes: z.number().min(0).default(10),
  }),
})

/**
 * Register the `/self-improve` command and the schedule's timer.
 * @param ctx - the plugin context.
 * @param config - the configuration, with defaults filled by {@link Config}.
 */
export function apply(ctx: Context, config: CommandSettings): void {
  registerSelfImproveCommand(ctx, config)
}
