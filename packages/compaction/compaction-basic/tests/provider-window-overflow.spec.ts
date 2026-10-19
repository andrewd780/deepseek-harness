import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  createUserMessage,
  LlmAdapter,
  LlmError,
  resolveRetryPolicy,
  ToolCallId,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmResolvedModelInfo,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic'
import ToolResultPruner from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { TurnEndReason } from '@deepseek-ai/dsh-session'

/**
 * Providers whose real context window differs from the capacity the harness
 * declares, as with a custom endpoint configured on the Models page. Every
 * request, including compaction summaries, is priced and rejected with the
 * canonical overflow code when it exceeds the real window. `input` servers
 * check the prompt alone; `input-plus-output` servers also reserve the
 * requested output tokens, as OpenAI-compatible gateways and vLLM do.
 */
type Enforcement = 'input' | 'input-plus-output'

/** How the provider reports a rejected request. */
type Delivery = 'thrown' | 'in-band'

/** How each conversation step grows the history. */
type Growth =
  | { readonly kind: 'tool-results'; readonly steps: number; readonly chars: number }
  | { readonly kind: 'replies'; readonly chars: number }

interface ProviderShape {
  readonly declaredWindow: number
  readonly realWindow: number
  readonly defaultMaxTokens: number
  readonly enforcement: Enforcement
  readonly growth: Growth
}

interface PricedRequest {
  readonly purpose: 'conversation' | 'compaction'
  readonly inputTokens: number
  readonly maxTokens: number
  readonly rejected: boolean
}

/** Approximate provider tokenization: four serialized characters per token. */
function priceInput(options: GenerateOptions): number {
  const serialized = JSON.stringify(options.messages) + JSON.stringify(options.tools ?? [])
  return Math.ceil(serialized.length / 4)
}

function filler(label: string, chars: number): string {
  return `${label} `.repeat(Math.ceil(chars / (label.length + 1)))
}

class WindowEnforcingAdapter extends LlmAdapter {
  readonly requests: PricedRequest[] = []
  /** One-based index among fitting summary requests that fails with a provider outage. */
  summaryOutage: number | undefined
  private conversationCalls = 0
  private fittingSummaries = 0
  private readonly retryPolicy = resolveRetryPolicy({
    mode: 'normal',
    maxRetries: 0,
    backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
  }, 'provider-window test retryPolicy')

  constructor(private readonly shape: ProviderShape, private readonly delivery: Delivery) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: this.shape.declaredWindow },
      defaultMaxTokens: this.shape.defaultMaxTokens,
    })
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return this.retryPolicy
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const purpose = options.purpose === 'compaction' ? 'compaction' : 'conversation'
    const inputTokens = priceInput(options)
    const maxTokens = options.maxTokens ?? this.shape.defaultMaxTokens
    const tokens = inputTokens + (this.shape.enforcement === 'input-plus-output' ? maxTokens : 0)
    const rejected = tokens > this.shape.realWindow
    this.requests.push({ purpose, inputTokens, maxTokens, rejected })
    if (rejected) {
      const message = `This model's maximum context length is ${this.shape.realWindow} tokens. `
        + `However, you requested ${tokens} tokens.`
      if (this.delivery === 'thrown') throw new LlmError(message, CONTEXT_WINDOW_EXCEEDED_CODE)
      yield { type: 'finish', reason: { kind: 'error', failure: { message, code: CONTEXT_WINDOW_EXCEEDED_CODE } } }
      return
    }

    if (purpose === 'compaction') {
      this.fittingSummaries += 1
      if (this.fittingSummaries === this.summaryOutage) {
        yield { type: 'finish', reason: { kind: 'error', failure: { message: 'provider outage', code: 'SERVER' } } }
        return
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'BOUNDED CHECKPOINT' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }

    const call = this.conversationCalls
    this.conversationCalls += 1
    const { growth } = this.shape
    if (growth.kind === 'tool-results' && call % (growth.steps + 1) < growth.steps) {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id: ToolCallId(`read-${call}`), name: 'read_chunk', arguments: `{"chunk":${call}}` },
      }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const text = growth.kind === 'replies' ? filler(`reply ${call}`, growth.chars) : 'all chunks read'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function harness(
  shape: ProviderShape,
  delivery: Delivery,
  config: BasicCompactionConfig = {},
): Promise<{ ctx: Context; adapter: WindowEnforcingAdapter; engine: BasicCompactionEngine }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TokenMeter)
  await ctx.plugin(ToolResultPruner)
  const adapter = new WindowEnforcingAdapter(shape, delivery)
  ctx.llm.registerAdapter(['custom'], adapter)
  const resultChars = shape.growth.kind === 'tool-results' ? shape.growth.chars : 0
  ctx.tools.register(defineContentToolFixture({
    name: 'read_chunk',
    description: 'reads one chunk of a large file',
    parameters: { chunk: { type: 'number' } },
    async execute() {
      return [{ type: 'text', text: filler('chunk data', resultChars) }]
    },
  }))
  const engine = new BasicCompactionEngine(ctx, config)
  return { ctx, adapter, engine }
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

