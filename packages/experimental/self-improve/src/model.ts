/**
 * The model behind the analyst, proposer, and critic: one request through
 * the harness's model runtime, outside any Session. The run directory keeps
 * each role's inputs and parsed results.
 *
 * @module @deepseek-ai/dsh-experimental-self-improve/model
 */

import type { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed, GenerateOptions } from '@deepseek-ai/dsh-llm'
import { deadline } from '@deepseek-ai/dsh-timeout'

import type { TextModel, TextRequest } from './types.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-experimental-self-improve': { kind: 'dsh-experimental-self-improve' } & ContextFormed
  }
}

/** The code on a role request's timeout reason. */
export const ROLE_TIMEOUT_CODE = 'SELF_IMPROVE_ROLE_TIMEOUT'

/** The provider route and limits of the search roles. */
export interface ModelSettings {
  readonly provider: string
  readonly model: string
  readonly maxOutputTokens: number
  /** Bound on one request; `0` sets none. */
  readonly timeoutMs: number
}

/**
 * A text model over `ctx.llm`.
 * @param ctx - a context injecting `llm`.
 * @param settings - the route and limits.
 * @returns the model.
 */
export function createLlmTextModel(ctx: Context, settings: ModelSettings): TextModel {
  return {
    async complete(request: TextRequest): Promise<string> {
      using callDeadline = deadline(request.signal, settings.timeoutMs, ROLE_TIMEOUT_CODE)
      const call = await ctx.llm.prepareCall(
        { provider: settings.provider, model: settings.model, maxTokens: settings.maxOutputTokens },
        callDeadline.signal,
      )
      const options: GenerateOptions = {
        ...call.config,
        system: request.system,
        messages: [createUserMessage({
          content: [{ type: 'text', text: request.prompt }],
          source: { kind: 'dsh-experimental-self-improve' },
        })],
        signal: callDeadline.signal,
      }
      const assembler = new BlockAssembler()
      for await (const chunk of call.stream(options)) assembler.push(chunk)
      callDeadline.signal.throwIfAborted()
      const finish = assembler.finish
      if (finish.kind === 'error' || finish.kind === 'aborted') {
        throw new Error(`self-improve role request failed: ${finish.failure.message}`)
      }
      return assembler.blocks().flatMap(block => (block.type === 'text' ? [block.text] : [])).join('')
    },
  }
}
