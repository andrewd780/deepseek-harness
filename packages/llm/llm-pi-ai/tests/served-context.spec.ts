/** Learning the context window an Ollama endpoint serves, and holding requests to it. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  createSystemMessage,
  createUserMessage,
  LlmError,
  userAgent,
} from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { PiAiAdapter } from '../src/adapter.ts'
import { resolveProfiles } from '../src/config.ts'
import type { PiAiProviderProfile, ResolvedPiAiProviderProfile } from '../src/config.ts'
import { loadedModelWindows, ollamaModelKey, ServedContextTracker } from '../src/served-context.ts'
import { assemble } from './assemble.ts'
import { memoryAuth } from './auth-double.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'
import type { ProcessListingReply } from './mock-server.ts'

afterEach(async () => {
  vi.unstubAllEnvs()
  await closeMockServers()
})

const MODEL = 'qwen3:32b'

/** One loaded model as Ollama's process listing reports it. */
function loaded(name: string, contextLength: unknown): Record<string, unknown> {
  return { name, model: name, size: 1, context_length: contextLength }
}

function listing(...models: unknown[]): ProcessListingReply {
  return { body: JSON.stringify({ models }) }
}

/** The resolved profile of one declared Ollama-style route. */
function profileFor(baseURL: string, overrides: Partial<PiAiProviderProfile> = {}): ResolvedPiAiProviderProfile {
  const profile = resolveProfiles({
    ollama: { api: 'openai-completions', baseURL, models: [{ id: MODEL }], ...overrides },
  }).get('ollama')
  if (profile === undefined) throw new Error('profile did not resolve')
  return profile
}

function tracker(apiKey?: string): ServedContextTracker {
  return new ServedContextTracker({ resolveApiKey: () => Promise.resolve(apiKey) })
}

describe('served-context probe resolution', () => {
  it('probes a declared route at its endpoint root with the default bound', () => {
    expect(profileFor('http://ollama.test:11434/v1/').servedContextProbe).toEqual({
      url: 'http://ollama.test:11434/api/ps',
      api: 'openai-completions',
      timeoutMs: 5_000,
    })
    expect(profileFor('http://gpu.test/ollama', { api: 'anthropic-messages', servedContextProbeTimeoutMs: 250 })
      .servedContextProbe).toEqual({ url: 'http://gpu.test/ollama/api/ps', api: 'anthropic-messages', timeoutMs: 250 })
  })

  it('does not probe a route that turns probing off, a catalog route, or a route without a usable endpoint', () => {
    expect(profileFor('http://ollama.test/v1', { servedContextProbe: 'off' }).servedContextProbe).toBeUndefined()
    const routes = resolveProfiles({
      deepseek: { api: 'openai-completions', baseURL: 'http://ollama.test/v1' },
      unnamed: { baseURL: 'http://ollama.test/v1', models: [{ id: MODEL }] },
      foreign: { api: 'foreign-protocol', baseURL: 'http://ollama.test/v1', models: [{ id: MODEL }] },
    }, 'deferred')
    expect(routes.get('deepseek')?.servedContextProbe).toBeUndefined()
    expect(routes.get('unnamed')?.servedContextProbe).toBeUndefined()
    expect(routes.get('foreign')?.servedContextProbe).toBeUndefined()
    expect(resolveProfiles({ local: { api: 'openai-completions', models: [{ id: MODEL }] } }, 'deferred')
      .get('local')?.servedContextProbe).toBeUndefined()
  })

  it.each([0, -1, Number.POSITIVE_INFINITY, 2 ** 31])('rejects probe bound %s', (servedContextProbeTimeoutMs) => {
    expect(() => profileFor('http://ollama.test/v1', { servedContextProbeTimeoutMs }))
      .toThrow(/servedContextProbeTimeoutMs must be a positive finite number/)
  })

  it('rejects an unknown probe setting', () => {
    expect(() => profileFor('http://ollama.test/v1', { servedContextProbe: 'always' as never }))
      .toThrow(/servedContextProbe must be "auto" or "off"/)
  })
})

describe('Ollama model names', () => {
  it.each([
    ['qwen3', 'registry.ollama.ai/library/qwen3:latest'],
    ['Qwen3:32B', 'registry.ollama.ai/library/qwen3:32b'],
    ['library/qwen3:32b', 'registry.ollama.ai/library/qwen3:32b'],
    ['registry.ollama.ai/library/qwen3:32b', 'registry.ollama.ai/library/qwen3:32b'],
    ['hf.co/unsloth/Qwen3-8B-GGUF:Q4_K_M', 'hf.co/unsloth/qwen3-8b-gguf:q4_k_m'],
    ['mirror.test:5000/team/coder', 'mirror.test:5000/team/coder:latest'],
  ])('spells %s canonically', (name, key) => {
    expect(ollamaModelKey(name)).toBe(key)
  })

  it.each(['', 'qwen3:', 'team//coder', 'qwen3@sha256:abc', 'a/b/c/d'])('has no key for %j', (name) => {
    expect(ollamaModelKey(name)).toBeUndefined()
  })
})

