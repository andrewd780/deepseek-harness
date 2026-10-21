import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { JobHooks, JobOutcome, JobSpec } from '@deepseek-ai/dsh-jobs'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { EvaluationJobId } from '../src/brand.ts'
import { RunDirectory } from '../src/directory.ts'
import * as SelfImprove from '../src/index.ts'
import { useFakeRuntime } from './fake-runtime.ts'
import * as RoleModel from './fixtures/role-model.ts'
import { repository } from './repository.ts'

const roots: string[] = []
const contexts: Context[] = []
let fake: ReturnType<typeof useFakeRuntime> | undefined

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  fake?.restore()
  fake = undefined
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

type Handler = (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>

/** A string matcher typed as the string it matches. */
const matching = (pattern: RegExp): string => expect.stringMatching(pattern) as string

interface StartedJob {
  readonly spec: JobSpec
  readonly hooks: JobHooks
  readonly output: string[]
}

async function harness(options: { readonly jobs?: 'present' | 'absent' | 'throws' | 'throws-text'; readonly scratch?: string; readonly spec?: Record<string, unknown> } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-self-improve-plugin-')))
  roots.push(root)
  const { repo, git } = await repository(root, options.spec)
  fake ??= useFakeRuntime()
  const ctx = new Context()
  contexts.push(ctx)
  const handlers = new Map<string, Handler>()
  ctx.provide('commands', {
    register: (definition: { readonly name: string; readonly handler: Handler }) => {
      handlers.set(definition.name, definition.handler)
      return () => {
        handlers.delete(definition.name)
      }
    },
  } as never)
  ctx.provide('workingDirectory', { ensure: async () => repo } as never)
  const started: StartedJob[] = []
  if (options.jobs !== 'absent') {
    ctx.provide('jobs', {
      start: (spec: JobSpec) => {
        if (options.jobs === 'throws') throw new Error('background jobs unavailable: no job controller serves this agent')
        if (options.jobs === 'throws-text') throw 'jobs refused'
        const output: string[] = []
        const hooks = spec.run({ id: `job-${started.length}`, append: (text: string) => output.push(text), updateProgress: () => {} } as never)
        started.push({ spec, hooks, output })
        return `job-${started.length - 1}`
      },
    } as never)
  }
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(RoleModel)
  await ctx.plugin(LocalSubprocessRuntime)
  const fiber = ctx.plugin(SelfImprove, { scratchDirectory: options.scratch ?? join(root, 'scratch') })
  await fiber
  const run = async (line: string, signal = new AbortController().signal): Promise<CommandResult> => {
    const handler = handlers.get('self-improve')
    if (handler === undefined) throw new Error('self-improve is not registered')
    return await handler({ commandId: 'c' as never, agent: { id: 'agent-1' } as never, rawInput: line, attachments: [], signal })
  }
  const job = async (line: string): Promise<JobOutcome> => {
    const before = started.length
    const result = await run(line)
    expect(result).toMatchObject({ kind: 'success', text: matching(/^started job job-\d+: self-improve /) })
    return await started[before]!.hooks.done
  }
  return { root, repo, git, ctx, run, job, started, fiber }
}

describe('/self-improve', () => {
  it('answers malformed command lines with the usage', async () => {
    const { run } = await harness()
    for (const line of ['', 'dance run.json', 'status', 'round run.json 1 2', 'round run.json -1', 'round run.json x']) {
      expect(await run(line)).toEqual({ kind: 'error', text: 'usage: /self-improve <status|baseline|calibrate|round|run|heldout> <spec.json> [number]' })
    }
  })

  it('reports a spec it cannot compose', async () => {
    const { run, repo, root } = await harness()
    expect(await run('status missing.json')).toMatchObject({ kind: 'error', text: matching(/ENOENT/) })
    await writeFile(join(repo, 'forward.json'), JSON.stringify({ ...await specOf(repo), trial: { policyPatches: ['policy.patch.yml'], provider: 'mock', model: 'm', forwardEnv: ['SELF_IMPROVE_TEST_UNSET'] } }))
    expect(await run('status forward.json')).toEqual({ kind: 'error', text: 'self-improve run spec forwards SELF_IMPROVE_TEST_UNSET, which is not set' })
    await writeFile(join(repo, 'inside.json'), JSON.stringify({ ...await specOf(repo), evolvedDirectory: '.agents/self-improve/evolved' }))
    expect(await run('status inside.json')).toEqual({ kind: 'error', text: 'self-improve evolved directory .agents/self-improve/evolved lies inside the runs directory .agents/self-improve, which git ignores' })
    const outside = join(root, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'suite.json'), JSON.stringify({ tasks: [{ id: 'a', split: 'evolve', prompt: 'p', checks: [{ answer: 'x' }] }] }))
    await writeFile(join(outside, 'run.json'), JSON.stringify({ ...await specOf(repo), suite: 'suite.json', trial: { policyPatches: ['p.yml'], provider: 'mock', model: 'm' } }))
    expect(await run(`status ${join(outside, 'run.json')}`)).toMatchObject({ kind: 'error', text: matching(/is not inside a git repository/) })
    await rm(join(repo, 'suite.json'))
    expect(await run('status run.json')).toMatchObject({ kind: 'error', text: matching(/suite\.json/) })
  })

  it('needs background jobs for long actions', async () => {
    const absent = await harness({ jobs: 'absent' })
    expect(await absent.run('baseline run.json')).toEqual({ kind: 'error', text: 'self-improve needs background jobs: load @deepseek-ai/dsh-jobs-local and @deepseek-ai/dsh-tool-jobs' })
    expect(await absent.run('status run.json')).toEqual({ kind: 'success', text: 'loader: no baseline yet' })
    const refusing = await harness({ jobs: 'throws' })
    expect(await refusing.run('baseline run.json')).toEqual({ kind: 'error', text: 'background jobs unavailable: no job controller serves this agent' })
    const text = await harness({ jobs: 'throws-text' })
    expect(await text.run('baseline run.json')).toEqual({ kind: 'error', text: 'jobs refused' })
  })

  it('calibrates only with a named method', async () => {
    const { job } = await harness({ spec: { calibration: { method: 'spread' } } })
    expect(await job('baseline run.json')).toMatchObject({ status: 'completed' })
    expect(await job('calibrate run.json')).toEqual({ status: 'completed', result: 'noise band 0.00000 (spread, scores 0.5000, 0.5000, 0.5000)' })
    const unnamed = await harness()
    expect(await unnamed.job('calibrate run.json')).toEqual({ status: 'failed', detail: 'self-improve calibrate needs calibration.method, "spread" or "z", in the run spec' })
  })

  it('runs every action as a job and narrates the run', async () => {
    const { job, started, run, repo, git } = await harness({ spec: { rounds: 2, calibration: { method: 'z' } } })
    const head = await git('rev-parse', 'HEAD')
    expect(await job('round run.json')).toEqual({ status: 'failed', detail: matching(/has no baseline; measure the baseline first$/) })
    expect(await job('baseline run.json')).toEqual({ status: 'completed', result: `baseline ${head}: score 0.5000` })
    expect(started.at(-1)?.spec).toMatchObject({ kind: 'self-improve', label: 'self-improve baseline loader', owner: 'agent-1' })
    expect(started.at(-1)?.output).toEqual([
      `run loader: evolved directory harness/evolved of ${repo}, evolve branch self-improve/loader\n`,
      `baseline ${head}: score 0.5000, cost not reported\n`,
    ])
    expect(await job('calibrate run.json')).toEqual({ status: 'completed', result: 'noise band 0.00000 (z 2, bootstrap, scores 0.5000, 0.5000, 0.5000)' })
    expect(await job('round run.json 1')).toEqual({ status: 'completed', result: 'round 0: accepted A, score 0.5000' })
    expect(await job('run run.json')).toEqual({ status: 'completed', result: 'round 1: no admissible candidate, score 0.5000' })
    expect(await job('heldout run.json 0')).toEqual({ status: 'completed', result: 'held-out score 1.0000 over 1 task(s)' })
    const directory = new RunDirectory(join(repo, '.agents', 'self-improve', 'loader'))
    const trajectory = await directory.readTrajectory()
    await directory.writeTrajectory([{ ...trajectory![0], cost: 1234.4 }, ...trajectory!.slice(1)])
    expect((await run('status run.json')).text?.split('\n').slice(0, 2)).toEqual([
      'loader: next round none (complete)',
      `H0: score 0.5000, cost 1234, ${head}`,
    ])
    expect(await directory.readEvaluation(EvaluationJobId(`base-${head.slice(0, 12)}-2`))).toBeDefined()
  })

  it('reports a killed job, and aborts running jobs when disposed', async () => {
    const { run, started, fiber } = await harness({ spec: { trial: { policyPatches: ['policy.patch.yml'], provider: 'mock', model: 'm', env: { FAKE_HANG_PROMPT: '1' }, timeoutMs: 600_000 } } })
    expect(await run('baseline run.json')).toMatchObject({ kind: 'success' })
    started[0]!.hooks.cancel('operator stop')
    expect(await started[0]!.hooks.done).toEqual({ status: 'killed', detail: 'operator stop' })
    expect(await run('baseline run.json')).toMatchObject({ kind: 'success' })
    started[1]!.hooks.cancel()
    expect(await started[1]!.hooks.done).toEqual({ status: 'killed', detail: 'self-improve job killed' })
    expect(await run('baseline run.json')).toMatchObject({ kind: 'success' })
    await fiber.dispose()
    expect(await started[2]!.hooks.done).toEqual({ status: 'killed', detail: 'self-improve plugin disposed' })
  })

  it('keeps trial scratch in the operating system temporary directory by default and forwards named variables', async () => {
    process.env['SELF_IMPROVE_TEST_FORWARDED'] = 'forwarded value'
    try {
      const { job } = await harness({
        scratch: '',
        spec: { trial: { policyPatches: ['policy.patch.yml'], provider: 'mock', model: 'm', env: { FAKE_TEXT: 'all done' }, forwardEnv: ['SELF_IMPROVE_TEST_FORWARDED'] } },
      })
      await job('baseline run.json')
    } finally {
      delete process.env['SELF_IMPROVE_TEST_FORWARDED']
    }
    expect(fake?.launches.every(launch => launch.env?.['DSH_AGENTS_HOME']?.startsWith(join(tmpdir(), 'dsh-self-improve')) === true)).toBe(true)
    expect(fake?.launches.every(launch => launch.env?.['SELF_IMPROVE_TEST_FORWARDED'] === 'forwarded value')).toBe(true)
  })
})

async function specOf(repo: string): Promise<Record<string, unknown>> {
  const { readFile } = await import('node:fs/promises')
  return JSON.parse(await readFile(join(repo, 'run.json'), 'utf8')) as Record<string, unknown>
}
