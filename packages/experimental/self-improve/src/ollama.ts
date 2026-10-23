/**
 * Unloading a run's local model from an Ollama server. A server keeps a
 * loaded model's weights, its context, and a prefix cache of finished
 * requests resident between requests, and every trial and role stage adds
 * to that cache, so a job asks the server to unload the model after each of
 * them: it lists the loaded models (`GET /api/ps`), asks for an unload only
 * when the model is listed (`POST /api/generate` with `keep_alive: 0`, which
 * never loads a model), and waits, bounded, until the listing no longer
 * holds it. A server that does not answer `/api/ps` with a model listing is
 * not an Ollama server, and gets no unloads.
 *
 * @module @deepseek-ai/dsh-experimental-self-improve/ollama
 */

import { readFile } from 'node:fs/promises'

import { parse } from 'yaml'

/** A model and the Ollama server it runs on. */
export interface LocalRoute {
  /** The server's root URL, without the OpenAI-compatible `/v1` suffix. */
  readonly origin: string
  readonly model: string
}

/** How long an unload may take. */
export interface UnloadSettings {
  /** Bound on each request and on the wait for the model to leave the listing. */
  readonly timeoutMs: number
  /** Time between two listings while waiting. */
  readonly pollMs: number
}

/** What an unload found and did. */
export type UnloadOutcome =
  | { readonly status: 'unloaded'; readonly milliseconds: number }
  | { readonly status: 'not-loaded' }
  | { readonly status: 'still-loaded' }

/** The server at a route does not answer `/api/ps` the way an Ollama server does. */
export class NotOllama extends Error {
  override readonly name = 'NotOllama'
}

/** Requests the unload makes; the global `fetch` by default. */
export type Fetch = (input: string, init?: RequestInit) => Promise<Response>

/**
 * The server root of an OpenAI-compatible base URL.
 * @param baseUrl - a provider's `baseURL`, such as `http://localhost:11434/v1`.
 * @returns the URL without a trailing `/v1` and slash, such as `http://localhost:11434`.
 */
export function ollamaOrigin(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')
}

/**
 * The base URL the run's frozen policy patches give a provider: the `baseURL` under `providers.<provider>` of the
 * last `llm-pi-ai` entry that sets one.
 * @param patches - absolute paths of the policy patches, in order.
 * @param provider - the trials' provider key.
 * @returns the base URL, or `undefined` when no patch sets one.
 */
export async function policyBaseUrl(patches: readonly string[], provider: string): Promise<string | undefined> {
  let found: string | undefined
  for (const path of patches) {
    const entries: unknown = parse(await readFile(path, 'utf8'), { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] })
    for (const entry of Array.isArray(entries) ? entries : []) {
      const baseUrl = at(entry, 'id') === 'llm-pi-ai' ? at(at(at(at(entry, 'config'), 'providers'), provider), 'baseURL') : undefined
      if (typeof baseUrl === 'string') found = baseUrl
    }
  }
  return found
}

/**
 * Unload a model when the server holds it, and wait until it no longer does.
 * @param route - the server and the model.
 * @param settings - the request bound and the listing interval.
 * @param fetchFn - the request function.
 * @returns whether the model was unloaded, was not loaded, or is still listed when the bound ran out.
 * @throws NotOllama when the server does not answer `/api/ps` with a model listing; Error when a request fails.
 */
export async function unloadOllamaModel(route: LocalRoute, settings: UnloadSettings, fetchFn: Fetch = fetch): Promise<UnloadOutcome> {
  const started = Date.now()
  if (!await listed(route, settings, fetchFn)) return { status: 'not-loaded' }
  const response = await fetchFn(`${route.origin}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: route.model, keep_alive: 0 }),
    signal: AbortSignal.timeout(settings.timeoutMs),
  })
  await response.arrayBuffer()
  if (!response.ok) throw new Error(`POST ${route.origin}/api/generate answered ${response.status}`)
  while (await listed(route, settings, fetchFn)) {
    if (Date.now() - started >= settings.timeoutMs) return { status: 'still-loaded' }
    await new Promise(resolve => setTimeout(resolve, settings.pollMs))
  }
  return { status: 'unloaded', milliseconds: Date.now() - started }
}

/** Whether the server's listing of loaded models holds the route's model. */
async function listed(route: LocalRoute, settings: UnloadSettings, fetchFn: Fetch): Promise<boolean> {
  const response = await fetchFn(`${route.origin}/api/ps`, { signal: AbortSignal.timeout(settings.timeoutMs) })
  const body: unknown = await response.json().catch(() => undefined)
  const models = at(body, 'models')
  // Only a missing endpoint or an answer that is no listing marks a server that is not Ollama; any other failure,
  // such as a proxy's 502, may pass, so the next unload tries again.
  if (!response.ok && response.status !== 404) throw new Error(`GET ${route.origin}/api/ps answered ${response.status}`)
  if (!Array.isArray(models)) throw new NotOllama(`${route.origin} does not answer /api/ps with a model listing`)
  const names = new Set([route.model, route.model.includes(':') ? route.model : `${route.model}:latest`])
  return models.some(entry => names.has(String(at(entry, 'name'))) || names.has(String(at(entry, 'model'))))
}

function at(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
