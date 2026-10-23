/**
 * The domain of a task suite measured through fresh dsh runtimes: each trial
 * runs one task with a candidate's evolved directory and the frozen policy
 * patches, and the task's checks score it.
 *
 * A checkout's evolved directory may hold:
 * - `overlay.patch.yml`, a profile patch applied before the policy patches;
 *   a job whose overlay breaks the domain's overlay rules fails before any
 *   trial starts, and each trial loads a JSON copy of the checked entries;
 * - `AGENTS.md`, copied into each trial's Harness home as user-global instructions;
 * - `skills/`, copied into each trial's Harness home as user skills.
 *
 * Every trial gets a fresh workspace, Harness home, and agents home outside
 * any repository, so neither the operator's instructions nor their skills
 * reach it. Its record lives under `<run>/trials/<job>/<task>/<trial>/`:
 * `record.json` with the Session tree's events, and `result.json` once the
 * checks judged it. A trial whose runtime failed has no result and runs again
 * when its job is measured again. Each trial's checks get a runner bound to
 * its workspace and its own temporary directory, the only places a confined
 * check may write; a trial whose checks cannot be graded under confinement
 * records the reason as its failure, and the measurement stops.
 *
 * @module @deepseek-ai/dsh-experimental-self-improve/domain
 */

import { cp, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { validatedSessionEvent } from '@deepseek-ai/dsh-sdk-client'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

import type { EvaluationJobId, TaskId } from './brand.ts'
import { GradingRefused } from './check-sandbox.ts'
import type { CheckArea } from './check-sandbox.ts'
import type { ComponentSet } from './components.ts'
import { aggregate, taskMean } from './evaluate.ts'
import type { EvaluationResult, TaskResult } from './evaluate.ts'
import { checkOverlay, describeOverlayRules, OVERLAY_FILE } from './overlay.ts'
import type { OverlayCheck, OverlayRules } from './overlay.ts'
import { runChecks } from './suite.ts'
import type { CheckResult, CommandRunner, Suite } from './suite.ts'
import { finalResponse, firstRequestInputTokens, renderTrial, runTrial, trialTokens } from './trial.ts'
import type { TrialEvent, TrialLaunch, TrialRecord } from './trial.ts'
import type { DomainBriefs, EvaluationRequest, SelfImproveDomain, SmokeResult } from './types.ts'

/** The measure a prompt-growth guard compares. */
export const FIRST_REQUEST_MEASURE = 'firstRequestInputTokens'

/** How trials of a suite domain run. */
export interface SuiteDomainSettings {
  readonly suite: Suite
  readonly componentSet: ComponentSet
  /** What a candidate's overlay may change; the proposer's brief opens with them. */
  readonly overlayRules: OverlayRules
  /** Absolute run directory; trial records live under its `trials/`. */
  readonly runRoot: string
  /** The evolved directory's path relative to a checkout root. */
  readonly evolvedDirectory: string
  /** Absolute directory for each trial's disposable workspace and homes. */
  readonly scratch: string
  readonly profile: string
  /** Frozen patches applied after the candidate's overlay. */
  readonly policyPatches: readonly string[]
  readonly provider: string
  readonly model: string
  /** Variables each trial's runtime receives over the scrubbed parent environment. */
  readonly environment: () => Readonly<Record<string, string>>
  readonly trialTimeoutMs: number
  readonly shutdownTimeoutMs: number
  /** Trials run at once. */
  readonly concurrency: number
  /**
   * The runner of one trial's check commands, given the directories its checks may write.
   * @param area - the trial's workspace and its own temporary directory, with symbolic links resolved.
   * @returns the runner; a {@link GradingRefused} it throws marks the trial errored and stops the measurement.
   */
  readonly checkRunner: (area: CheckArea) => CommandRunner
  /** Longest rendering of one message or tool payload in a trace. */
  readonly maxTraceCharacters: number
  /** Largest relative growth of the first request's prompt a candidate may carry; `undefined` sets no guard. */
  readonly maxPromptGrowth: number | undefined
}

interface TrialResult {
  readonly reward: number
  readonly tokens: number | undefined
  readonly firstRequestInputTokens: number | undefined
  readonly checks: readonly CheckResult[]
}

/** A domain over a task suite. */
export class SuiteDomain implements SelfImproveDomain {
  readonly componentSet: ComponentSet
  readonly briefs: DomainBriefs

  /**
   * @param settings - the suite, the trial launch, and the domain's limits.
   */
  constructor(private readonly settings: SuiteDomainSettings) {
    this.componentSet = settings.componentSet
    const briefs = settings.suite.briefs
    this.briefs = {
      ...briefs,
      proposer: [describeOverlayRules(settings.overlayRules), briefs.proposer].filter(text => text.length > 0).join('\n\n'),
    }
  }

  evolveTasks(): readonly TaskId[] {
    return this.split('evolve')
  }

  heldoutTasks(): readonly TaskId[] {
    return this.split('heldout')
  }

  smokeTasks(incumbent: EvaluationResult): readonly TaskId[] {
    if (this.settings.suite.smoke.length > 0) return this.settings.suite.smoke
    let best: { readonly task: TaskId; readonly mean: number } | undefined
    for (const [task, result] of incumbent.perTask) {
      const mean = taskMean(result)
      if (best === undefined || mean > best.mean) best = { task, mean }
    }
    return best === undefined ? this.evolveTasks().slice(0, 1) : [best.task]
  }

  async evaluate(request: EvaluationRequest): Promise<EvaluationResult> {
    return (await this.measure(request)).evaluation
  }

  async smoke(request: EvaluationRequest): Promise<SmokeResult> {
    const { evaluation, failures } = await this.measure(request)
    if (failures.length === 0) return { ok: true, detail: `${evaluation.expectedTrials} smoke trial(s) ran` }
    return { ok: false, detail: `${failures.length} of ${evaluation.expectedTrials} smoke trial(s) produced no result: ${failures.join('; ')}` }
  }

  guards(incumbent: EvaluationResult, candidate: EvaluationResult): readonly string[] {
    const limit = this.settings.maxPromptGrowth
    const before = incumbent.measures[FIRST_REQUEST_MEASURE]
    const after = candidate.measures[FIRST_REQUEST_MEASURE]
    if (limit === undefined || before === undefined || after === undefined || before <= 0) return []
    if (after <= before * (1 + limit)) return []
    return [`the first request's prompt grew ${((after / before - 1) * 100).toFixed(1)}% (limit ${(limit * 100).toFixed(1)}%)`]
  }

  async screen(root: string): Promise<readonly string[]> {
    const overlay = await this.checkOverlay(root)
    return overlay.ok ? [] : overlay.objections
  }

  async renderTrace(job: EvaluationJobId, task: TaskId, trial: number): Promise<string | undefined> {
    const record = await this.readRecord(job, task, trial)
    if (record === undefined) return undefined
    const result = await this.readResult(job, task, trial)
    const checks = result === undefined ? [] : result.checks.map(check => `[check ${check.passed ? 'passed' : 'failed'}] ${check.check}`)
    return [renderTrial(record, this.settings.maxTraceCharacters), ...checks].join('\n')
  }

  /** Every trial of the request, folded into an evaluation, with the failure of each trial that produced no result. */
  private async measure(
    request: EvaluationRequest,
  ): Promise<{ readonly evaluation: EvaluationResult; readonly failures: readonly string[] }> {
    const overlay = await this.checkOverlay(request.root)
    if (!overlay.ok) throw new Error(`self-improve overlay of ${request.root} breaks the overlay rules: ${overlay.objections.join('; ')}`)
    const patch = overlay.entries.length === 0 ? undefined : `${JSON.stringify(overlay.entries)}\n`
    const slots = request.tasks.flatMap(task => Array.from({ length: request.trials }, (_, trial) => ({ task, trial })))
    const outcomes = await pool(slots, this.settings.concurrency, async slot => await this.trial(request, slot.task, slot.trial, patch))
    const perTask = new Map<TaskId, TaskResult>()
    const firstRequests: number[] = []
    for (const task of request.tasks) {
      const results = outcomes.filter((_, index) => slots[index]?.task === task).map(outcome => ('reward' in outcome ? outcome : undefined))
      perTask.set(task, {
        rewards: results.map(result => result?.reward ?? 0),
        weights: results.map(() => 1),
        tokens: results.map(result => result?.tokens),
        missing: results.filter(result => result === undefined).length,
      })
      for (const result of results) if (result?.firstRequestInputTokens !== undefined) firstRequests.push(result.firstRequestInputTokens)
    }
    const measures = firstRequests.length === 0
      ? {}
      : { [FIRST_REQUEST_MEASURE]: firstRequests.reduce((sum, value) => sum + value, 0) / firstRequests.length }
    const failures = outcomes.flatMap((outcome, index) => ('failure' in outcome ? [`${slots[index]?.task}#${slots[index]?.trial}: ${outcome.failure}`] : []))
    return { evaluation: aggregate(request.job, request.trials, perTask, measures), failures }
  }

  /** The checked overlay of a checkout; a checkout without one has no entries. */
  private async checkOverlay(root: string): Promise<OverlayCheck> {
    const text = await readText(join(root, this.settings.evolvedDirectory, OVERLAY_FILE))
    return text === undefined ? { ok: true, entries: [] } : checkOverlay(text, this.settings.overlayRules)
  }

  private split(split: 'evolve' | 'heldout'): readonly TaskId[] {
    return [...this.settings.suite.tasks.values()].filter(task => task.split === split).map(task => task.id)
  }

  private trialDirectory(job: EvaluationJobId, task: TaskId, trial: number): string {
    return join(this.settings.runRoot, 'trials', job, task, String(trial))
  }

  /**
   * Run one trial unless its result is stored; a runtime failure yields the failure.
   * `patch` is the JSON copy of the checked overlay, written beside the trial's workspace.
   */
  private async trial(
    request: EvaluationRequest,
    taskId: TaskId,
    trial: number,
    patch: string | undefined,
  ): Promise<TrialResult | { readonly failure: string }> {
    const stored = await this.readResult(request.job, taskId, trial)
    if (stored !== undefined) return stored
    const task = this.settings.suite.tasks.get(taskId)
    if (task === undefined) throw new Error(`self-improve suite has no task ${taskId}`)
    const directory = this.trialDirectory(request.job, taskId, trial)
    await mkdir(this.settings.scratch, { recursive: true })
    const scratch = await mkdtemp(join(this.settings.scratch, 'trial-'))
    try {
      const workspace = join(scratch, 'workspace')
      const home = join(scratch, 'home')
      const agentsHome = join(scratch, 'agents')
      const temp = join(scratch, 'tmp')
      await (task.workspace === undefined ? mkdir(workspace) : cp(task.workspace, workspace, { recursive: true }))
      await mkdir(home)
      await mkdir(agentsHome)
      await mkdir(temp)
      const evolved = join(request.root, this.settings.evolvedDirectory)
      await copyIfPresent(join(evolved, 'AGENTS.md'), join(home, 'AGENTS.md'))
      await copyIfPresent(join(evolved, 'skills'), join(home, 'skills'))
      const overlay = join(scratch, OVERLAY_FILE)
      if (patch !== undefined) await writeFile(overlay, patch, { mode: 0o600 })
      const launch: TrialLaunch = {
        profile: this.settings.profile,
        patches: [...patch === undefined ? [] : [overlay], ...this.settings.policyPatches],
        home,
        cwd: workspace,
        provider: this.settings.provider,
        model: this.settings.model,
        env: { ...this.settings.environment(), DSH_AGENTS_HOME: agentsHome },
        timeoutMs: this.settings.trialTimeoutMs,
        shutdownTimeoutMs: this.settings.shutdownTimeoutMs,
      }
      const record = await runTrial(launch, task.prompt, request.signal)
      await writeJson(join(directory, 'record.json'), record)
      if (record.failure !== undefined) return { failure: record.failure }
      const runner = this.settings.checkRunner({ workspace: await realpath(workspace), temp: await realpath(temp) })
      let checks: readonly CheckResult[]
      try {
        checks = await runChecks(task, finalResponse(record), workspace, runner, request.signal)
      } catch (error) {
        // A trial whose checks cannot be graded under confinement is errored, and the measurement stops with the reason.
        if (error instanceof GradingRefused) await writeJson(join(directory, 'record.json'), { ...record, failure: error.message })
        throw error
      }
      const result: TrialResult = {
        reward: checks.filter(check => check.passed).length / checks.length,
        tokens: trialTokens(record.events),
        firstRequestInputTokens: firstRequestInputTokens(record),
        checks,
      }
      await writeJson(join(directory, 'result.json'), {
        ...result,
        tokens: result.tokens ?? null,
        firstRequestInputTokens: result.firstRequestInputTokens ?? null,
      })
      return result
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  }

  private async readResult(job: EvaluationJobId, task: TaskId, trial: number): Promise<TrialResult | undefined> {
    const path = join(this.trialDirectory(job, task, trial), 'result.json')
    const value = await readJson(path)
    if (value === undefined) return undefined
    const result = trialResultOf(value)
    if (result === undefined) throw new Error(`${path} is not a self-improve trial result`)
    return result
  }

  private async readRecord(job: EvaluationJobId, task: TaskId, trial: number): Promise<TrialRecord | undefined> {
    const path = join(this.trialDirectory(job, task, trial), 'record.json')
    const value = await readJson(path)
    if (value === undefined) return undefined
    const record = trialRecordOf(value)
    if (record === undefined) throw new Error(`${path} is not a self-improve trial record`)
    return record
  }
}

/**
 * Run `work` over `items` with at most `width` in flight, in order. After a
 * failure no further item starts, and the first failure rejects once every
 * started item settled.
 * @param items - the work items.
 * @param width - most items in flight.
 * @param work - the work for one item.
 * @returns the results, in item order.
 */
export async function pool<T, R>(items: readonly T[], width: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = []
  const pending = items.entries()
  let failure: { readonly error: unknown } | undefined
  const worker = async (): Promise<void> => {
    for (const [index, item] of pending) {
      try {
        results[index] = await work(item)
      } catch (error) {
        failure ??= { error }
        return
      }
      if (failure !== undefined) return
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(width, items.length)) }, worker))
  if (failure !== undefined) throw failure.error
  return results
}

