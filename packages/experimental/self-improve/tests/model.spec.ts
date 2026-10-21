import { Context } from '@deepseek-ai/cordis'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { describe, expect, it, vi } from 'vitest'
import { ROLE_TIMEOUT_CODE, createLlmTextModel } from '../src/model.ts'

function llm(chunks: readonly StreamChunk[]) {
  const stream = vi.fn(async function* (_options: unknown) {
    for (const chunk of chunks) yield chunk
  })
  const prepareCall = vi.fn(async (request: { provider: string; model: string; maxTokens: number }, _signal: AbortSignal) => ({
    config: { ...request },
    stream,
  }))
  const ctx = new Context()
  ctx.provide('llm', { prepareCall } as never)
  return { ctx, prepareCall, stream }
}

const settings = { provider: 'deepseek', model: 'deepseek-v4-pro', maxOutputTokens: 512, timeoutMs: 0 }

describe('createLlmTextModel', () => {
  it('sends one user message under the system text and joins the text blocks', async () => {
    const { ctx, prepareCall, stream } = llm([
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'thinking' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'thinking' } },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text: '{"verdict":' },
      { type: 'text-delta', index: 1, text: '"accept"}' },
      { type: 'block-end', index: 1, block: { type: 'text', text: '{"verdict":"accept"}' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    const text = await createLlmTextModel(ctx, settings).complete({ system: 'system text', prompt: 'the diff' })
    expect(text).toBe('{"verdict":"accept"}')
    expect(prepareCall).toHaveBeenCalledWith({ provider: 'deepseek', model: 'deepseek-v4-pro', maxTokens: 512 }, expect.any(AbortSignal))
    const [options] = stream.mock.calls[0] ?? []
    expect(options).toMatchObject({
      system: 'system text',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'the diff' }], source: { kind: 'dsh-experimental-self-improve' } }],
    })
  })

  it('fails on an error or aborted finish', async () => {
    for (const kind of ['error', 'aborted'] as const) {
      const { ctx } = llm([{ type: 'finish', reason: { kind, failure: { message: 'overloaded', code: 'UNKNOWN' } } }])
      await expect(createLlmTextModel(ctx, settings).complete({ system: '', prompt: 'p' }))
        .rejects.toThrow('self-improve role request failed: overloaded')
    }
  })

  it('stops at its deadline', async () => {
    const prepareCall = vi.fn(async (_request: unknown, signal: AbortSignal) => await new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        reject(signal.reason as Error)
      })
    }))
    const ctx = new Context()
    ctx.provide('llm', { prepareCall } as never)
    await expect(createLlmTextModel(ctx, { ...settings, timeoutMs: 5 }).complete({ system: '', prompt: 'p' }))
      .rejects.toMatchObject({ code: ROLE_TIMEOUT_CODE })
  })
})
