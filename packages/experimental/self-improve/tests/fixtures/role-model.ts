import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'

/** Scripted search roles: answers by the role its system text names, and by the proposer's progress. */
class RoleAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const system = options.system ?? ''
    const prompt = options.messages.flatMap(message => message.content.flatMap(block => (block.type === 'text' ? [block.text] : []))).join('\n')
    const reply = system.startsWith('You analyze')
      ? 'Failure mode: answers without checking the result.'
      : system.startsWith('You improve')
        ? prompt.includes('OK: created')
          ? JSON.stringify({ action: 'done', summary: 'add a verification skill', edits: [{ id: 'E1', component: 'skill', hypothesis: 'a checklist catches unverified answers' }] })
          : JSON.stringify({ action: 'write_file', path: 'skills/verify/SKILL.md', content: '---\nname: verify\ndescription: Check the result before answering.\n---\nRun the check, then answer.\n' })
        : JSON.stringify({ verdict: 'accept', reasons: [], riskNotes: [] })
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: reply }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export const name = 'self-improve-role-model'
export const inject = ['llm']

/**
 * Register the scripted roles under the `mock` provider.
 * @param ctx - the plugin context supplying `ctx.llm`.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.llm.registerAdapter(['mock'], new RoleAdapter()))
}
