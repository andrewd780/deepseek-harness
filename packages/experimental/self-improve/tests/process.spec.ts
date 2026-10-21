import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { PROCESS_TIMEOUT_CODE, subprocessRunner } from '../src/process.ts'

function subprocess(outcome: { exitCode: number | null }, stdout?: string, stderr?: string) {
  const resolveExecutable = vi.fn(async (command: string) => `/usr/bin/${command}`)
  const spawn = vi.fn((_spec: { readonly signal?: AbortSignal }) => ({
    done: Promise.resolve<{ exitCode: number | null; signal: NodeJS.Signals | null }>({ ...outcome, signal: null }),
    collected: {
      ...stdout === undefined ? {} : { stdout: { readFrom: () => ({ text: stdout, nextOffset: stdout.length, lossy: false }) } },
      ...stderr === undefined ? {} : { stderr: { readFrom: () => ({ text: stderr, nextOffset: stderr.length, lossy: false }) } },
    },
  }))
  const ctx = new Context()
  ctx.provide('subprocess', { resolveExecutable, spawn } as never)
  return { ctx, resolveExecutable, spawn }
}

describe('subprocessRunner', () => {
  it('resolves the program, bounds the output, and returns both streams', async () => {
    const { ctx, resolveExecutable, spawn } = subprocess({ exitCode: 0 }, 'out', 'err')
    const run = subprocessRunner(ctx, { maxOutputBytes: 1024, graceMs: 50 })
    expect(await run({ argv: ['git', 'status'], cwd: '/repo', timeoutMs: 1_000, env: { GIT_DIR: undefined } })).toEqual({ exitCode: 0, stdout: 'out', stderr: 'err' })
    expect(resolveExecutable).toHaveBeenCalledWith('git', undefined, expect.any(AbortSignal))
    expect(spawn).toHaveBeenCalledWith({
      argv: ['/usr/bin/git', 'status'],
      cwd: '/repo',
      stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } },
      graceMs: 50,
      signal: expect.any(AbortSignal) as AbortSignal,
      env: { GIT_DIR: undefined },
    })
  })

  it('reports a signal-ended process and absent streams as empty', async () => {
    const { ctx } = subprocess({ exitCode: null })
    expect(await subprocessRunner(ctx, { maxOutputBytes: 1, graceMs: 1 })({ argv: ['node'], cwd: '/', timeoutMs: 1_000 })).toEqual({ exitCode: null, stdout: '', stderr: '' })
  })

  it('aborts the process at its deadline and rethrows caller cancellation', async () => {
    const { ctx, spawn } = subprocess({ exitCode: null })
    const run = subprocessRunner(ctx, { maxOutputBytes: 1, graceMs: 1 })
    spawn.mockImplementationOnce(spec => ({
      done: new Promise(resolve => spec.signal?.addEventListener('abort', () => {
        resolve({ exitCode: null, signal: 'SIGTERM' })
      })),
      collected: {},
    }))
    expect((await run({ argv: ['sleep'], cwd: '/', timeoutMs: 5 })).exitCode).toBeNull()
    expect(spawn.mock.calls[0]?.[0].signal?.reason).toMatchObject({ code: PROCESS_TIMEOUT_CODE })
    const controller = new AbortController()
    controller.abort(new Error('stopped'))
    await expect(run({ argv: ['sleep'], cwd: '/', timeoutMs: 1_000, signal: controller.signal })).rejects.toThrow('stopped')
  })
})