describe('process listing replies', () => {
  it.each([null, [], 'models', {}, { models: {} }])('rejects %j as a process listing', (body) => {
    expect(loadedModelWindows(body)).toBeUndefined()
  })

  it('keys valid entries canonically, prefers model over name, and keeps the smaller duplicate', () => {
    expect(loadedModelWindows({
      models: [
        loaded('qwen3:32b', 32_768),
        { model: 'Qwen3:32B', name: 'ignored', context_length: 16_384 },
        { name: 'llama3', context_length: 8_192 },
        { model: 7, name: 'gemma3', context_length: 4_096 },
        'not an entry',
        loaded('no-length', undefined),
        loaded('zero', 0),
        loaded('fraction', 1.5),
        loaded('text', '4096'),
        loaded('qwen3@sha256:abc', 2_048),
      ],
    })).toEqual(new Map([
      ['registry.ollama.ai/library/qwen3:32b', 16_384],
      ['registry.ollama.ai/library/llama3:latest', 8_192],
      ['registry.ollama.ai/library/gemma3:latest', 4_096],
    ]))
  })
})

describe('ServedContextTracker', () => {
  it('learns a loaded model, keeps the window while it is unloaded, and takes the latest observation', async () => {
    const replies = [listing(loaded(MODEL, 32_768)), listing(), listing(loaded('qwen3:32b', 8_192))]
    const server = await mockServer([], { processListing: () => replies.shift() ?? listing() })
    const subject = tracker()
    const profile = profileFor(`${server.url}/v1`)

    expect(subject.learned(profile, MODEL)).toBeUndefined()
    await expect(subject.observe(profile, MODEL)).resolves.toBe(32_768)
    await expect(subject.observe(profile, MODEL)).resolves.toBe(32_768)
    await expect(subject.observe(profile, 'QWEN3:32B')).resolves.toBe(8_192)
    expect(subject.learned(profile, MODEL)).toBe(8_192)
    expect(server.probes).toHaveLength(3)
    expect(server.paths).toEqual([])
  })

  it.each<[string, ProcessListingReply]>([
    ['404', { status: 404 }],
    ['401', { status: 401 }],
    ['a redirect', { status: 302 }],
    ['a body that is not JSON', { body: 'ollama is running' }],
    ['JSON without a models array', { body: '{"version":"0.12.0"}' }],
    ['an oversized listing', { body: 'x'.repeat(4 * 1024 * 1024 + 1) }],
  ])('stops probing a route that answers with %s until its profile changes', async (_name, reply) => {
    const server = await mockServer([], { processListing: reply })
    const subject = tracker()
    const profile = profileFor(`${server.url}/v1`)

    await expect(subject.observe(profile, MODEL)).resolves.toBeUndefined()
    await expect(subject.observe(profile, MODEL)).resolves.toBeUndefined()
    expect(subject.learned(profile, MODEL)).toBeUndefined()
    expect(server.probes).toHaveLength(1)

    await subject.observe(profileFor(`${server.url}/v1`), MODEL)
    expect(server.probes).toHaveLength(2)
  })

  it.each<[string, ProcessListingReply]>([
    ['500', { status: 500 }],
    ['429', { status: 429 }],
    ['408', { status: 408 }],
  ])('keeps the learned window and probes again after %s', async (_name, reply) => {
    const replies = [listing(loaded(MODEL, 32_768)), reply, reply]
    const server = await mockServer([], { processListing: () => replies.shift() ?? reply })
    const subject = tracker()
    const profile = profileFor(`${server.url}/v1`)

    await expect(subject.observe(profile, MODEL)).resolves.toBe(32_768)
    await expect(subject.observe(profile, MODEL)).resolves.toBe(32_768)
    await expect(subject.observe(profile, MODEL)).resolves.toBe(32_768)
    expect(server.probes).toHaveLength(3)
  })

  it('probes again after an unreachable endpoint, a timeout, or a stalled listing', async () => {
    const unreachable = profileFor('http://127.0.0.1:1/v1')
    const subject = tracker()
    await expect(subject.observe(unreachable, MODEL)).resolves.toBeUndefined()

    const slow = await mockServer([], { processListing: { delayMs: 1_000, body: '{"models":[]}' } })
    const stalled = await mockServer([], { processListing: { stallAfter: '{"models":[' } })
    for (const server of [slow, stalled]) {
      const profile = profileFor(`${server.url}/v1`, { servedContextProbeTimeoutMs: 50 })
      await expect(subject.observe(profile, MODEL)).resolves.toBeUndefined()
      await expect(subject.observe(profile, MODEL)).resolves.toBeUndefined()
      expect(server.probes).toHaveLength(2)
    }
  })

  it('treats a credential it cannot resolve as transient and sends nothing', async () => {
    const server = await mockServer([], { processListing: listing(loaded(MODEL, 32_768)) })
    const subject = new ServedContextTracker({
      resolveApiKey: () => Promise.reject(new LlmError('no credential', 'MISSING_CREDENTIAL')),
    })
    const profile = profileFor(`${server.url}/v1`)

    await expect(subject.observe(profile, MODEL)).resolves.toBeUndefined()
    await expect(subject.observe(profile, MODEL)).resolves.toBeUndefined()
    expect(server.probes).toEqual([])
  })

  it('shares one probe among concurrent callers and lets one caller abort alone', async () => {
    const server = await mockServer([], { processListing: { ...listing(loaded(MODEL, 32_768)), delayMs: 50 } })
    const subject = tracker()
    const profile = profileFor(`${server.url}/v1`)
    const leaving = new AbortController()

    const staying = subject.observe(profile, MODEL)
    const left = subject.observe(profile, MODEL, leaving.signal)
    leaving.abort(new Error('caller left'))

    await expect(left).rejects.toMatchObject({ code: 'ABORTED' })
    await expect(staying).resolves.toBe(32_768)
    await expect(subject.observe(profile, MODEL, new AbortController().signal)).resolves.toBe(32_768)
    expect(server.probes).toHaveLength(2)
  })

  it('rejects an already-aborted caller without probing', async () => {
    const server = await mockServer([], { processListing: listing(loaded(MODEL, 32_768)) })
    const signal = AbortSignal.abort(new Error('gone'))

    await expect(tracker().observe(profileFor(`${server.url}/v1`), MODEL, signal))
      .rejects.toMatchObject({ code: 'ABORTED' })
    expect(server.probes).toEqual([])
  })

  it('stops probes in flight and later probes once disposed', async () => {
    const server = await mockServer([], { processListing: { ...listing(loaded(MODEL, 32_768)), delayMs: 1_000 } })
    const subject = tracker()
    const profile = profileFor(`${server.url}/v1`)

    const pending = subject.observe(profile, MODEL)
    await vi.waitFor(() => { expect(server.probes).toHaveLength(1) })
    subject.dispose()

    await expect(pending).resolves.toBeUndefined()
    await expect(subject.observe(profile, MODEL)).resolves.toBeUndefined()
    expect(server.probes).toHaveLength(1)
  })

  it('sends the route credential, deployment headers, and attribution to the same origin', async () => {
    const server = await mockServer([], { processListing: listing(loaded(MODEL, 32_768)) })
    const subject = tracker('probe-key')

    await subject.observe(profileFor(`${server.url}/v1`, { headers: { 'X-Tenant': 'lab' } }), MODEL)
    await subject.observe(profileFor(server.url, { api: 'anthropic-messages' }), MODEL)
    await tracker().observe(profileFor(`${server.url}/v1`), MODEL)

    expect(server.probes[0]).toMatchObject({
      authorization: 'Bearer probe-key',
      'x-tenant': 'lab',
      accept: 'application/json',
      'user-agent': userAgent(),
    })
    expect(server.probes[1]).toMatchObject({ 'x-api-key': 'probe-key', 'anthropic-version': '2023-06-01' })
    expect(server.probes[1]).not.toHaveProperty('authorization')
    expect(server.probes[2]).not.toHaveProperty('authorization')
  })

  it('does not probe for a model id Ollama cannot name or a route without a probe', async () => {
    const server = await mockServer([], { processListing: listing(loaded(MODEL, 32_768)) })
    const subject = tracker()

    await expect(subject.observe(profileFor(`${server.url}/v1`), 'qwen3@sha256:abc')).resolves.toBeUndefined()
    await expect(subject.observe(profileFor(`${server.url}/v1`, { servedContextProbe: 'off' }), MODEL))
      .resolves.toBeUndefined()
    expect(subject.learned(profileFor(`${server.url}/v1`), 'qwen3@sha256:abc')).toBeUndefined()
    expect(server.probes).toEqual([])
  })
})