async function exists(path: string): Promise<boolean> {
  return await stat(path).then(() => true, () => false)
}

async function copyIfPresent(source: string, target: string): Promise<void> {
  if (await exists(source)) await cp(source, target, { recursive: true })
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return undefined
    throw error
  }
}

async function readJson(path: string): Promise<unknown> {
  const text = await readText(path)
  if (text === undefined) return undefined
  try {
    const value: unknown = JSON.parse(text)
    return value
  } catch (error) {
    throw new Error(`${path} is not JSON`, { cause: error })
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFileAtomic(path, `${JSON.stringify(value)}\n`, { mode: 0o600, dirMode: 0o700 })
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function countOf(value: unknown): number | undefined | false {
  if (value === null) return undefined
  return typeof value === 'number' && Number.isFinite(value) ? value : false
}

function trialResultOf(value: unknown): TrialResult | undefined {
  if (!isRecord(value) || typeof value['reward'] !== 'number' || !Array.isArray(value['checks'])) return undefined
  const tokens = countOf(value['tokens'])
  const firstRequest = countOf(value['firstRequestInputTokens'])
  if (tokens === false || firstRequest === false) return undefined
  const checks: CheckResult[] = []
  for (const check of value['checks']) {
    if (!isRecord(check) || typeof check['check'] !== 'string' || typeof check['passed'] !== 'boolean') return undefined
    const detail = check['detail']
    if (detail !== undefined && typeof detail !== 'string') return undefined
    checks.push({ check: check['check'], passed: check['passed'], ...detail === undefined ? {} : { detail } })
  }
  return { reward: value['reward'], tokens, firstRequestInputTokens: firstRequest, checks }
}

function trialRecordOf(value: unknown): TrialRecord | undefined {
  if (!isRecord(value) || typeof value['sessionId'] !== 'string' || !Array.isArray(value['events'])) return undefined
  const failure = value['failure']
  if (failure !== undefined && typeof failure !== 'string') return undefined
  const events: TrialEvent[] = []
  for (const entry of value['events']) {
    if (!isRecord(entry) || typeof entry['sessionId'] !== 'string') return undefined
    events.push({ sessionId: entry['sessionId'], event: validatedSessionEvent(entry['event']) })
  }
  return { sessionId: value['sessionId'], events, ...failure === undefined ? {} : { failure } }
}
