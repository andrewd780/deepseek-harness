import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TaskId } from '../src/brand.ts'
import { loadSuite, runChecks } from '../src/suite.ts'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'dsh-self-improve-suite-'))
  roots.push(path)
  return path
}

async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    return error as Error
  }
  throw new Error('expected the suite to be rejected')
}

async function suiteFile(directory: string, value: unknown): Promise<string> {
  const path = join(directory, 'suite.json')
  await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value))
  return path
}

describe('loadSuite', () => {
  it('reads tasks, checks, briefs, smoke tasks, and critic patterns', async () => {
    const directory = await root()
    await mkdir(join(directory, 'fixtures', 'hello'), { recursive: true })
    const suite = await loadSuite(await suiteFile(directory, {
      briefs: { critic: 'Tasks edit small repositories.' },
      criticPatterns: [{ pattern: 'fixtures/', reason: 'names a fixture' }],
      smoke: ['hello'],
      tasks: [
        { id: 'hello', split: 'evolve', prompt: 'Say hello.', workspace: 'fixtures/hello', checks: [{ answer: 'hello' }, { file: 'out.txt', matches: '^ok$' }] },
        { id: 'later', split: 'heldout', prompt: 'Run it.', checks: [{ command: ['node', '-e', '0'], timeoutMs: 1000 }] },
      ],
    }))
    expect(suite.briefs).toEqual({ analyst: '', proposer: '', critic: 'Tasks edit small repositories.' })
    expect(suite.smoke).toEqual(['hello'])
    expect(suite.criticPatterns[0]?.pattern.test('fixtures/hello')).toBe(true)
    expect(suite.tasks.get(TaskId('hello'))).toMatchObject({ split: 'evolve', workspace: join(directory, 'fixtures', 'hello') })
    expect(suite.tasks.get(TaskId('later'))).toMatchObject({ split: 'heldout', checks: [{ command: ['node', '-e', '0'], timeoutMs: 1000 }] })
    expect(suite.tasks.get(TaskId('later'))?.workspace).toBeUndefined()
  })

  it('names every problem', async () => {
    const directory = await root()
    const path = await suiteFile(directory, {
      briefs: { analyst: 3 },
      criticPatterns: [{ pattern: '(', reason: 'x' }, { pattern: 'ok' }, 'bad'],
      smoke: ['missing'],
      tasks: [
        'not an object',
        { id: 'bad id', split: 'later', prompt: ' ', workspace: 'absent', checks: [] },
        { id: 'a', split: 'heldout', prompt: 'p', workspace: 3, checks: [7, {}, { answer: 4 }, { file: '/abs', matches: 'x' }, { file: 'f', matches: '[' }] },
        { id: 'b', split: 'heldout', prompt: 'p', checks: [{ command: [], timeoutMs: 1 }, { command: ['x'], timeoutMs: 0 }, { command: ['x', 2], timeoutMs: 1 }] },
        { id: 'c', split: 'heldout', prompt: 'p', checks: [{ answer: 'x' }] },
        { id: 'c', split: 'heldout', prompt: 'p', checks: [{ answer: 'x' }] },
        { id: 'd', split: 'heldout', prompt: 'p', workspace: 'suite.json', checks: [{ answer: 'x' }] },
      ],
    })
    const rejected = await failure(loadSuite(path))
    expect(rejected.message.split('\n- ').slice(1)).toEqual([
      'briefs.analyst must be a string',
      'tasks[0] must be an object',
      'tasks[1].id must be letters, digits, \'.\', \'_\', or \'-\'',
      'tasks[1].split must be "evolve" or "heldout"',
      'tasks[1].prompt must be non-empty text',
      'tasks[1].workspace must name an existing directory',
      'tasks[1].checks must be a non-empty array',
      'tasks[2].workspace must name an existing directory',
      'tasks[2].checks[0] must be an object',
      'tasks[2].checks[1] must have one of answer, file, or command',
      'tasks[2].checks[2].answer must be a regular expression string',
      'tasks[2].checks[3].file must be a relative path',
      expect.stringMatching(/^tasks\[2\]\.checks\[4\]\.matches is not a valid regular expression: /),
      'tasks[3].checks[0].command must be a non-empty array of strings',
      'tasks[3].checks[1].timeoutMs must be a positive integer',
      'tasks[3].checks[2].command must be a non-empty array of strings',
      'tasks[5].id c repeats an earlier task',
      'tasks[6].workspace must name an existing directory',
      'at least one task must have split "evolve"',
      'smoke names unknown task missing',
      expect.stringMatching(/^criticPatterns\[0\]\.pattern is not a valid regular expression: /),
      'criticPatterns[1].reason must be a string',
      'criticPatterns[2] must be an object',
    ])
  })

  it('rejects files that are not suites', async () => {
    const directory = await root()
    await expect(loadSuite(await suiteFile(directory, '{'))).rejects.toThrow('is not JSON')
    await expect(loadSuite(await suiteFile(directory, []))).rejects.toThrow('the suite must be a JSON object')
    const shapes = await failure(loadSuite(await suiteFile(directory, { tasks: [{ id: 'a', split: 'evolve', prompt: 'p', checks: 'x' }, { id: 'b', split: 'evolve', prompt: 'p', checks: [{ command: 'x', timeoutMs: 1 }] }] })))
    expect(shapes.message.split('\n- ').slice(1)).toEqual([
      'tasks[0].checks must be a non-empty array',
      'tasks[1].checks[0].command must be a non-empty array of strings',
      'at least one task must have split "evolve"',
    ])
    await expect(loadSuite(await suiteFile(directory, {}))).rejects.toThrow('tasks must be a non-empty array')
    const invalid = await failure(loadSuite(await suiteFile(directory, { tasks: [], smoke: 'x', briefs: [], criticPatterns: {} })))
    expect(invalid.message.split('\n- ').slice(1)).toEqual([
      'briefs must be an object',
      'tasks must be a non-empty array',
      'at least one task must have split "evolve"',
      'smoke must be an array of strings',
      'criticPatterns must be an array',
    ])
  })
})

describe('runChecks', () => {
  it('scores answers, workspace files, and commands', async () => {
    const workspace = await root()
    const outside = await root()
    await writeFile(join(workspace, 'out.txt'), 'ok')
    await writeFile(join(outside, 'secret.txt'), 'ok')
    await symlink(join(outside, 'secret.txt'), join(workspace, 'link.txt'))
    await mkdir(join(workspace, 'dir'))
    const run = vi.fn(async () => true)
    const signal = new AbortController().signal
    const results = await runChecks({
      id: TaskId('t'),
      split: 'evolve',
      prompt: 'p',
      checks: [
        { answer: /hello/ },
        { file: 'out.txt', matches: /^ok$/ },
        { file: 'missing.txt', matches: /ok/ },
        { file: 'link.txt', matches: /ok/ },
        { file: 'dir', matches: /ok/ },
        { command: ['node', 'check.mjs'], timeoutMs: 5 },
      ],
    }, 'well hello', workspace, run, signal)
    expect(results).toEqual([
      { check: 'answer hello', passed: true },
      { check: 'file out.txt ^ok$', passed: true },
      { check: 'file missing.txt ok', passed: false },
      { check: 'file link.txt ok', passed: false },
      { check: 'file dir ok', passed: false },
      { check: 'command node check.mjs', passed: true },
    ])
    expect(run).toHaveBeenCalledWith(['node', 'check.mjs'], workspace, 5, signal)
  })
})
