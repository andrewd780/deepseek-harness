import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureStarterRun } from '../src/bootstrap.ts'
import type { ProcessRunner } from '../src/process.ts'
import { starterFiles } from '../src/template.ts'
import type { StarterRoute } from '../src/template.ts'
import { execRunner } from './exec-runner.ts'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

const route: StarterRoute = { provider: 'ollama', model: 'qwen38-27b-abliterated-mlx-q4:latest', baseUrl: 'http://localhost:11434/v1', contextWindow: 32_768, rounds: 3 }
const git = { run: execRunner, timeoutMs: 30_000 }

async function base(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-self-improve-bootstrap-')))
  roots.push(root)
  return root
}

async function gitOutput(cwd: string, ...args: string[]): Promise<string> {
  const result = await execRunner({ argv: ['git', ...args], cwd, timeoutMs: 30_000 })
  return result.stdout.trim()
}

describe('ensureStarterRun', () => {
  it('creates the starter run as a git repository with one commit holding every starter file', async () => {
    const directory = join(await base(), 'self-improve', 'auto')
    expect(await ensureStarterRun(directory, route, git)).toEqual({ created: true, spec: join(directory, 'run.json') })
    for (const [path, content] of starterFiles(route)) expect(await readFile(join(directory, path), 'utf8')).toBe(content)
    expect(await gitOutput(directory, 'log', '--format=%an <%ae> %s')).toBe('dsh self-improve <self-improve@dsh.invalid> self-improve starter run')
    expect(await gitOutput(directory, 'branch', '--show-current')).toBe('main')
    expect(await gitOutput(directory, 'status', '--porcelain')).toBe('')
    expect((await gitOutput(directory, 'ls-files')).split('\n').sort()).toEqual([...starterFiles(route).keys()].sort())
    expect(await readdir(join(directory, '..'))).toEqual(['auto'])
  })

  it('never overwrites an existing run', async () => {
    const directory = join(await base(), 'auto')
    await ensureStarterRun(directory, route, git)
    await writeFile(join(directory, 'run.json'), '{"name": "mine"}\n')
    expect(await ensureStarterRun(directory, { ...route, model: 'other' }, git)).toEqual({ created: false, spec: join(directory, 'run.json') })
    expect(await readFile(join(directory, 'run.json'), 'utf8')).toBe('{"name": "mine"}\n')
  })

  it('creates the run in an empty directory and refuses a directory holding something else', async () => {
    const root = await base()
    await mkdir(join(root, 'empty'))
    expect(await ensureStarterRun(join(root, 'empty'), route, git)).toMatchObject({ created: true })
    await mkdir(join(root, 'busy'))
    await writeFile(join(root, 'busy', 'notes.txt'), 'mine\n')
    await expect(ensureStarterRun(join(root, 'busy'), route, git)).rejects.toThrow(`self-improve automatic run directory ${join(root, 'busy')} exists without run.json; move it away or set auto.directory to another path`)
    expect(await readdir(join(root, 'busy'))).toEqual(['notes.txt'])
  })

  it('leaves nothing behind when git fails', async () => {
    const root = await base()
    const failing: ProcessRunner = async () => ({ exitCode: 128, stdout: '', stderr: 'fatal: no git here' })
    await expect(ensureStarterRun(join(root, 'auto'), route, { run: failing, timeoutMs: 1000 })).rejects.toThrow('git init -q -b main failed with exit code 128: fatal: no git here')
    expect(await readdir(root)).toEqual([])
  })
})
