/**
 * One trial: a fresh dsh runtime, launched through the SDK client with the
 * candidate's profile patches, working one task to completion.
 *
 * The SDK client spawns the runtime itself, the subprocess seam's documented
 * exception for SDK-managed transports, so the child environment starts from
 * the seam's scrubbed parent environment. A trial's tokens are the exact
 * per-turn totals of every Session in the runtime's tree; one turn whose
 * usage cannot be proven leaves the trial's tokens unreported.
 *
 * @module @deepseek-ai/dsh-experimental-self-improve/trial
 */

import { randomUUID } from 'node:crypto'

import { DeepSeekHarness, validatedSessionEvent } from '@deepseek-ai/dsh-sdk-client'
import type { DeepSeekHarnessOptions } from '@deepseek-ai/dsh-sdk-client'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { deadline } from '@deepseek-ai/dsh-timeout'
import { deriveTurnTokenUsage } from '@deepseek-ai/dsh-token-meter/client'

/** The code on a trial's timeout reason. */
export const TRIAL_TIMEOUT_CODE = 'SELF_IMPROVE_TRIAL_TIMEOUT'

/** How one trial's runtime starts. */
export interface TrialLaunch {
  readonly profile: string
  /** Profile patches in application order: the candidate's overlay, then the frozen policy patches. */
  readonly patches: readonly string[]
  /** Absolute, fresh Harness home for this trial. */
  readonly home: string
  /** Absolute working directory holding the task's files. */
  readonly cwd: string
  readonly provider: string
  readonly model: string
  /** Variables added over the scrubbed parent environment, such as the policy's credential. */
  readonly env: Readonly<Record<string, string>>
  /** Bound on the whole trial; `0` sets none. */
  readonly timeoutMs: number
  readonly shutdownTimeoutMs: number
}

/** One event of the trial's Session tree. */
export interface TrialEvent {
  readonly sessionId: string
  readonly event: SessionEvent
}

/** What one trial left behind. */
export interface TrialRecord {
  readonly sessionId: string
  readonly events: readonly TrialEvent[]
  /** Why the trial produced no result, when it failed before its tasks were judged. */
  readonly failure?: string
}

/** Test seam for the runtime's construction. */
export const internals: { createHarness(options: DeepSeekHarnessOptions): DeepSeekHarness } = {
  createHarness: options => new DeepSeekHarness(options),
}

/**
 * Run one task in a fresh runtime. A runtime that fails or times out yields a
 * record carrying the failure; cancellation of `signal` rejects.
 * @param launch - the runtime's profile, patches, home, directory, route, environment, and bounds.
 * @param prompt - the task's prompt.
 * @param signal - cancellation of the whole run.
 * @returns the Session tree's events, and the failure when there is one.
 */
export async function runTrial(launch: TrialLaunch, prompt: string, signal?: AbortSignal): Promise<TrialRecord> {
  const sessionId = `session-${randomUUID().replaceAll('-', '')}`
  const harness = internals.createHarness({
    profile: launch.profile,
    patches: [...launch.patches],
    dshHome: launch.home,
    processCwd: launch.cwd,
    cwd: launch.cwd,
    env: { ...scrubbedParentEnv(), ...launch.env },
    shutdownTimeoutMs: launch.shutdownTimeoutMs,
    provider: launch.provider,
    model: launch.model,
  })
  const events: TrialEvent[] = []
  let failure: string | undefined
  using trialDeadline = deadline(signal, launch.timeoutMs, TRIAL_TIMEOUT_CODE)
  try {
    await settleBefore(harness.start(), trialDeadline.signal)
    const subscription = harness.client.subscribeSessionTree(sessionId)
    try {
      await settleBefore(harness.session(sessionId).setWorkingDirectory(launch.cwd), trialDeadline.signal)
      await settleBefore(harness.client.prompt(sessionId, [{ type: 'text', text: prompt }]), trialDeadline.signal)
      await settleBefore(harness.client.request('session/wait', { sessionId }), trialDeadline.signal)
    } finally {
      for (let notification = subscription.tryNext(); notification !== undefined; notification = subscription.tryNext()) {
        const params = notification.params
        if (notification.method === 'session.event' && typeof params.sessionId === 'string') {
          events.push({ sessionId: params.sessionId, event: validatedSessionEvent(params.event) })
        }
      }
      subscription.close()
    }
  } catch (error) {
    signal?.throwIfAborted()
    failure = error instanceof Error ? error.message : String(error)
  } finally {
    await harness.close()
  }
  return { sessionId, events, ...failure === undefined ? {} : { failure } }
}