/** Plugin mount with one declared Ollama-style route on `baseURL`. */
async function ollamaRoute(
  baseURL: string,
  overrides: Partial<PiAiProviderProfile> = {},
): Promise<{ ctx: Context; warnings: string[] }> {
  vi.stubEnv('PI_TEST_KEY', 'test-key')
  const ctx = new Context()
  const warnings: string[] = []
  ctx.logger.warn = ((message: string) => void warnings.push(message)) as typeof ctx.logger.warn
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmPiAi, {
    providers: {
      ollama: { apiKeyEnv: 'PI_TEST_KEY', api: 'openai-completions', baseURL, models: [{ id: MODEL }], ...overrides },
    },
  })
  return { ctx, warnings }
}

/** Drain one adapter stream, returning its error. */
async function streamError(stream: AsyncIterable<StreamChunk>): Promise<unknown> {
  try {
    for await (const _chunk of stream) {
      // Only the failure is asserted.
    }
  } catch (error: unknown) {
    return error
  }
  throw new Error('stream completed')
}

describe('served context in the pi-ai adapter', () => {
  it('reports the served window, warns once, and clamps output to it', async () => {
    const server = await mockServer([{ events: textEvents }], { processListing: listing(loaded(MODEL, 32_768)) })
    const { ctx, warnings } = await ollamaRoute(`${server.url}/v1`)

    await expect(ctx.llm.resolveModelInfo('ollama', MODEL)).resolves.toMatchObject({ context: { contextWindow: 32_768 } })
    await expect(ctx.llm.resolveModelInfo('ollama', MODEL)).resolves.toMatchObject({ context: { contextWindow: 32_768 } })
    expect(warnings).toEqual([
      'llm-pi-ai: the endpoint of route "ollama" serves model "qwen3:32b" with a 32768-token context window,'
      + ' smaller than the configured 262144; using 32768',
    ])

    await assemble(ctx, { provider: 'ollama', model: MODEL, maxTokens: 30_000, messages: [] })
    // pi-ai keeps 4,096 tokens spare below the window it is given.
    expect(server.requests[0]).toMatchObject({ max_completion_tokens: 32_768 - 4_096 })
  })

  it('keeps a configured window smaller than the served one', async () => {
    const server = await mockServer([], { processListing: listing(loaded(MODEL, 32_768)) })
    const { ctx, warnings } = await ollamaRoute(`${server.url}/v1`, { models: [{ id: MODEL, contextWindow: 16_384 }] })

    await expect(ctx.llm.resolveModelInfo('ollama', MODEL)).resolves.toMatchObject({ context: { contextWindow: 16_384 } })
    expect(warnings).toEqual([])
  })

  it('reports the configured window when probing is off or nothing is learned yet', async () => {
    const server = await mockServer([], { processListing: listing(loaded(MODEL, 32_768)) })
    const { ctx } = await ollamaRoute(`${server.url}/v1`, { servedContextProbe: 'off' })

    await expect(ctx.llm.resolveModelInfo('ollama', MODEL)).resolves.toMatchObject({ context: { contextWindow: 262_144 } })
    expect(server.probes).toEqual([])

    const adapter = new PiAiAdapter({
      profiles: () => resolveProfiles({ ollama: { api: 'openai-completions', baseURL: `${server.url}/v1`, models: [{ id: MODEL }] } }),
      resolveApiKey: () => Promise.resolve(undefined),
      auth: memoryAuth(),
      servedContext: tracker(),
    })
    await expect(adapter.prepareCall('ollama', MODEL)).resolves.toMatchObject({ model: { context: { contextWindow: 262_144 } } })
    expect(server.probes).toEqual([])
  })

  it('refuses a request the served window cannot hold before it reaches the endpoint', async () => {
    const server = await mockServer([{ events: textEvents }], { processListing: listing(loaded(MODEL, 1_024)) })
    const adapter = new PiAiAdapter({
      profiles: () => resolveProfiles({ ollama: { api: 'openai-completions', baseURL: `${server.url}/v1`, models: [{ id: MODEL }] } }),
      resolveApiKey: () => Promise.resolve('test-key'),
      auth: memoryAuth(),
      servedContext: tracker(),
    })
    const request = (text: string): GenerateOptions => ({
      provider: 'ollama',
      model: MODEL,
      messages: [createSystemMessage('You are terse.'), createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })],
      tools: [{ name: 'read_file', description: 'Read a file.', parameters: { type: 'object', properties: {} } }],
    })

    await expect(adapter.resolveModel('ollama', MODEL)).resolves.toMatchObject({ context: { contextWindow: 1_024 } })
    const prepared = await adapter.prepareCall('ollama', MODEL)
    expect(prepared.model.context).toEqual({ contextWindow: 1_024 })
    const error = await streamError(prepared.stream(request('x'.repeat(4_000))))
    expect(error).toBeInstanceOf(LlmError)
    expect(error).toMatchObject({ code: CONTEXT_WINDOW_EXCEEDED_CODE })
    expect(error instanceof LlmError ? error.message : '')
      .toMatch(/needs about \d+ tokens, but its endpoint serves a 1024-token context window/)
    expect(server.paths).toEqual([])

    const reply: unknown[] = []
    for await (const chunk of adapter.stream(request('hi'))) reply.push(chunk)
    expect(server.paths).toEqual(['/v1/chat/completions'])
  })
})
