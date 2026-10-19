/**
 * Requests to a route's own endpoint beside its inference API: the model
 * listing that discovery reads and the process listing that served-context
 * probing reads. Both address the same root, send the same headers, and bound
 * replies the same way.
 *
 * @module dsh-llm-pi-ai/endpoint
 */

import { attributionHeaders, LlmError } from '@deepseek-ai/dsh-llm'

/**
 * Protocols whose endpoints this module can address. OpenAI protocols use
 * bearer auth; Anthropic Messages uses `x-api-key` and `anthropic-version`.
 * Azure is absent despite its OpenAI lineage — it authenticates with an
 * `api-key` header and requires an `api-version` query — and Codex
 * authenticates through OAuth; guessing at either would report an
 * authentication failure as a provider with no models. pi-ai's remaining
 * protocols are absent for the same reason.
 */
export const LISTABLE_PROTOCOLS: ReadonlySet<string> = new Set([
  'anthropic-messages',
  'openai-completions',
  'openai-responses',
])

/** Stable API version required by Anthropic's model-listing endpoint. */
const ANTHROPIC_VERSION = '2023-06-01'

/**
 * Endpoint replies larger than this are refused. The endpoint is whatever URL
 * the user typed, so the ceiling holds on the bytes actually read rather than
 * on the length the server claims — the same two-stage shape `dsh-web-fetch`
 * uses for its own caller-supplied URLs, except that a truncated listing is
 * not parseable, so overflow rejects instead of truncating.
 */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024

/**
 * The endpoint root: the base URL without trailing slashes and without one
 * trailing `/v1` segment. Gateway documentation publishes both spellings of
 * the same root, and the base is treated as a prefix rather than a URL to
 * resolve against, so a deployment path such as
 * `https://gateway.example/openai/v1` keeps its other segments.
 * @param baseURL - the route's configured endpoint.
 * @returns the root that native listing paths are appended to.
 */
export function endpointRoot(baseURL: string): string {
  const base = baseURL.replace(/\/+$/, '')
  return base.endsWith('/v1') ? base.slice(0, -3) : base
}

/**
 * Headers for one request to a route's own endpoint: the deployment's stored
 * headers, a JSON `accept`, the protocol's credential header when a key is
 * known, and Harness attribution, which wins collisions.
 * @param api - the route's wire protocol.
 * @param apiKey - a usable credential, or `undefined` to send none.
 * @param headers - deployment headers configured on the route.
 * @returns the headers to send.
 * @throws TypeError when a configured header cannot be carried by Fetch.
 */
export function endpointHeaders(
  api: string,
  apiKey: string | undefined,
  headers: Readonly<Record<string, string>> | undefined,
): Headers {
  const result = new Headers(headers === undefined ? undefined : Object.entries(headers))
  result.set('accept', 'application/json')
  if (api === 'anthropic-messages') {
    result.set('anthropic-version', ANTHROPIC_VERSION)
    if (apiKey !== undefined) result.set('x-api-key', apiKey)
  } else if (apiKey !== undefined) {
    result.set('authorization', `Bearer ${apiKey}`)
  }
  for (const [name, value] of Object.entries(attributionHeaders())) result.set(name, value)
  return result
}

/**
 * Read a reply body, refusing one that outgrows the ceiling. A declared length
 * is checked first so an honest server is turned away without transferring
 * anything; the accumulated total is what actually enforces the bound, because
 * a server that under-declares (or streams) tells us nothing up front.
 * @param response - a 2xx reply whose body has not been read.
 * @param url - the requested URL, for the failure message.
 * @param failureCode - the `LlmError` code an oversized reply fails with.
 * @returns the decoded body text.
 * @throws LlmError with `failureCode` when the body exceeds 4 MiB.
 */
export async function readBounded(response: Response, url: string, failureCode: string): Promise<string> {
  const oversized = (): LlmError =>
    new LlmError(`${url} answered with more than ${MAX_RESPONSE_BYTES} bytes`, failureCode)
  const declared = Number(response.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel()
    throw oversized()
  }
  /* v8 ignore next -- fetch always exposes a body stream on a 2xx Response; the null guard is defensive. */
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_RESPONSE_BYTES) throw oversized()
      chunks.push(value)
    }
  } finally {
    /* v8 ignore next 4 -- cancel() after a completed or abandoned read settles without rejecting; unobserved best-effort cleanup. */
    await reader.cancel().catch(() => {
      // Cancel after a drained read, or after this function walked away from
      // an oversized one, is cleanup; the reply is already decided either way.
    })
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(body)
}
