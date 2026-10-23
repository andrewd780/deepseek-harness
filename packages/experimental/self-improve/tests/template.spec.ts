import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { confinedCheckRunner, SANDBOX_EXEC, unconfinedCheckRunner } from '../src/check-sandbox.ts'
import { loadRunSpec } from '../src/spec.ts'
import { loadSuite, runChecks } from '../src/suite.ts'
import type { CommandRunner, Suite } from '../src/suite.ts'
import { STARTER_TASKS, starterFiles } from '../src/template.ts'
import type { StarterRoute } from '../src/template.ts'
import { execRunner } from './exec-runner.ts'
import { STARTER_SOLUTIONS } from './fixtures/starter-solutions.ts'

const route: StarterRoute = { provider: 'ollama', model: 'qwen38-27b-abliterated-mlx-q4:latest', baseUrl: 'http://localhost:11434/v1', contextWindow: 32_768, rounds: 3 }

/** Whether checks run under the real `sandbox-exec`, as the plugin runs them by default on macOS. */
const confined = process.platform === 'darwin'

/** The runner the plugin gives a trial: confined to the workspace and its own temporary directory on macOS. */
function checker(workspace: string, temp: string): CommandRunner {
  const resolve = async (program: string): Promise<string> => (program === 'node' ? process.execPath : program)
  if (confined) return confinedCheckRunner({ run: execRunner, resolve, executable: SANDBOX_EXEC }, { workspace, temp })
  const unconfined = unconfinedCheckRunner(execRunner)
  return async ([program, ...args], cwd, timeoutMs) => await unconfined([await resolve(program), ...args], cwd, timeoutMs)
}

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

/** A trial's workspace for `task`, from its starting files or with its reference solution, and its check runner. */
async function workspace(task: string, solved: boolean): Promise<{ readonly directory: string; readonly run: CommandRunner }> {
  const trial = await mkdtemp(join(root, `${task}-`))
  const directory = join(trial, 'workspace')
  await mkdir(join(trial, 'tmp'))
  await cp(join(root, 'run', 'tasks', task), directory, { recursive: true })
  if (solved) {
    for (const [path, content] of Object.entries(STARTER_SOLUTIONS[task] ?? {})) {
      await mkdir(dirname(join(directory, path)), { recursive: true })
      await writeFile(join(directory, path), content)
    }
  }
  return { directory, run: checker(directory, join(trial, 'tmp')) }
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

  it.each(STARTER_TASKS.map(task => task.id))('%s: every check passes on the solution, and the starting files fail the task, under the sandbox on macOS', async (id) => {
    const task = suite.tasks.get(id as never)!
    const start = await workspace(id, false)
    const solution = await workspace(id, true)
    const failing = await runChecks(task, '', start.directory, start.run)
    const solved = await runChecks(task, '', solution.directory, solution.run)
    expect(solved.map(check => check.passed)).toEqual(task.checks.map(() => true))
    expect(failing.some(check => !check.passed)).toBe(true)
    // A denied write or connection would show in a failed check's reason.
    expect(failing.flatMap(check => (check.detail?.includes('EPERM') === true ? [check.detail] : []))).toEqual([])
  }, 120_000)

  it('fails tests that pass but miss the broken behaviors', async () => {
    const { directory, run } = await workspace('duration-tests', false)
    await mkdir(join(directory, 'test'))
    await writeFile(join(directory, 'test', 'duration.test.mjs'), `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseDuration } from '../src/duration.mjs'

test('hours', () => {
  assert.equal(parseDuration('3h'), 10800)
})
`)
    const results = await runChecks(suite.tasks.get('duration-tests' as never)!, '', directory, run)
    expect(results.map(check => check.passed)).toEqual([true, false, true, false])
  }, 120_000)

  it('scores each starting workspace as recorded, so the suite has room to improve on every task', async () => {
    const scores: Record<string, string> = {}
    for (const task of suite.tasks.values()) {
      const { directory, run } = await workspace(task.id, false)
      const results = await runChecks(task, '', directory, run)
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
