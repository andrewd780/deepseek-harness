import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import { SUMMARY_TRUNCATED_CODE } from '@deepseek-ai/dsh-compaction-basic/src/summarizer.ts'
import type { SummarizationInput, SummaryResult } from '@deepseek-ai/dsh-compaction-basic/src/summarizer.ts'
import { isCompactCheckpointSource, ManualCompactionError } from '@deepseek-ai/dsh-compaction'
import LlmRuntime, {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  createMessage,
  createUserMessage,
  LlmError,
} from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import type { Agent } from '@deepseek-ai/dsh-agent'

const MODEL = 'fold-model'

/** Approximate provider tokenization of one summary request's prompt. */
function promptTokens(input: SummarizationInput): number {
  return Math.ceil(JSON.stringify(input.messages).length / 4)
}

/**
 * A summarizer whose `reject` rule decides, per request, which error the
 * provider raises instead of a summary. Every request is recorded.
 */
class ScriptedFoldEngine extends BasicCompactionEngine {
  readonly calls: SummarizationInput[] = []
  reject: (input: SummarizationInput, call: number) => unknown = () => undefined
  onCall: ((call: number) => void) | undefined

  protected override async summarize(input: SummarizationInput): Promise<SummaryResult> {
    const call = this.calls.length
    this.calls.push(input)
    this.onCall?.(call)
    const error = this.reject(input, call)
    if (error !== undefined) throw error
    return { summary: [{ type: 'text', text: 'fold' }], provider: MODEL, model: MODEL, maxTokens: input.maxTokens }
  }
}

function engine(ctx = new Context()): ScriptedFoldEngine {
  void new LlmRuntime(ctx)
  new SessionProjectionRegistry(ctx)
  void new TokenMeter(ctx)
  return new ScriptedFoldEngine(ctx, { auto: false, headroomTokens: 0, maxTokens: 4096 })
}

function agent(session: Session): Agent {
  return { session, options: { provider: MODEL, model: MODEL } } as Agent
}

/** An idle agent whose maintenance runs immediately, for manual compaction. */
function idleAgent(session: Session): Agent {
  return {
    session,
    options: { provider: MODEL, model: MODEL },
    runMaintenance: <T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> => task(new AbortController().signal),
  } as Agent
}

/** A store-detached engine whose durability checkpoints `flush` decides. */
function manualEngine(flush: () => Promise<boolean>): ScriptedFoldEngine {
  const ctx = new Context()
  void new SessionStore(ctx)
  const compact = engine(ctx)
  vi.spyOn(ctx.sessions, 'flush').mockImplementation(flush)
  return compact
}

/** Close the open turn so manual compaction sees an idle session. */
function idle(session: Session): Session {
  const turn = session.snapshotEvents().findLast(event => event.type === 'turn/start')
  if (turn?.type === 'turn/start') session.append('turn/end', { turn: turn.data.turn, reason: { kind: 'completed' } })
  return session
}

/** Closed user/assistant turns whose texts come from `texts`, then one open turn. */
function conversation(texts: readonly string[]): Session {
  const session = Session.create(SessionId(`fold-${texts.length}`))
  for (const [index, text] of texts.entries()) {
    const turn = index + 1
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `${text} user ${turn}` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn, step: 1 })
    if (turn === 1) {
      session.append('request/header', {
        header: { config: { provider: MODEL, model: MODEL } },
        reason: 'initial',
      })
    }
    session.append('assistant/message', {
      stream: [],
      turn,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: `${text} assistant ${turn}` }],
        source: { kind: 'model', provider: MODEL, model: MODEL },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  session.append('turn/start', { turn: texts.length + 1 })
  return session
}

const WINDOW_REJECTION = new LlmError('maximum context length exceeded', CONTEXT_WINDOW_EXCEEDED_CODE)

/** Reject summary requests whose prompt, plus the cap when `reserveOutput`, exceeds `window`. */
function windowRule(window: number, reserveOutput: boolean): (input: SummarizationInput) => unknown {
  return input => promptTokens(input) + (reserveOutput ? input.maxTokens : 0) > window
    ? WINDOW_REJECTION
    : undefined
}

