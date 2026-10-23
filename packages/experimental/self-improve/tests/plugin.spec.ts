import './isolated-home.ts'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { JobHooks, JobOutcome, JobSpec } from '@deepseek-ai/dsh-jobs'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { EvaluationJobId } from '../src/brand.ts'
import { SANDBOX_EXEC } from '../src/check-sandbox.ts'
import { internals } from '../src/command.ts'
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
  internals.sandboxExecutable = SANDBOX_EXEC
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

async function harness(options: {
  readonly jobs?: 'present' | 'absent' | 'throws' | 'throws-text'
  readonly scratch?: string
  readonly spec?: Record<string, unknown>
  /** Whether checks run under `sandbox-exec`; by default only where it exists. */
  readonly sandboxChecks?: boolean
} = {}) {
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
  const fiber = ctx.plugin(SelfImprove, {
    scratchDirectory: options.scratch ?? join(root, 'scratch'),
    home: join(root, 'home'),
    sandboxChecks: options.sandboxChecks ?? process.platform === 'darwin',
    memoryGuard: { enabled: false },
  })
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
  it('answers malformed command lines with the problem and every form of the command', async () => {
    const { run } = await harness()
    const problems: Record<string, string> = {
      'dance run.json': '/self-improve has no action "dance"',
      'round': '/self-improve round takes a run spec and an optional non-negative whole number',
      'round run.json 1 2': '/self-improve round takes a run spec and an optional non-negative whole number',
      'round run.json -1': '/self-improve round takes a run spec and an optional non-negative whole number',
      'round run.json x': '/self-improve round takes a run spec and an optional non-negative whole number',
      'auto now': '/self-improve auto takes no arguments; got now',
      'status a.json b.json': '/self-improve status takes at most 1 argument; got a.json b.json',
      'apply a.json b.json': '/self-improve apply takes at most 1 argument; got a.json b.json',
      'undo everything': '/self-improve undo takes no arguments; got everything',
      'schedule maybe': 'usage: /self-improve schedule on [HH:MM] | off | status',
      'schedule off 03:00': 'usage: /self-improve schedule on [HH:MM] | off | status',
      'schedule on 03:00 daily': 'usage: /self-improve schedule on [HH:MM] | off | status',
    }
    for (const [line, problem] of Object.entries(problems)) {
      expect(await run(line)).toEqual({ kind: 'error', text: `${problem}\n\n${SelfImprove.HELP}` })
    }
    expect(await run('schedule on 3am')).toEqual({ kind: 'error', text: 'self-improve schedule time 3am is not HH:MM in 24-hour local time' })
    expect(await run('help')).toEqual({ kind: 'success', text: SelfImprove.HELP })
    expect(SelfImprove.HELP.split('\n')).toHaveLength(16)
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
    RoleModel.proposerPrompts.splice(0)
    expect(await job('round run.json 1')).toEqual({ status: 'completed', result: 'round 0: accepted A, score 0.5000' })
    const history = '=== Edit history (measured candidates with their source diffs; a rejected mechanism is evidence against redrawing it unchanged) ===\n'
    expect(RoleModel.proposerPrompts[0]).toContain(`${history}[]\n\n`)
    const drafted = RoleModel.proposerPrompts.length
    expect(await job('run run.json')).toEqual({ status: 'completed', result: 'round 1: no admissible candidate, score 0.5000' })
    const round1 = RoleModel.proposerPrompts[drafted] ?? ''
    expect(round1).toContain('You draft candidate A of round 2 of 2.')
    const shown = round1.split(history)[1]?.split('\n\n=== Analysis of the incumbent ===')[0]
    expect(shown).toMatch(/^\[\n \{\n {2}"round": 0,\n {2}"variant": "A",\n {2}"outcome": "accepted"/)
    expect(shown).toContain('"component": "skill",\n    "hypothesis": "a checklist catches unverified answers"')
    expect(shown).toContain('+++ b/harness/evolved/skills/verify/SKILL.md')
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

  it('refuses to grade, rather than run checks unconfined, when sandbox-exec is missing', async () => {
    internals.sandboxExecutable = '/nonexistent/sandbox-exec'
    const { job, repo } = await harness({ sandboxChecks: true })
    const outcome = await job('baseline run.json')
    expect(outcome).toMatchObject({ status: 'failed', detail: matching(/^grading refused: \/nonexistent\/sandbox-exec could not run \(.+\); checks never run unconfined while sandboxChecks is on$/) })
    const trials = join(repo, '.agents', 'self-improve', 'loader', 'trials')
    const [evaluation = ''] = await readdir(trials)
    const record = JSON.parse(await readFile(join(trials, evaluation, 'alpha', '0', 'record.json'), 'utf8')) as Record<string, unknown>
    expect(record['failure']).toMatch(/^grading refused: /)
    await expect(readFile(join(trials, evaluation, 'alpha', '0', 'result.json'), 'utf8')).rejects.toThrow(/ENOENT/)
  })

  it.runIf(process.platform === 'darwin')('denies a check writing outside its trial\'s directories, and the trial\'s result says why', async () => {
    const { job, repo } = await harness({ sandboxChecks: true })
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'dsh-self-improve-outside-')))
    roots.push(outside)
    const escape = join(outside, 'escape.txt')
    await writeFile(join(repo, 'suite.json'), JSON.stringify({
      tasks: [
        { id: 'alpha', split: 'evolve', prompt: 'Report when done.', checks: [{ command: ['node', '-e', `require('fs').writeFileSync(${JSON.stringify(escape)}, 'x')`], timeoutMs: 60_000 }] },
        { id: 'gamma', split: 'heldout', prompt: 'Report when done.', checks: [{ answer: 'all done' }] },
      ],
    }))
    expect(await job('baseline run.json')).toMatchObject({ status: 'completed', result: matching(/: score 0\.0000$/) })
    expect(existsSync(escape)).toBe(false)
    const trials = join(repo, '.agents', 'self-improve', 'loader', 'trials')
    const [evaluation = ''] = await readdir(trials)
    const result = JSON.parse(await readFile(join(trials, evaluation, 'alpha', '0', 'result.json'), 'utf8')) as { readonly checks: readonly unknown[] }
    expect(result.checks).toEqual([{ check: matching(/^command node -e /), passed: false, detail: `Error: EPERM: operation not permitted, open '${escape}'` }])
  })

  it('keeps trial scratch in the operating system temporary directory by default and forwards named variables', async () => {
    process.env['SELF_IMPROVE_TEST_FORWARDED'] = 'forwarded value'
    try {
      const { job } = await harness({
        scratch: '',
        // With sandboxChecks off, checks run unconfined, as they did before the setting existed.
        sandboxChecks: false,
        spec: { trial: { policyPatches: ['policy.patch.yml'], provider: 'mock', model: 'm', env: { FAKE_TEXT: 'all done' }, forwardEnv: ['SELF_IMPROVE_TEST_FORWARDED'] } },
      })
      expect(await job('baseline run.json')).toMatchObject({ status: 'completed', result: matching(/: score 0\.5000$/) })
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
