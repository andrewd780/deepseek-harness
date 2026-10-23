import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CHECK_SANDBOX_POLICY, confinedCheckRunner, GradingRefused, outcomeOf, SANDBOX_EXEC, unconfinedCheckRunner } from '../src/check-sandbox.ts'
import type { CheckArea } from '../src/check-sandbox.ts'
import type { ProcessRequest, ProcessResult, ProcessRunner } from '../src/process.ts'
import { execRunner } from './exec-runner.ts'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

const darwin = process.platform === 'darwin'
const resolveNode = async (program: string): Promise<string> => (program === 'node' ? process.execPath : program)

async function area(name = 'workspace'): Promise<CheckArea & { readonly root: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-self-improve-sandbox-')))
  roots.push(root)
  await mkdir(join(root, name))
  await mkdir(join(root, 'tmp'))
  return { root, workspace: join(root, name), temp: join(root, 'tmp') }
}

describe('confinedCheckRunner', () => {
  it('runs the resolved program under sandbox-exec with the trial\'s directories as parameters and TMPDIR in its temporary directory', async () => {
    const requests: ProcessRequest[] = []
    const run: ProcessRunner = async (request) => {
      requests.push(request)
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    const signal = new AbortController().signal
    const check = confinedCheckRunner({ run, resolve: async program => `/resolved/${program}`, executable: SANDBOX_EXEC }, { workspace: '/w "x"', temp: '/t' })
    expect(await check(['node', 'check.mjs'], '/w "x"', 5000, signal)).toEqual({ passed: true })
    expect(requests).toEqual([{
      argv: [SANDBOX_EXEC, '-D', 'WORKSPACE=/w "x"', '-D', 'TEMP=/t', '-p', CHECK_SANDBOX_POLICY, '/resolved/node', 'check.mjs'],
      cwd: '/w "x"',
      timeoutMs: 5000,
      signal,
      env: { TMPDIR: '/t' },
    }])
    // The policy text never holds a path.
    expect(CHECK_SANDBOX_POLICY).not.toContain('/w')
  })

  it('refuses to grade when sandbox-exec cannot run or reports a failure of its own, and passes cancellation through', async () => {
    const settings = (run: ProcessRunner) => ({ run, resolve: resolveNode, executable: '/missing/sandbox-exec' })
    const missing = confinedCheckRunner(settings(async () => {
      throw new Error('spawn /missing/sandbox-exec ENOENT')
    }), { workspace: '/w', temp: '/t' })
    await expect(missing(['node'], '/w', 1000)).rejects.toThrow(new GradingRefused('grading refused: /missing/sandbox-exec could not run (spawn /missing/sandbox-exec ENOENT); checks never run unconfined while sandboxChecks is on'))
    const text = confinedCheckRunner(settings(async () => {
      throw 'no such program'
    }), { workspace: '/w', temp: '/t' })
    await expect(text(['node'], '/w', 1000)).rejects.toThrow('could not run (no such program)')
    const broken = confinedCheckRunner(settings(async () => ({ exitCode: 65, stdout: '', stderr: 'sandbox-exec: unbound variable: x\nBacktrace\n' })), { workspace: '/w', temp: '/t' })
    await expect(broken(['node'], '/w', 1000)).rejects.toThrow(new GradingRefused('grading refused: sandbox-exec: unbound variable: x'))
    const controller = new AbortController()
    const aborted = confinedCheckRunner(settings(async () => {
      controller.abort(new Error('operator stop'))
      throw new Error('killed')
    }), { workspace: '/w', temp: '/t' })
    await expect(aborted(['node'], '/w', 1000, controller.signal)).rejects.toThrow('operator stop')
    expect(new GradingRefused('x').name).toBe('GradingRefused')
  })

  it.runIf(darwin)('denies a check writing outside its directories, and the outcome says why', async () => {
    const { root, workspace, temp } = await area()
    const outside = join(root, 'outside')
    await mkdir(outside)
    const check = confinedCheckRunner({ run: execRunner, resolve: resolveNode, executable: SANDBOX_EXEC }, { workspace, temp })
    const write = (path: string): readonly [string, ...string[]] => ['node', '-e', `require('fs').writeFileSync(${JSON.stringify(path)}, 'x')`]
    const denied = await check(write(join(outside, 'escape.txt')), workspace, 30_000)
    expect(denied).toEqual({ passed: false, detail: `Error: EPERM: operation not permitted, open '${join(outside, 'escape.txt')}'` })
    expect(existsSync(join(outside, 'escape.txt'))).toBe(false)
    expect(await check(write(join(workspace, 'inside.txt')), workspace, 30_000)).toEqual({ passed: true })
    expect(await check(['node', '-e', 'require(\'fs\').mkdtempSync(require(\'path\').join(require(\'os\').tmpdir(), \'c-\'))'], workspace, 30_000)).toEqual({ passed: true })
    expect(await readFile(join(workspace, 'inside.txt'), 'utf8')).toBe('x')
    // The same write succeeds unconfined, so the denial is the sandbox's.
    const control = write(join(outside, 'control.txt'))
    expect(await unconfinedCheckRunner(execRunner)([process.execPath, ...control.slice(1)], workspace, 30_000)).toEqual({ passed: true })
  }, 60_000)

  it.runIf(darwin)('denies a check opening a network socket', async () => {
    const { workspace, temp } = await area()
    const server = createServer(socket => socket.end())
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve)
    })
    try {
      const { port } = server.address() as AddressInfo
      const connect = `const s = require('net').connect(${port}, '127.0.0.1'); s.on('connect', () => process.exit(0)); s.on('error', (e) => { console.error('Error: ' + e.code); process.exit(1) })`
      const check = confinedCheckRunner({ run: execRunner, resolve: resolveNode, executable: SANDBOX_EXEC }, { workspace, temp })
      expect(await check(['node', '-e', connect], workspace, 30_000)).toEqual({ passed: false, detail: 'Error: EPERM' })
      expect(await unconfinedCheckRunner(execRunner)([process.execPath, '-e', connect], workspace, 30_000)).toEqual({ passed: true })
    } finally {
      server.close()
    }
  }, 60_000)

  it.runIf(darwin)('confines a workspace whose path holds quotes, spaces, and parentheses', async () => {
    const { workspace, temp } = await area('a "quoted" (dir) with spaces')
    const check = confinedCheckRunner({ run: execRunner, resolve: resolveNode, executable: SANDBOX_EXEC }, { workspace, temp })
    expect(await check(['node', '-e', 'require(\'fs\').writeFileSync(\'ok.txt\', \'x\')'], workspace, 30_000)).toEqual({ passed: true })
    expect(existsSync(join(workspace, 'ok.txt'))).toBe(true)
  }, 60_000)
})

describe('outcomeOf', () => {
  const result = (exitCode: number | null, stderr: string): ProcessResult => ({ exitCode, stdout: '', stderr })

  it('passes on exit 0 and otherwise keeps the first error line, the last line, or how the command ended', () => {
    expect(outcomeOf(result(0, 'noise'))).toEqual({ passed: true })
    expect(outcomeOf(result(1, 'at x\nTypeError: bad thing\n  at y\nNode.js v25\n'))).toEqual({ passed: false, detail: 'TypeError: bad thing' })
    expect(outcomeOf(result(1, 'the first Unreleased entry is ""\n'))).toEqual({ passed: false, detail: 'the first Unreleased entry is ""' })
    expect(outcomeOf(result(2, ''))).toEqual({ passed: false, detail: 'exited with 2' })
    expect(outcomeOf(result(null, '  \n'))).toEqual({ passed: false, detail: 'exited by a signal or its deadline' })
    expect(outcomeOf(result(1, 'x'.repeat(400))).detail).toHaveLength(300)
  })
})
