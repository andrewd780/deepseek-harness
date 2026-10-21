/**
 * The context window an Ollama server serves a loaded model with, learned
 * from its process listing (`GET {root}/api/ps`).
 *
 * Ollama sizes a model's window when it loads the model — from the Modelfile's
 * `num_ctx`, `OLLAMA_CONTEXT_LENGTH`, or a VRAM-tiered default it may lower
 * after a load failure — and its OpenAI-compatible chat API silently drops the
 * oldest messages of a request that does not fit. No Ollama API reports that
 * window before the model loads; the process listing reports it while the
 * model stays loaded. A route window configured or defaulted above the served
 * one therefore lets Ollama truncate before compaction ever runs.
 *
 * One probe ends three ways. A process listing records each loaded model's
 * window as learned. A reply that is not a process listing (404 and other
 * 4xx, a redirect, any other body) marks the route as having none until its
 * configuration changes. A transient failure (network, timeout, 5xx, 408, 429,
 * an unresolvable credential) changes nothing, and the next call probes again.
 * Learned windows stay in memory for the tracker's lifetime, so a model Ollama
 * unloaded keeps its last observed window; the latest observation wins.
 *
 * @module dsh-llm-pi-ai/served-context
 */

import { LlmError } from '@deepseek-ai/dsh-llm'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { ResolvedPiAiProviderProfile } from './config.ts'
import { endpointHeaders, readBounded } from './endpoint.ts'

/** Where and for how long to probe one route; resolved from its profile. */
export interface ServedContextProbe {
  /** Process-listing URL: the route's endpoint root followed by `/api/ps`. */
  readonly url: string
  /** The route's wire protocol, which decides its credential header. */
  readonly api: string
  /** Positive bound on one probe in milliseconds. */
  readonly timeoutMs: number
}

/** What the tracker needs from the adapter that owns it. */
export interface ServedContextTrackerOptions {
  /** Resolve the route's credential; a rejection counts as a transient probe failure. */
  readonly resolveApiKey: (provider: string, profile: ResolvedPiAiProviderProfile) => Promise<string | undefined>
}

/** Failure code of a process listing larger than the endpoint reply bound. */
const OVERSIZED_LISTING_CODE = 'SERVED_CONTEXT_LISTING_TOO_LARGE'

/** How one probe ended. */
type ProbeOutcome =
  | { readonly kind: 'listing'; readonly windows: ReadonlyMap<string, number> }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unavailable' }

const ABSENT: ProbeOutcome = { kind: 'absent' }
const UNAVAILABLE: ProbeOutcome = { kind: 'unavailable' }

/** Narrow a parsed JSON value to an object record. */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Narrow a parsed JSON value to an array of unknown entries. */
function isArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value)
}

/**
 * Canonical spelling of an Ollama model name, so a configured model id and a
 * process-listing entry compare equal however each is written: lower case,
 * with Ollama's default registry, namespace, and tag filled in
 * (`qwen3` becomes `registry.ollama.ai/library/qwen3:latest`).
 * @param name - a model id as configured or as Ollama lists it.
 * @returns the canonical name, or `undefined` for an empty name, an empty tag
 * or path part, a digest reference, or more than three path parts.
 */
export function ollamaModelKey(name: string): string | undefined {
  const lower = name.toLowerCase()
  if (lower.length === 0 || lower.includes('@')) return undefined
  const slash = lower.lastIndexOf('/')
  const colon = lower.lastIndexOf(':')
  const path = colon > slash ? lower.slice(0, colon) : lower
  const tag = colon > slash ? lower.slice(colon + 1) : 'latest'
  const parts = path.split('/')
  if (tag.length === 0 || parts.some(part => part.length === 0)) return undefined
  switch (parts.length) {
    case 1:
      return `registry.ollama.ai/library/${path}:${tag}`
    case 2:
      return `registry.ollama.ai/${path}:${tag}`
    case 3:
      return `${path}:${tag}`
    default:
      return undefined
  }
}

/**
 * Each loaded model's served window in a process-listing reply, keyed by
 * {@link ollamaModelKey}. An entry is named by `model`, else `name`, and
 * counts only with a positive safe-integer `context_length`, which Ollama
 * versions before that field omit; a model listed twice keeps its smaller
 * window.
 * @param body - the parsed reply.
 * @returns the windows, or `undefined` when the reply is not a process listing.
 */
export function loadedModelWindows(body: unknown): ReadonlyMap<string, number> | undefined {
  if (!isRecord(body)) return undefined
  const models = body['models']
  if (!isArray(models)) return undefined
  const windows = new Map<string, number>()
  for (const entry of models) {
    if (!isRecord(entry)) continue
    const model = entry['model']
    const name = typeof model === 'string' ? model : entry['name']
    const contextLength = entry['context_length']
    if (typeof name !== 'string' || typeof contextLength !== 'number'
      || !Number.isSafeInteger(contextLength) || contextLength <= 0) continue
    const key = ollamaModelKey(name)
    if (key === undefined) continue
    const known = windows.get(key)
    windows.set(key, known === undefined ? contextLength : Math.min(known, contextLength))
  }
  return windows
}

/** Whether a non-200 status may change on its own, so the route is probed again. */
function isTransientStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500
}

/**
 * Start or join `work` and wait for it, or reject with `ABORTED` once `signal`
 * aborts. An already-aborted caller starts nothing; otherwise the work keeps
 * running for its other waiters, and it must not reject.
 */
