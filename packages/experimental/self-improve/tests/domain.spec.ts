import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DeepSeekHarnessOptions } from '@deepseek-ai/dsh-sdk-client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EvaluationJobId, TaskId } from '../src/brand.ts'
import { FIRST_REQUEST_MEASURE, SuiteDomain, pool } from '../src/domain.ts'
import type { SuiteDomainSettings } from '../src/domain.ts'
import { OVERLAY_FILE, describeOverlayRules } from '../src/overlay.ts'
import type { Suite } from '../src/suite.ts'
import { DSH_COMPONENTS, DSH_OVERLAY_RULES } from '../src/evolved-directory.ts'
import { useFakeRuntime } from './fake-runtime.ts'
import { evaluation } from './fixtures.ts'

const roots: string[] = []
let fake: ReturnType<typeof useFakeRuntime> | undefined

afterEach(async () => {
  fake?.restore()
  fake = undefined
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function setup(overrides: Partial<SuiteDomainSettings> = {}, overlay: string | undefined = '[]\n') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-self-improve-domain-')))
  roots.push(root)
  const checkout = join(root, 'checkout')
  const evolved = join(checkout, 'evolved')
  await mkdir(join(evolved, 'skills', 'check'), { recursive: true })
  await writeFile(join(evolved, 'AGENTS.md'), 'Work carefully.\n')
  await writeFile(join(evolved, 'skills', 'check', 'SKILL.md'), '# Check\n')
  if (overlay !== undefined) await writeFile(join(evolved, OVERLAY_FILE), overlay)
  const fixture = join(root, 'fixtures', 'hello')
  await mkdir(fixture, { recursive: true })
  await writeFile(join(fixture, 'seed.txt'), 'seed\n')
  const suite: Suite = {
    briefs: { analyst: 'a', proposer: 'p', critic: 'c' },
    criticPatterns: [],
    smoke: [],
    tasks: new Map([
      [TaskId('hello'), { id: TaskId('hello'), split: 'evolve', prompt: 'Say all done.', workspace: fixture, checks: [{ answer: /all done/ }, { file: 'seed.txt', matches: /seed/ }, { command: ['node', 'check.mjs'], timeoutMs: 1_000 }] }],
      [TaskId('other'), { id: TaskId('other'), split: 'evolve', prompt: 'Say never.', checks: [{ answer: /never/ }] }],
      [TaskId('later'), { id: TaskId('later'), split: 'heldout', prompt: 'Later.', checks: [{ answer: /x/ }] }],
    ]),
  }
  const runCommand = vi.fn(async (_argv: readonly string[], cwd: string) => existsSync(join(cwd, 'seed.txt')))
  const homes: {
    readonly agents: string
    readonly skill: string
    readonly agentsHome: string | undefined
    readonly overlay: string | undefined
  }[] = []
  fake = useFakeRuntime((options: DeepSeekHarnessOptions) => {
    const home = options.dshHome ?? ''
    const overlay = options.patches?.find(patch => patch.endsWith(OVERLAY_FILE))
    homes.push({
      agents: readFileSync(join(home, 'AGENTS.md'), 'utf8'),
      skill: readFileSync(join(home, 'skills', 'check', 'SKILL.md'), 'utf8'),
      agentsHome: options.env?.['DSH_AGENTS_HOME'],
      overlay: overlay === undefined ? undefined : readFileSync(overlay, 'utf8'),
    })
  })
  const settings: SuiteDomainSettings = {
    suite,
    componentSet: DSH_COMPONENTS,
    overlayRules: DSH_OVERLAY_RULES,
    runRoot: join(root, 'run'),
    evolvedDirectory: 'evolved',
    scratch: join(root, 'scratch'),
    profile: 'sdk',
    policyPatches: ['/policy.patch.yml'],
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    environment: () => ({ FAKE_TEXT: 'all done' }),
    trialTimeoutMs: 20_000,
    shutdownTimeoutMs: 5_000,
    concurrency: 2,
    runCommand,
    maxTraceCharacters: 500,
    maxPromptGrowth: 0.1,
    ...overrides,
  }
  return { root, checkout, suite, runCommand, homes, settings, domain: new SuiteDomain(settings) }
}

const request = (root: string, job: string, tasks: string[], trials = 2) => ({
  root,
  job: EvaluationJobId(job),
  tasks: tasks.map(task => TaskId(task)),
  trials,
})

describe('SuiteDomain', () => {
  it('splits the suite and picks smoke tasks', async () => {
    const { domain, settings } = await setup()
    expect(domain.evolveTasks()).toEqual(['hello', 'other'])
    expect(domain.heldoutTasks()).toEqual(['later'])
    expect(domain.smokeTasks(evaluation('base', { other: [0, 0], hello: [1, 0] }))).toEqual(['hello'])
    expect(domain.smokeTasks(evaluation('base', {}))).toEqual(['hello'])
    expect(new SuiteDomain({ ...settings, suite: { ...settings.suite, smoke: [TaskId('other')] } }).smokeTasks(evaluation('base', {}))).toEqual(['other'])
    expect(domain.briefs).toEqual({ analyst: 'a', proposer: `${describeOverlayRules(DSH_OVERLAY_RULES)}\n\np`, critic: 'c' })
    const unbriefed = new SuiteDomain({ ...settings, suite: { ...settings.suite, briefs: { ...settings.suite.briefs, proposer: '' } } })
    expect(unbriefed.briefs.proposer).toBe(describeOverlayRules(DSH_OVERLAY_RULES))
    expect(domain.componentSet).toBe(DSH_COMPONENTS)
  })

  it('measures each trial in a fresh runtime with the evolved directory and scores it by the checks', async () => {
    const { domain, checkout, homes, runCommand, root } = await setup()
    const result = await domain.evaluate(request(checkout, 'j1', ['hello', 'other']))
    expect(result.perTask.get(TaskId('hello'))?.rewards).toEqual([1, 1])
    expect(result.perTask.get(TaskId('other'))?.rewards).toEqual([0, 0])
    expect(result).toMatchObject({ score: 0.5, cost: undefined, missing: 0, measures: {} })
    expect(fake?.launches.map(launch => launch.patches)).toEqual(Array.from({ length: 4 }, () => ['/policy.patch.yml']))
    expect(homes.map(home => [home.agents, home.skill])).toEqual(Array.from({ length: 4 }, () => ['Work carefully.\n', '# Check\n']))
    expect(homes.every(home => home.agentsHome?.startsWith(join(root, 'scratch')) === true)).toBe(true)
    expect(runCommand).toHaveBeenCalledTimes(2)
    const stored: unknown = JSON.parse(await readFile(join(root, 'run', 'trials', 'j1', 'hello', '0', 'result.json'), 'utf8'))
    expect(stored).toEqual({ reward: 1, tokens: null, firstRequestInputTokens: null, checks: [
      { check: 'answer all done', passed: true },
      { check: 'file seed.txt seed', passed: true },
      { check: 'command node check.mjs', passed: true },
    ] })
    const launches = fake?.launches.length
    expect(await domain.evaluate(request(checkout, 'j1', ['hello', 'other']))).toEqual(result)
    expect(fake?.launches.length).toBe(launches)
    const trace = await domain.renderTrace(EvaluationJobId('j1'), TaskId('hello'), 0)
    expect(trace).toContain('[assistant] all done')
    expect(trace).toContain('[check passed] file seed.txt seed')
    expect(await domain.renderTrace(EvaluationJobId('j1'), TaskId('later'), 0)).toBeUndefined()
  })

  it('counts a failed runtime as a missing trial, runs it again, and reports it from the smoke check', async () => {
    const { domain, checkout, root } = await setup({ environment: () => ({ FAKE_INIT_ERROR: '1' }) }, undefined)
    const smoke = await domain.smoke(request(checkout, 's1', ['other'], 1))
    expect(smoke).toEqual({ ok: false, detail: '1 of 1 smoke trial(s) produced no result: other#0: scripted init failure' })
    expect(fake?.launches[0]?.patches).toEqual(['/policy.patch.yml'])
    expect(existsSync(join(root, 'run', 'trials', 's1', 'other', '0', 'result.json'))).toBe(false)
    const again = await domain.evaluate(request(checkout, 's1', ['other'], 1))
    expect(again.missing).toBe(1)
    expect(fake?.launches).toHaveLength(2)
    expect(await domain.renderTrace(EvaluationJobId('s1'), TaskId('other'), 0)).toBe('[trial failed] scripted init failure')
  })

  it('passes a smoke check whose trials all ran', async () => {
    const { domain, checkout } = await setup()
    expect(await domain.smoke(request(checkout, 's2', ['other'], 1))).toEqual({ ok: true, detail: '1 smoke trial(s) ran' })
  })

  it('hands each trial a JSON copy of the checked overlay, beside its workspace', async () => {
    const overlay = '# tuned\n- id: compaction-basic\n  config:\n    thresholdRatio: 0.6\n- id: tool-web\n  disabled: true\n'
    const { domain, checkout, homes, root } = await setup({}, overlay)
    expect(await domain.screen(checkout)).toEqual([])
    await domain.evaluate(request(checkout, 'j1', ['other'], 1))
    const patches = fake?.launches.map(launch => launch.patches) ?? []
    expect(patches).toHaveLength(1)
    expect(patches[0]?.[1]).toBe('/policy.patch.yml')
    expect(patches[0]?.[0]?.startsWith(join(root, 'scratch', 'trial-'))).toBe(true)
    expect(homes.map(home => home.overlay)).toEqual(['[{"id":"compaction-basic","config":{"thresholdRatio":0.6}},{"id":"tool-web","disabled":true}]\n'])
  })

  it('refuses to measure a checkout whose overlay breaks the rules', async () => {
    const { domain, checkout } = await setup({}, '- id: sandbox-policy\n  config:\n    mode: danger-full-access\n')
    const objection = 'overlay.patch.yml entry 1 (sandbox-policy): its config cannot change; entries whose config can change: compaction-basic, tool-result-pruner, spill-policy, system-prompt, repeat-tool-reminder'
    expect(await domain.screen(checkout)).toEqual([objection])
    await expect(domain.evaluate(request(checkout, 'j1', ['other'], 1))).rejects.toThrow(`self-improve overlay of ${checkout} breaks the overlay rules: ${objection}`)
    expect(fake?.launches).toEqual([])
  })

  it('screens a checkout without an overlay as acceptable', async () => {
    const { domain, checkout } = await setup({}, undefined)
    expect(await domain.screen(checkout)).toEqual([])
  })

  it('guards the growth of the first request\'s prompt', async () => {
    const { domain, settings } = await setup()
    const at = (tokens: number | undefined) => evaluation('x', { a: [1] }, {}, tokens === undefined ? {} : { [FIRST_REQUEST_MEASURE]: tokens })
    expect(domain.guards(at(100), at(120))).toEqual(['the first request\'s prompt grew 20.0% (limit 10.0%)'])
    expect(domain.guards(at(100), at(110))).toEqual([])
    expect(domain.guards(at(undefined), at(120))).toEqual([])
    expect(domain.guards(at(100), at(undefined))).toEqual([])
    expect(domain.guards(at(0), at(120))).toEqual([])
    expect(new SuiteDomain({ ...settings, maxPromptGrowth: undefined }).guards(at(100), at(200))).toEqual([])
  })

  it('rejects stored trial files that are not what they claim to be', async () => {
    const { domain, checkout, root } = await setup()
    const directory = join(root, 'run', 'trials', 'bad', 'hello', '0')
    await mkdir(directory, { recursive: true })
    for (const [content, message] of [
      ['{"reward":"high","checks":[]}', 'is not a self-improve trial result'],
      ['{"reward":1,"checks":[],"tokens":"x","firstRequestInputTokens":null}', 'is not a self-improve trial result'],
      ['{"reward":1,"checks":[{"check":1}],"tokens":null,"firstRequestInputTokens":null}', 'is not a self-improve trial result'],
      ['{', 'is not JSON'],
    ] as const) {
      await writeFile(join(directory, 'result.json'), content)
      await expect(domain.evaluate(request(checkout, 'bad', ['hello'], 1))).rejects.toThrow(message)
    }
    await rm(join(directory, 'result.json'))
    await mkdir(join(directory, 'result.json'))
    await expect(domain.evaluate(request(checkout, 'bad', ['hello'], 1))).rejects.toMatchObject({ code: 'EISDIR' })
    await rm(join(directory, 'result.json'), { recursive: true })
    for (const content of ['{"sessionId":1,"events":[]}', '{"sessionId":"s","events":[1]}', '{"sessionId":"s","events":[],"failure":3}']) {
      await writeFile(join(directory, 'record.json'), content)
      await expect(domain.renderTrace(EvaluationJobId('bad'), TaskId('hello'), 0)).rejects.toThrow('is not a self-improve trial record')
    }
    await writeFile(join(directory, 'result.json'), JSON.stringify({ reward: 1, tokens: 7, firstRequestInputTokens: 3, checks: [] }))
    expect((await domain.evaluate(request(checkout, 'bad', ['hello'], 1))).measures).toEqual({ [FIRST_REQUEST_MEASURE]: 3 })
    await expect(domain.evaluate(request(checkout, 'bad', ['missing'], 1))).rejects.toThrow('self-improve suite has no task missing')
  })
})

describe('pool', () => {
  it('keeps item order and stops starting work after a failure', async () => {
    expect(await pool([3, 1, 2], 2, async item => await new Promise<number>((resolve) => {
      setTimeout(() => {
        resolve(item * 10)
      }, item)
    }))).toEqual([30, 10, 20])
    expect(await pool([], 4, async item => item)).toEqual([])
    const started: number[] = []
    await expect(pool([1, 2, 3, 4], 1, async (item) => {
      started.push(item)
      if (item === 2) throw new Error('item 2 failed')
      return item
    })).rejects.toThrow('item 2 failed')
    expect(started).toEqual([1, 2])
    const slow: number[] = []
    await expect(pool([1, 2, 3], 2, async (item) => {
      if (item === 1) throw new Error('first failed')
      await new Promise((resolve) => {
        setTimeout(resolve, 5)
      })
      slow.push(item)
      return item
    })).rejects.toThrow('first failed')
    expect(slow).toEqual([2])
  })
})