/**
 * Exact tokens of every turn of every Session in the trial.
 * @param events - the trial's events.
 * @returns the total, or `undefined` when no turn ended or one turn's usage cannot be proven.
 */
export function trialTokens(events: readonly TrialEvent[]): number | undefined {
  let total = 0
  let turns = 0
  for (const sessionEvents of bySession(events).values()) {
    let turn: SessionEvent[] = []
    for (const event of sessionEvents) {
      if (event.type === 'turn/start') turn = []
      turn.push(event)
      if (event.type !== 'turn/end') continue
      const usage = deriveTurnTokenUsage(turn)
      if (usage === undefined) return undefined
      total += usage.totalTokens
      turns += 1
      turn = []
    }
  }
  return turns === 0 ? undefined : total
}

/**
 * Prompt tokens of the root Session's first model request: the fixed prompt plus the task's prompt.
 * @param record - the trial.
 * @returns the count, or `undefined` when the first request reported no usage.
 */
export function firstRequestInputTokens(record: TrialRecord): number | undefined {
  for (const { sessionId, event } of record.events) {
    if (sessionId !== record.sessionId || event.type !== 'assistant/message') continue
    const usage = event.data.usage
    if (usage === undefined) return undefined
    return usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
  }
  return undefined
}

/**
 * The root Session's last assistant text.
 * @param record - the trial.
 * @returns the text, empty when the root Session wrote none.
 */
export function finalResponse(record: TrialRecord): string {
  let response = ''
  for (const { sessionId, event } of record.events) {
    if (sessionId !== record.sessionId || event.type !== 'assistant/message') continue
    const text = textOf(event.data.message.content)
    if (text.length > 0) response = text
  }
  return response
}

/**
 * Render a trial's events for the analyst and the proposer.
 * @param record - the trial.
 * @param maxBlockCharacters - longest rendering of one message or tool payload.
 * @returns one line or paragraph per message, tool call, tool result, and turn end.
 */
export function renderTrial(record: TrialRecord, maxBlockCharacters: number): string {
  const clip = (text: string): string => (text.length <= maxBlockCharacters
    ? text
    : `${text.slice(0, maxBlockCharacters)} ...[${text.length - maxBlockCharacters} more characters]`)
  const lines: string[] = []
  for (const { sessionId, event } of record.events) {
    const session = sessionId === record.sessionId ? '' : `(${sessionId}) `
    switch (event.type) {
      case 'user/message':
        lines.push(`${session}[user] ${clip(textOf(event.data.content))}`)
        break
      case 'assistant/message':
        lines.push(`${session}[assistant] ${clip(textOf(event.data.message.content))}`)
        break
      case 'tool/call':
        lines.push(`${session}[tool call] ${event.data.name} ${clip(event.data.arguments)}`)
        break
      case 'tool/result':
        lines.push(`${session}[tool result${event.data.message.isError === true ? ', error' : ''}] ${clip(textOf(event.data.message.content))}`)
        break
      case 'turn/end':
        lines.push(`${session}[turn end] ${event.data.reason.kind}`)
        break
      default:
        // Other events carry no conversation content for the trace.
        break
    }
  }
  if (record.failure !== undefined) lines.push(`[trial failed] ${record.failure}`)
  return lines.join('\n')
}

function bySession(events: readonly TrialEvent[]): ReadonlyMap<string, readonly SessionEvent[]> {
  const sessions = new Map<string, SessionEvent[]>()
  for (const { sessionId, event } of events) {
    const list = sessions.get(sessionId) ?? []
    list.push(event)
    sessions.set(sessionId, list)
  }
  return sessions
}

function textOf(content: readonly { readonly type: string }[]): string {
  return content
    .map(block => (block.type === 'text' && 'text' in block && typeof block.text === 'string' ? block.text : `[${block.type}]`))
    .join(' ')
}

/** Settle with `promise`, or reject with the signal's reason first; a later rejection of `promise` is observed. */
async function settleBefore<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  promise.catch((error: unknown) => {
    // The trial reports the abort; the transport's later rejection carries nothing new.
    void error
  })
  signal.throwIfAborted()
  return await new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      // Deadline and cancellation reasons are Errors.
      reject(signal.reason as Error)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort)
    })
  })
}