function settleUnlessAborted<T>(work: () => Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return work()
  const aborted = (): LlmError =>
    new LlmError('served-context probe aborted by caller', 'ABORTED', { cause: signal.reason })
  if (signal.aborted) return Promise.reject(aborted())
  const pending = work()
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => { reject(aborted()) }
    signal.addEventListener('abort', onAbort, { once: true })
    void pending.then((value) => {
      signal.removeEventListener('abort', onAbort)
      resolve(value)
    })
  })
}

/**
 * Learns and remembers the windows Ollama serves on routes whose profile
 * resolved a {@link ServedContextProbe}. Concurrent probes of one route share
 * one request, bounded by the route's probe timeout and by {@link dispose}.
 */
export class ServedContextTracker {
  private readonly absent = new WeakSet<ResolvedPiAiProviderProfile>()
  private readonly inFlight = new Map<string, Promise<ProbeOutcome>>()
  private readonly windows = new Map<string, number>()
  private readonly lifetime = new AbortController()

  constructor(private readonly options: ServedContextTrackerOptions) {}

  /**
   * Probe the route's endpoint for the window it serves `model` with.
   * @param profile - the route's resolved profile.
   * @param model - the model id the route sends.
   * @param signal - cancellation for this caller only; the shared probe continues.
   * @returns the served window; the last learned one while the model is not
   * loaded or the probe failed transiently; `undefined` when the route has no
   * probe, has no process listing, or nothing is known yet.
   * @throws LlmError `ABORTED` when `signal` aborts first; probe failures are absorbed.
   */
  async observe(profile: ResolvedPiAiProviderProfile, model: string, signal?: AbortSignal): Promise<number | undefined> {
    const probe = profile.servedContextProbe
    const key = ollamaModelKey(model)
    if (probe === undefined || key === undefined || this.absent.has(profile)) return undefined
    const outcome = await settleUnlessAborted(() => this.shared(profile, probe), signal)
    switch (outcome.kind) {
      case 'absent':
        this.absent.add(profile)
        return undefined
      case 'unavailable':
        break
      case 'listing': {
        const served = outcome.windows.get(key)
        if (served !== undefined) this.windows.set(windowKey(profile, probe, key), served)
        break
      }
      /* v8 ignore next -- closed-union exhaustiveness guard */
      default:
        assertNever(outcome, 'served-context probe outcome')
    }
    return this.learned(profile, model)
  }

  /**
   * The window last learned for `model` on this route, without probing.
   * @param profile - the route's resolved profile.
   * @param model - the model id the route sends.
   * @returns the learned window, or `undefined` when none is known.
   */
  learned(profile: ResolvedPiAiProviderProfile, model: string): number | undefined {
    const probe = profile.servedContextProbe
    const key = ollamaModelKey(model)
    if (probe === undefined || key === undefined || this.absent.has(profile)) return undefined
    return this.windows.get(windowKey(profile, probe, key))
  }

  /** Abort every probe in flight; later probes fail transiently at once. */
  dispose(): void {
    this.lifetime.abort('served-context tracker disposed')
  }

  /** Join the probe in flight for this route, or start one. */
  private shared(profile: ResolvedPiAiProviderProfile, probe: ServedContextProbe): Promise<ProbeOutcome> {
    const key = `${profile.provider}\u0000${probe.url}`
    const pending = this.inFlight.get(key)
    if (pending !== undefined) return pending
    const started = this.probeOnce(profile, probe).finally(() => { this.inFlight.delete(key) })
    this.inFlight.set(key, started)
    return started
  }

  /** One probe request; every failure becomes an outcome, so the promise never rejects. */
  private async probeOnce(profile: ResolvedPiAiProviderProfile, probe: ServedContextProbe): Promise<ProbeOutcome> {
    let apiKey: string | undefined
    try {
      apiKey = await this.options.resolveApiKey(profile.provider, profile)
    } catch {
      // A credential the route names but cannot resolve stops its model
      // requests too; the window stays unknown until a later call resolves it.
      return UNAVAILABLE
    }
    const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(probe.timeoutMs)])
    let response: Response
    try {
      response = await fetch(probe.url, {
        method: 'GET',
        headers: endpointHeaders(probe.api, apiKey, profile.headers),
        // A redirect could carry the route's credential to another origin.
        redirect: 'manual',
        signal,
      })
    } catch {
      // Unreachable, timed out, or disposed: nothing is learned, and the next
      // call probes again.
      return UNAVAILABLE
    }
    if (response.status !== 200) {
      /* v8 ignore next 3 -- cancel() of an unread body settles without rejecting; unobserved best-effort cleanup. */
      await response.body?.cancel().catch(() => {
        // Discarding an unread error body is cleanup; the status already decided the outcome.
      })
      return isTransientStatus(response.status) ? UNAVAILABLE : ABSENT
    }
    let text: string
    try {
      text = await readBounded(response, probe.url, OVERSIZED_LISTING_CODE)
    } catch (error: unknown) {
      return error instanceof LlmError && error.code === OVERSIZED_LISTING_CODE ? ABSENT : UNAVAILABLE
    }
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      // A body that is not JSON is not a process listing.
      return ABSENT
    }
    const windows = loadedModelWindows(body)
    return windows === undefined ? ABSENT : { kind: 'listing', windows }
  }
}

/** Learned-window key: the route, its probe URL, and the canonical model name. */
function windowKey(profile: ResolvedPiAiProviderProfile, probe: ServedContextProbe, model: string): string {
  return `${profile.provider}\u0000${probe.url}\u0000${model}`
}