async function runTurn(ctx: Context, agent: Agent, text: string): Promise<TurnEndReason | undefined> {
  const idle = waitForIdle(ctx, agent)
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await idle
  const ending = agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')
  return ending?.type === 'turn/end' ? ending.data.reason : undefined
}

/** Send short prompts until one turn ends without completing or `limit` turns complete. */
async function chatUntilFailure(ctx: Context, agent: Agent, limit: number): Promise<TurnEndReason | undefined> {
  let reason: TurnEndReason | undefined
  for (let turn = 0; turn < limit; turn += 1) {
    reason = await runTurn(ctx, agent, 'continue')
    if (reason?.kind !== 'completed') return reason
  }
  return reason
}

/** Every summary request after a rejected one is no larger in prompt or cap, and smaller in total. */
function expectShrinkingSummaryRetries(requests: readonly PricedRequest[]): void {
  for (const [index, request] of requests.entries()) {
    const next = requests[index + 1]
    if (request.purpose !== 'compaction' || !request.rejected || next?.purpose !== 'compaction') continue
    expect(next.inputTokens).toBeLessThanOrEqual(request.inputTokens)
    expect(next.maxTokens).toBeLessThanOrEqual(request.maxTokens)
    expect(next.inputTokens + next.maxTokens).toBeLessThan(request.inputTokens + request.maxTokens)
  }
}

/** Every compaction bracket closes; failed brackets match rejected summaries; logged caps match the wire. */
function expectPairedCompactionLog(agent: Agent, requests: readonly PricedRequest[]): void {
  const events = agent.session.snapshotEvents()
  const starts = events.filter(event => event.type === 'compaction/start')
  const ends = events.flatMap(event => event.type === 'compaction/end' ? [event.data] : [])
  const summaries = requests.filter(request => request.purpose === 'compaction')
  expect(ends).toHaveLength(starts.length)
  expect(ends.filter(end => end.error !== undefined)).toHaveLength(summaries.filter(request => request.rejected).length)
  expect(events.flatMap(event => event.type === 'compaction/summary' ? [event.data.maxTokens] : []))
    .toEqual(summaries.filter(request => !request.rejected).map(request => request.maxTokens))
}

/** Provider shapes whose declared window exceeds the window the server enforces. */
const UNDERSIZED: Array<[string, ProviderShape]> = [
  ['a prompt-only server growing through short prompts', {
    declaredWindow: 200_000,
    realWindow: 8_000,
    defaultMaxTokens: 8_192,
    enforcement: 'input',
    growth: { kind: 'replies', chars: 6_000 },
  }],
  ['an output-reserving server growing through tool results', {
    declaredWindow: 200_000,
    realWindow: 32_768,
    defaultMaxTokens: 8_192,
    enforcement: 'input-plus-output',
    growth: { kind: 'tool-results', steps: 40, chars: 6_000 },
  }],
]

const CASES = UNDERSIZED.flatMap(([name, shape]) => (['thrown', 'in-band'] as const)
  .map((delivery): [string, Delivery, ProviderShape] => [name, delivery, shape]))

