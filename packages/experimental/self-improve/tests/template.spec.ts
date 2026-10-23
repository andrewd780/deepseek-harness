import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { loadRunSpec } from '../src/spec.ts'
import { loadSuite, runChecks } from '../src/suite.ts'
import type { CommandRunner, Suite } from '../src/suite.ts'
import { STARTER_TASKS, starterFiles } from '../src/template.ts'
import type { StarterRoute } from '../src/template.ts'
import { STARTER_SOLUTIONS } from './fixtures/starter-solutions.ts'

const route: StarterRoute = { provider: 'ollama', model: 'qwen38-27b-abliterated-mlx-q4:latest', baseUrl: 'http://localhost:11434/v1', contextWindow: 32_768, rounds: 3 }

/** Runs a check command on the host's Node, like the subprocess runner does with `node` on the PATH. */
const node: CommandRunner = async (argv, cwd, timeoutMs) => await new Promise((resolve) => {
  const [program, ...args] = argv
  execFile(program === 'node' ? process.execPath : program, args, { cwd, timeout: timeoutMs }, (error) => {
    resolve(error === null)
  })
})

let root = ''
let suite: Suite

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-self-improve-template-')))
  for (const [path, content] of starterFiles(route)) {
    await mkdir(dirname(join(root, 'run', path)), { recursive: true })
    await writeFile(join(root, 'run', path), content)
  }
  suite = await loadSuite(join(root, 'run', 'suite.json'))
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

async function workspace(task: string, solved: boolean): Promise<string> {
  const directory = join(await mkdtemp(join(root, `${task}-`)), 'workspace')
  await cp(join(root, 'run', 'tasks', task), directory, { recursive: true })
  if (solved) {
    for (const [path, content] of Object.entries(STARTER_SOLUTIONS[task] ?? {})) {
      await mkdir(dirname(join(directory, path)), { recursive: true })
      await writeFile(join(directory, path), content)
    }
  }
  return directory
}

describe('the starter run', () => {
  it('holds six evolve tasks, two held-out tasks, and a solution for each', () => {
    expect(STARTER_TASKS.filter(task => task.split === 'evolve').map(task => task.id)).toEqual([
      'range-bug', 'duration-tests', 'invoice-refactor', 'changelog-entry', 'config-crash', 'wrap-implement',
    ])
    expect(STARTER_TASKS.filter(task => task.split === 'heldout').map(task => task.id)).toEqual(['leaderboard-bug', 'readme-option'])
    expect(Object.keys(STARTER_SOLUTIONS).sort()).toEqual(STARTER_TASKS.map(task => task.id).sort())
    expect([...suite.tasks.keys()]).toEqual(STARTER_TASKS.map(task => task.id))
  })

  it('loads as a run spec with the route, the small-window limits, and the spread calibration', async () => {
    const spec = await loadRunSpec(join(root, 'run', 'run.json'))
    expect(spec).toMatchObject({
      name: 'auto',
      evolvedDirectory: 'evolved',
      trial: { provider: 'ollama', model: route.model, env: { OLLAMA_API_KEY: 'ollama' }, maxTraceCharacters: 400, policyPatches: [join(root, 'run', 'policy.patch.yml')] },
      roles: { provider: 'ollama', model: route.model, maxOutputTokens: 4096, maxHistoryDiffCharacters: 4000, proposerTurns: 12 },
      settings: {
        rounds: 3, variants: 1, trials: 1, historyLimit: 8, failureTraces: 3, successTraces: 1, repairRounds: 1, delta: undefined,
      },
      calibration: { method: 'spread' },
    })
    expect(await readFile(join(root, 'run', 'evolved', 'AGENTS.md'), 'utf8')).toBe('Work carefully. Check your result before you answer.\n')
  })

  it('routes trials to the endpoint and keeps the sandbox at workspace-write', async () => {
    expect(parse(await readFile(join(root, 'run', 'policy.patch.yml'), 'utf8'))).toEqual([
      { id: 'sandbox-policy', config: { mode: 'workspace-write' } },
      {
        id: 'llm-pi-ai',
        config: {
          providers: {
            ollama: {
              api: 'openai-completions',
              baseURL: 'http://localhost:11434/v1',
              apiKeyEnv: 'OLLAMA_API_KEY',
              defaultContextWindow: 32_768,
              defaultMaxTokens: 8192,
              timeoutMs: 900_000,
              streamIdleTimeoutMs: 300_000,
              compat: { supportsDeveloperRole: false, maxTokensField: 'max_tokens' },
              models: [{ id: route.model }],
            },
          },
        },
      },
    ])
  })

  it.each(STARTER_TASKS.map(task => task.id))('%s: every check passes on the solution, and the starting files fail the task', async (id) => {
    const task = suite.tasks.get(id as never)!
    const start = await runChecks(task, '', await workspace(id, false), node)
    const solved = await runChecks(task, '', await workspace(id, true), node)
    expect(solved.map(check => check.passed)).toEqual(task.checks.map(() => true))
    expect(start.some(check => !check.passed)).toBe(true)
  }, 120_000)

  it('fails tests that pass but miss the broken behaviors', async () => {
    const directory = await workspace('duration-tests', false)
    await mkdir(join(directory, 'test'))
    await writeFile(join(directory, 'test', 'duration.test.mjs'), `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseDuration } from '../src/duration.mjs'

test('hours', () => {
  assert.equal(parseDuration('3h'), 10800)
})
`)
    const results = await runChecks(suite.tasks.get('duration-tests' as never)!, '', directory, node)
    expect(results.map(check => check.passed)).toEqual([true, false, true, false])
  }, 120_000)

  it('scores each starting workspace as recorded, so the suite has room to improve on every task', async () => {
    const scores: Record<string, string> = {}
    for (const task of suite.tasks.values()) {
      const results = await runChecks(task, '', await workspace(task.id, false), node)
      scores[task.id] = results.map(check => (check.passed ? 'pass' : 'fail')).join(' ')
    }
    expect(scores).toEqual({
      'range-bug': 'fail fail',
      'duration-tests': 'fail fail fail fail',
      'invoice-refactor': 'pass fail fail pass',
      'changelog-entry': 'fail pass',
      'config-crash': 'fail pass',
      'wrap-implement': 'fail fail',
      'leaderboard-bug': 'fail fail',
      'readme-option': 'fail pass',
    })
  }, 120_000)
})