function isCheckpoint(session: Session, index: number): boolean {
  const event = session.eventAt(session.surface.nodes[index]!)
  return event?.type === 'user/message' && isCompactCheckpointSource(event.data.source)
}

function bracketCounts(session: Session): { starts: number; ends: number; failed: number } {
  const events = session.snapshotEvents()
  return {
    starts: events.filter(event => event.type === 'compaction/start').length,
    ends: events.filter(event => event.type === 'compaction/end').length,
    failed: events.filter(event => event.type === 'compaction/end' && event.data.error !== undefined).length,
  }
}

const filler = (chars: number): string => 'x '.repeat(chars / 2)

describe('overflow compaction folds history into requests the provider accepts', () => {
  it('folds the whole range oldest-first after prompt rejections', async () => {
    const compact = engine()
    compact.reject = windowRule(1_200, false)
    const session = conversation(Array.from({ length: 8 }, () => filler(800)))
    const last = session.surface.nodes.at(-1)

    const result = await compact.compactIfNeeded(agent(session), 'context-overflow', new AbortController().signal)

    expect(result).not.toBeNull()
    expect(session.surface.nodes).toHaveLength(2)
    expect(isCheckpoint(session, 0)).toBe(true)
    expect(session.surface.nodes[1]).toBe(last)
    const rejected = compact.calls.filter(input => promptTokens(input) > 1_200)
    expect(rejected.length).toBeGreaterThan(0)
    expect(bracketCounts(session)).toEqual({
      starts: compact.calls.length,
      ends: compact.calls.length,
      failed: rejected.length,
    })
  })

  it('lowers the cap to the span price before halving the span', async () => {
    const compact = engine()
    compact.reject = windowRule(2_000, true)
    const session = conversation([filler(1_200), filler(1_200)])

    await compact.compactIfNeeded(agent(session), 'context-overflow', new AbortController().signal)

    expect(compact.calls).toHaveLength(2)
    expect(compact.calls[1]!.messages).toEqual(compact.calls[0]!.messages)
    expect(compact.calls[0]!.maxTokens).toBe(4096)
    expect(compact.calls[1]!.maxTokens).toBeLessThan(4096)
  })

  it('halves the span and keeps the cap after a truncated summary', async () => {
    const compact = engine()
    const truncated = new LlmError('summarization truncated at the token cap', SUMMARY_TRUNCATED_CODE)
    compact.reject = input => promptTokens(input) > 1_000 ? truncated : undefined
    const session = conversation(Array.from({ length: 4 }, () => filler(800)))

    const result = await compact.compactIfNeeded(agent(session), 'context-overflow', new AbortController().signal)

    expect(result).not.toBeNull()
    expect(compact.calls[1]!.maxTokens).toBe(compact.calls[0]!.maxTokens)
    expect(compact.calls[1]!.messages.length).toBeLessThan(compact.calls[0]!.messages.length)
  })

  it('rethrows the rejection when the oldest unit alone cannot fit', async () => {
    const compact = engine()
    compact.reject = windowRule(600, false)
    const session = conversation([filler(4_000), filler(200), filler(200)])
    const nodes = [...session.surface.nodes]

    await expect(compact.compactIfNeeded(agent(session), 'context-overflow', new AbortController().signal))
      .rejects.toBe(WINDOW_REJECTION)

    expect(session.surface.nodes).toEqual(nodes)
    expect(bracketCounts(session)).toEqual({
      starts: compact.calls.length,
      ends: compact.calls.length,
      failed: compact.calls.length,
    })
  })

  it('returns committed folds when a later unit cannot fit', async () => {
    const compact = engine()
    compact.reject = windowRule(900, false)
    const session = conversation([filler(400), filler(400), filler(6_000), filler(400)])

    const result = await compact.compactIfNeeded(agent(session), 'context-overflow', new AbortController().signal)

    expect(result).not.toBeNull()
    expect(isCheckpoint(session, 0)).toBe(true)
    expect(session.surface.nodes.length).toBeGreaterThan(2)
  })

  it('does not retry a summary failure that a smaller request cannot repair', async () => {
    const compact = engine()
    const outage = new LlmError('provider outage', 'SERVER')
    compact.reject = () => outage
    const session = conversation([filler(400), filler(400)])

    await expect(compact.compactIfNeeded(agent(session), 'context-overflow', new AbortController().signal))
      .rejects.toBe(outage)
    expect(compact.calls).toHaveLength(1)
  })

  it('stops between folds once cancelled', async () => {
    const compact = engine()
    const controller = new AbortController()
    compact.reject = windowRule(1_200, false)
    compact.onCall = (call) => {
      if (call > 0 && promptTokens(compact.calls[call]!) <= 1_200) controller.abort(new Error('stop folding'))
    }
    const session = conversation(Array.from({ length: 8 }, () => filler(800)))

    await expect(compact.compactIfNeeded(agent(session), 'context-overflow', controller.signal))
      .rejects.toThrow('stop folding')

    const accepted = compact.calls.filter(input => promptTokens(input) <= 1_200)
    expect(accepted).toHaveLength(1)
    expect(isCheckpoint(session, 0)).toBe(true)
    expect(bracketCounts(session).starts).toBe(compact.calls.length)
  })

  it('propagates a non-window failure after an automatic fold committed', async () => {
    const compact = engine()
    const outage = new LlmError('provider outage', 'SERVER')
    const fits = windowRule(1_200, false)
    let accepted = 0
    compact.reject = (input) => {
      const rejection = fits(input)
      if (rejection !== undefined) return rejection
      accepted += 1
      return accepted === 2 ? outage : undefined
    }
    const session = conversation(Array.from({ length: 8 }, () => filler(800)))

    await expect(compact.compactIfNeeded(agent(session), 'context-overflow', new AbortController().signal))
      .rejects.toBe(outage)
    expect(isCheckpoint(session, 0)).toBe(true)
  })

  it('returns committed manual folds when a later fold sees its span change', async () => {
    const compact = manualEngine(() => Promise.resolve(false))
    const session = idle(conversation(Array.from({ length: 8 }, () => filler(800))))
    const fits = windowRule(1_200, false)
    let accepted = 0
    compact.reject = (input) => {
      const rejection = fits(input)
      if (rejection !== undefined) return rejection
      accepted += 1
      if (accepted === 2) {
        const [head] = session.surface.nodes
        session.append('user/message', createUserMessage({
          content: [{ type: 'text', text: 'competing replacement' }],
          source: { kind: 'user' },
        }), { surfaceOp: { op: 'replace', startSeq: head!, endSeq: head! }, sourceEventSeqs: [head!] })
      }
      return undefined
    }

    const result = await compact.compactNow(idleAgent(session), new AbortController().signal)

    expect(result).not.toBeNull()
    expect(bracketCounts(session).failed).toBeGreaterThan(0)
  })

  it('rethrows a manual durability failure after a fold committed', async () => {
    const session = idle(conversation(Array.from({ length: 8 }, () => filler(800))))
    const committedFolds = (): number => session.snapshotEvents()
      .filter(event => event.type === 'compaction/summary').length
    const compact = manualEngine(() => committedFolds() === 2
      ? Promise.reject(new Error('disk full'))
      : Promise.resolve(false))
    compact.reject = windowRule(1_200, false)

    const failure = await compact.compactNow(idleAgent(session), new AbortController().signal)
      .then(() => undefined, (error: unknown) => error)

    expect(failure).toBeInstanceOf(ManualCompactionError)
    expect(failure).toMatchObject({ code: 'persistence' })
  })

  it('rethrows a rejection raised after cancellation instead of folding', async () => {
    const compact = engine()
    const controller = new AbortController()
    compact.reject = () => {
      controller.abort(new Error('cancelled mid-summary'))
      return WINDOW_REJECTION
    }
    const session = conversation([filler(400), filler(400)])

    await expect(compact.compactIfNeeded(agent(session), 'context-overflow', controller.signal))
      .rejects.toBe(WINDOW_REJECTION)
    expect(compact.calls).toHaveLength(1)
  })
})