describe.each(CASES)('a provider window smaller than declared: %s, %s rejection', (_name, delivery, shape) => {
  it('recovers the overflowing turn with summary requests that shrink after each rejection', async () => {
    const { ctx, adapter } = await harness(shape, delivery)
    try {
      const agent = await ctx.agentLoop.create(SessionId('undersized-auto'), { provider: 'custom', model: 'local' })
      const ending = await chatUntilFailure(ctx, agent, 12)

      expect(adapter.requests.some(request => request.purpose === 'conversation' && request.rejected)).toBe(true)
      expect(adapter.requests.some(request => request.purpose === 'compaction' && request.rejected)).toBe(true)
      expect(ending).toEqual({ kind: 'completed' })
      expectShrinkingSummaryRetries(adapter.requests)
      expectPairedCompactionLog(agent, adapter.requests)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('lets manual compaction make the session usable again after an overflow ended a turn', async () => {
    const { ctx, adapter, engine } = await harness(shape, delivery, { auto: false })
    try {
      const agent = await ctx.agentLoop.create(SessionId('undersized-manual'), { provider: 'custom', model: 'local' })
      expect(await chatUntilFailure(ctx, agent, 12)).toMatchObject({
        kind: 'error',
        error: { code: CONTEXT_WINDOW_EXCEEDED_CODE },
      })

      const result = await engine.compactNow(agent, new AbortController().signal)
      expect(result).not.toBeNull()
      expect(adapter.requests.at(-1)).toMatchObject({ purpose: 'compaction', rejected: false })
      expectShrinkingSummaryRetries(adapter.requests)
      expectPairedCompactionLog(agent, adapter.requests)

      const before = adapter.requests.length
      await runTurn(ctx, agent, 'continue')
      expect(adapter.requests[before]).toMatchObject({ purpose: 'conversation', rejected: false })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reports committed folds when a later manual fold fails', async () => {
    const { ctx, adapter, engine } = await harness(shape, delivery, { auto: false })
    try {
      const agent = await ctx.agentLoop.create(SessionId('undersized-partial'), { provider: 'custom', model: 'local' })
      await chatUntilFailure(ctx, agent, 12)
      adapter.summaryOutage = 2

      const result = await engine.compactNow(agent, new AbortController().signal)

      expect(result).not.toBeNull()
      const ends = agent.session.snapshotEvents().flatMap(event => event.type === 'compaction/end' ? [event.data] : [])
      expect(ends.at(-1)?.error).toMatch(/provider outage/)
      expect(agent.session.snapshotEvents().some(event => event.seq === result!.summarySeq)).toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('a correctly declared small provider window', () => {
  const shape: ProviderShape = {
    declaredWindow: 32_768,
    realWindow: 32_768,
    defaultMaxTokens: 4_096,
    enforcement: 'input-plus-output',
    growth: { kind: 'tool-results', steps: 2, chars: 6_000 },
  }

  it('sizes the default summary cap to the window, so the first manual summary fits', async () => {
    const { ctx, adapter, engine } = await harness(shape, 'thrown')
    try {
      const agent = await ctx.agentLoop.create(SessionId('small-default'), { provider: 'custom', model: 'local' })
      expect(await runTurn(ctx, agent, 'read two chunks')).toEqual({ kind: 'completed' })

      const result = await engine.compactNow(agent, new AbortController().signal)

      expect(result).not.toBeNull()
      const summaries = adapter.requests.filter(request => request.purpose === 'compaction')
      expect(summaries).toEqual([expect.objectContaining({ rejected: false, maxTokens: 5_735 })])
      expectPairedCompactionLog(agent, adapter.requests)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('retries a summary whose configured cap exceeds the window with a cap no larger than its span', async () => {
    const { ctx, adapter, engine } = await harness(shape, 'thrown', { maxTokens: 65_536 })
    try {
      const agent = await ctx.agentLoop.create(SessionId('small-manual'), { provider: 'custom', model: 'local' })
      expect(await runTurn(ctx, agent, 'read two chunks')).toEqual({ kind: 'completed' })

      const result = await engine.compactNow(agent, new AbortController().signal)

      expect(result).not.toBeNull()
      const summaries = adapter.requests.filter(request => request.purpose === 'compaction')
      expect(summaries.map(request => request.rejected)).toEqual([true, false])
      expect(summaries[0]).toMatchObject({ maxTokens: 65_536 })
      expect(summaries[1]!.maxTokens).toBeLessThan(summaries[1]!.inputTokens)
      expectPairedCompactionLog(agent, adapter.requests)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('a correctly declared 32K prompt-only window under default settings', () => {
  const shape: ProviderShape = {
    declaredWindow: 32_768,
    realWindow: 32_768,
    defaultMaxTokens: 4_096,
    enforcement: 'input',
    growth: { kind: 'replies', chars: 6_000 },
  }

  it('compacts before the server rejects any request in a long chat', async () => {
    const { ctx, adapter } = await harness(shape, 'thrown')
    try {
      const agent = await ctx.agentLoop.create(SessionId('small-pressure'), { provider: 'custom', model: 'local' })

      expect(await chatUntilFailure(ctx, agent, 30)).toEqual({ kind: 'completed' })

      expect(adapter.requests.filter(request => request.rejected)).toEqual([])
      const summaries = adapter.requests.filter(request => request.purpose === 'compaction')
      expect(summaries.length).toBeGreaterThan(1)
      expect(new Set(summaries.map(request => request.maxTokens))).toEqual(new Set([5_735]))
      expectPairedCompactionLog(agent, adapter.requests)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
