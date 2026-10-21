// Keyless end-to-end run of /self-improve: every trial is a fresh `dsh` runtime started
// through the SDK client's launcher, whose policy model is a local OpenAI-compatible
// stand-in reached through the runtime's own llm-pi-ai route. The stand-in answers
// each question but formats the answer only when a request carries the output
// contract, so a candidate scores higher only if its evolved AGENTS.md reaches the
// runtime's model requests. The search roles are a scripted in-process adapter.
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import CommandRegistry from '@deepseek-ai/dsh-commands'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LocalJobs from '@deepseek-ai/dsh-jobs-local'
import * as ToolJobs from '@deepseek-ai/dsh-tool-jobs'
import type { JobId } from '@deepseek-ai/dsh-jobs'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import LocalSandbox from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import WorkingDirectoryService from '@deepseek-ai/dsh-working-directory'
import * as SelfImprove from '../src/index.ts'

const exec = promisify(execFile)

/** The output contract the stand-in policy follows only when a request carries it. */
const CONTRACT = 'Begin every final answer with "ANSWER: " followed by the answer alone.'

interface PolicyCall {
  readonly instructed: boolean
  readonly reply: string
}

interface ChatMessage {
  readonly role: string
  readonly content: unknown
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((part: unknown) => (typeof part === 'object' && part !== null && 'text' in part && typeof part.text === 'string' ? part.text : '')).join('')
}

function knownAnswer(question: string): string {
  if (question.includes('2 plus 2')) return '4'
  if (question.includes('capital of France')) return 'Paris'
  if (question.includes('daytime sky')) return 'blue'
  if (question.includes('planets')) return '8'
  return 'unknown'
}

/** The policy stand-in: answers from the user messages, prefixed only when some message states the contract. */
async function policyEndpoint(): Promise<{ readonly url: string; readonly calls: PolicyCall[]; close(): Promise<void> }> {
  const calls: PolicyCall[] = []
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    request.on('end', () => {
      if (request.method !== 'POST' || !(request.url ?? '').endsWith('/chat/completions')) {
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end('{"error":"not found"}')
        return
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { readonly messages: readonly ChatMessage[]; readonly model: string }
      const everything = body.messages.map(message => textOf(message.content)).join('\n')
      const question = body.messages.filter(message => message.role === 'user').map(message => textOf(message.content)).join('\n')
      const instructed = everything.includes(CONTRACT)
      const answer = knownAnswer(question)
      const reply = instructed ? `ANSWER: ${answer}` : answer
      calls.push({ instructed, reply })
      const promptTokens = Math.ceil(everything.length / 4)
      const completionTokens = Math.ceil(reply.length / 4)
      const frames = [
        { choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] },
        { choices: [{ index: 0, delta: { content: reply }, finish_reason: null }] },
        {
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
        },
      ]
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const frame of frames) response.write(`data: ${JSON.stringify({ id: 'stand-in', object: 'chat.completion.chunk', created: 0, model: body.model, ...frame })}\n\n`)
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}/v1`,
    calls,
    close: () => new Promise<void>((resolve) => {
      server.close(() => { resolve() })
      server.closeAllConnections()
    }),
  }
}

/** Scripted search roles: the analyst names the missing prefix, the proposer states the contract, the critic accepts. */
class StandInRoleAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const system = options.system ?? ''
    const prompt = options.messages.flatMap(message => message.content.flatMap(block => (block.type === 'text' ? [block.text] : []))).join('\n')
    const reply = system.startsWith('You analyze')
      ? 'Failure mode: every final answer omits the "ANSWER: " prefix the checks require.'
      : system.startsWith('You improve')
        ? prompt.includes('OK: edited AGENTS.md')
          ? JSON.stringify({
            action: 'done',
            summary: 'state the output contract in the instructions',
            edits: [{ id: 'E1', component: 'prompt', hypothesis: 'the model omits the answer prefix unless its instructions state the output contract' }],
          })
          : JSON.stringify({ action: 'edit_file', path: 'AGENTS.md', old: 'Work carefully.', new: `Work carefully.\n${CONTRACT}` })
        : JSON.stringify({ verdict: 'accept', reasons: [], riskNotes: [] })
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: reply }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const StandInRoles = {
  name: 'self-improve-stand-in-roles',
  inject: ['llm'],
  apply(ctx: Context): void {
    ctx.effect(() => ctx.llm.registerAdapter(['stand-in-roles'], new StandInRoleAdapter()))
  },
}

let context: Context | undefined
let endpoint: Awaited<ReturnType<typeof policyEndpoint>> | undefined
let root: string | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  await endpoint?.close()
  endpoint = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('/self-improve through real dsh runtimes', () => {
  it('accepts an instruction edit only because the trial runtimes deliver it to the model, and confirms it on a held-out task', async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-self-improve-runtime-')))
    endpoint = await policyEndpoint()
    const repo = join(root, 'repo')
    await mkdir(join(repo, 'harness', 'evolved'), { recursive: true })
    const git = async (...args: string[]): Promise<string> => (await exec('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd: repo,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '', GIT_CONFIG_COUNT: '0' },
    })).stdout.trim()
    await git('init', '-q', '-b', 'main')
    await writeFile(join(repo, 'harness', 'evolved', 'AGENTS.md'), 'Work carefully.\n')
    await writeFile(join(repo, 'policy.patch.yml'), [
      '- id: llm-pi-ai',
      '  config:',
      '    providers:',
      '      stand-in:',
      '        api: openai-completions',
      '        apiKeyEnv: STAND_IN_API_KEY',
      `        baseURL: ${endpoint.url}`,
      '        models:',
      '          - id: policy',
      '',
    ].join('\n'))
    await writeFile(join(repo, 'suite.json'), JSON.stringify({
      briefs: { critic: 'Tasks are short factual questions whose checks require an exact answer format.' },
      smoke: ['sum'],
      tasks: [
        { id: 'sum', split: 'evolve', prompt: 'What is 2 plus 2? Reply with the number.', checks: [{ answer: '^ANSWER: 4$' }] },
        { id: 'capital', split: 'evolve', prompt: 'What is the capital of France? Reply with the city.', checks: [{ answer: '^ANSWER: Paris$' }] },
        { id: 'sky', split: 'evolve', prompt: 'What colour is a clear daytime sky? Reply with one word.', checks: [{ answer: '^ANSWER: blue$' }] },
        { id: 'planets', split: 'heldout', prompt: 'How many planets orbit the Sun? Reply with the number.', checks: [{ answer: '^ANSWER: 8$' }] },
      ],
    }))
    await writeFile(join(repo, 'run.json'), JSON.stringify({
      name: 'runtime',
      suite: 'suite.json',
      evolvedDirectory: 'harness/evolved',
      trial: { policyPatches: ['policy.patch.yml'], provider: 'stand-in', model: 'policy', env: { STAND_IN_API_KEY: 'unused' } },
      roles: { provider: 'stand-in-roles', model: 'scripted' },
      delta: 0.05,
      rounds: 1,
      variants: 1,
      trials: 1,
      repairRounds: 0,
    }))
    await git('add', '.')
    await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '-q', '-m', 'initial')
    const head = await git('rev-parse', 'HEAD')

    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-agent', AgentRegistry],
      ['@deepseek-ai/dsh-session', SessionStore],
      ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
      ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
      ['@deepseek-ai/dsh-llm', LlmRuntime],
      ['@deepseek-ai/dsh-tools', ToolRuntime],
      ['@deepseek-ai/dsh-fs-local', LocalFileSystem],
      ['@deepseek-ai/dsh-subprocess-local', LocalSubprocessRuntime],
      ['@deepseek-ai/dsh-sandbox-local', LocalSandbox],
      ['@deepseek-ai/dsh-sandbox-policy', SandboxPolicyService],
      ['@deepseek-ai/dsh-working-directory', WorkingDirectoryService],
      ['@deepseek-ai/dsh-commands', CommandRegistry],
      ['@deepseek-ai/dsh-jobs-local', LocalJobs],
      ['@deepseek-ai/dsh-tool-jobs', ToolJobs],
      ['self-improve-stand-in-roles', StandInRoles],
      ['@deepseek-ai/dsh-experimental-self-improve', SelfImprove],
      ['@deepseek-ai/dsh-agent-loop', AgentLoop],
    ])
    const config = [...modules.keys()].flatMap(name => [
      `- name: 'cordis:${name}'`,
      ...name === '@deepseek-ai/dsh-sandbox-policy' ? ['  config:', '    mode: danger-full-access'] : [],
      ...name === '@deepseek-ai/dsh-agent-loop' ? ['  config:', '    agents: []'] : [],
      ...name === '@deepseek-ai/dsh-experimental-self-improve' ? ['  config:', `    scratchDirectory: '${join(root ?? '', 'scratch')}'`] : [],
    ]).join('\n') + '\n'
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, config)
    await mkdir(join(root, 'scratch'))
    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    for (const [specifier, plugin] of modules) context.loader.builtins[specifier] = plugin
    await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await context.loader.await()

    const ctx = context
    const agent = await ctx.agentLoop.create(SessionId('self-improve-runtime'), {}, { cwd: repo })
    const command = async (line: string) => (await ctx.commands.execute(agent, line, [], new AbortController().signal))?.result
    const job = async (line: string): Promise<string | undefined> => {
      const started = await command(line)
      expect(started).toMatchObject({ kind: 'success' })
      const id = /^started job (\S+):/.exec(started?.text ?? '')?.[1]
      expect(id).toBeDefined()
      const view = await ctx.jobs.wait(id as JobId, 240_000, agent.id)
      expect(view).toMatchObject({ status: 'completed' })
      return ctx.jobs.read(id as JobId, agent.id).result
    }

    expect(await job('/self-improve baseline run.json')).toBe(`baseline ${head}: score 0.0000`)
    expect(endpoint.calls).toHaveLength(3)
    expect(endpoint.calls.every(call => !call.instructed)).toBe(true)

    expect(await job('/self-improve round run.json')).toBe('round 0: accepted A, score 1.0000')
    const evolved = await git('rev-parse', 'self-improve/runtime')
    expect(evolved).not.toBe(head)
    expect(await git('rev-parse', 'main')).toBe(head)
    expect(await git('status', '--porcelain')).toBe('')
    expect(await git('show', '--name-only', '--format=', evolved)).toBe('harness/evolved/AGENTS.md')
    expect(await git('show', `${evolved}:harness/evolved/AGENTS.md`)).toBe(`Work carefully.\n${CONTRACT}`)
    expect(await readFile(join(repo, 'harness', 'evolved', 'AGENTS.md'), 'utf8')).toBe('Work carefully.\n')
    // One smoke trial and three measured trials, each in a runtime that received the edited instructions.
    expect(endpoint.calls).toHaveLength(7)
    expect(endpoint.calls.slice(3).every(call => call.instructed)).toBe(true)

    expect(await job('/self-improve heldout run.json')).toBe('held-out score 1.0000 over 1 task(s)')
    expect(endpoint.calls.map(call => call.reply).sort()).toEqual(['4', 'ANSWER: 4', 'ANSWER: 4', 'ANSWER: 8', 'ANSWER: Paris', 'ANSWER: blue', 'Paris', 'blue'])

    const runDirectory = join(repo, '.agents', 'self-improve', 'runtime')
    const history = (await readFile(join(runDirectory, 'history.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    expect(history).toEqual([expect.objectContaining({ round: 0, variant: 'A', component: 'prompt', outcome: 'accepted', accepted: true, scoreChange: 1 })])
    const result = async (trialJob: string, task: string): Promise<Record<string, unknown>> =>
      JSON.parse(await readFile(join(runDirectory, 'trials', trialJob, task, '0', 'result.json'), 'utf8')) as Record<string, unknown>
    expect(await result(`base-${head.slice(0, 12)}`, 'sum')).toMatchObject({ reward: 0, tokens: expect.any(Number) as number })
    expect(await result('r0A', 'sum')).toMatchObject({ reward: 1, tokens: expect.any(Number) as number })
    expect(await result('heldout-1', 'planets')).toMatchObject({ reward: 1 })
    const status = (await command('/self-improve status run.json'))?.text?.split('\n') ?? []
    expect(status[0]).toBe('runtime: next round none (complete)')
    expect(status[1]).toMatch(new RegExp(`^H0: score 0\\.0000, cost \\d+, ${head}$`))
    expect(status[2]).toMatch(new RegExp(`^H1: score 1\\.0000, cost \\d+, ${evolved} \\(A\\)$`))
  }, 300_000)
})
