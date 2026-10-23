import { afterEach, describe, expect, it } from 'vitest'
import { JobCare, NO_CARE } from '../src/job-care.ts'
import type { JobCareDependencies, RoomWait } from '../src/job-care.ts'
import type { VmStatSample } from '../src/memory-guard.ts'
import { standInOllama } from './ollama-server.ts'
import type { StandInOllama } from './ollama-server.ts'

const servers: StandInOllama[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
})

const GIB = 2 ** 30
const unload = { timeoutMs: 2000, pollMs: 10 }

async function care(options: Partial<JobCareDependencies> & { readonly rooms?: readonly (number | Error)[] } = {}) {
  const server = await standInOllama(['policy:latest', 'role:latest'])
  servers.push(server)
  const log: string[] = []
  const stops: string[] = []
  const rooms = [...options.rooms ?? []]
  const job = new JobCare({
    routes: { trial: { origin: server.origin, model: 'policy:latest' }, role: { origin: server.origin, model: 'role:latest' } },
    unload,
    room: undefined,
    sample: async (): Promise<VmStatSample> => {
      const room = rooms.shift() ?? 30
      if (room instanceof Error) throw room
      return { room: room * GIB, swapOutBytes: 0 }
    },
    stop: reason => stops.push(reason),
    log: line => log.push(line),
    ...options,
  })
  return { job, server, log, stops }
}

describe('JobCare', () => {
  it('unloads the trials\' model after each trial and the roles\' model after each role stage, and logs each unload', async () => {
    const { job, server, log } = await care()
    await job.afterTrial('base-1 alpha#0')
    await job.afterRole('the analysis of round 1')
    await job.afterTrial('base-1 beta#0')
    expect(server.unloads).toEqual(['policy:latest', 'role:latest', 'policy:latest'])
    expect(log).toEqual([
      expect.stringMatching(new RegExp(`^unloaded policy:latest from ${server.origin} after trial base-1 alpha#0 \\(\\d+\\.\\d s\\)$`)) as string,
      expect.stringMatching(/^unloaded role:latest from .+ after the analysis of round 1 \(\d+\.\d s\)$/) as string,
      expect.stringMatching(/^unloaded policy:latest from .+ after trial base-1 beta#0/) as string,
    ])
  })

  it('logs a failed unload and a model still loaded without failing, and stops trying a server that is not Ollama', async () => {
    const { job, server, log } = await care({ unload: { timeoutMs: 60, pollMs: 10 } })
    server.mode = 'fail-unload'
    await job.afterTrial('t#0')
    server.mode = 'keep-loaded'
    await job.afterTrial('t#1')
    server.loaded.delete('policy:latest')
    await job.afterTrial('t#2')
    server.mode = 'not-ollama'
    await job.afterTrial('t#3')
    await job.afterRole('a review')
    expect(log).toEqual([
      `unloading policy:latest from ${server.origin} after trial t#0 failed: POST ${server.origin}/api/generate answered 500`,
      `policy:latest is still loaded at ${server.origin} 0.06 s after the unload request after trial t#1`,
      `no unloads at ${server.origin}: ${server.origin} does not answer /api/ps with a model listing`,
    ])
    const thrown = new JobCare({
      routes: { trial: { origin: 'http://x', model: 'm' } },
      unload,
      room: undefined,
      sample: async () => ({ room: 0, swapOutBytes: 0 }),
      stop: () => {},
      log: line => log.push(line),
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the spec exercises a fetch that rejects with a non-Error.
      fetch: async () => await Promise.reject('offline'),
    })
    await thrown.afterTrial('t#4')
    expect(log.at(-1)).toBe('unloading m from http://x after trial t#4 failed: offline')
  })

  it('does nothing with unloads off, without a route, or as the no-op care', async () => {
    const { job, server } = await care({ unload: undefined })
    await job.afterTrial('t#0')
    const routeless = new JobCare({
      routes: {},
      unload,
      room: undefined,
      sample: async () => ({ room: 0, swapOutBytes: 0 }),
      stop: () => {},
      log: () => {},
    })
    await routeless.afterTrial('t#0')
    await routeless.afterRole('a review')
    await NO_CARE.beforeTrial('t#0')
    await NO_CARE.afterTrial('t#0')
    await NO_CARE.afterRole('a review')
    expect(server.unloads).toEqual([])
  })

  it('lets a fresh trial start when there is room, or without a room check', async () => {
    const room: RoomWait = { minGiB: 22, waitMs: 60_000, pollMs: 10 }
    const roomy = await care({ room, rooms: [30] })
    await roomy.job.beforeTrial('t#0')
    expect(roomy.log).toEqual([])
    const unchecked = await care({ room: { ...room, minGiB: 0 }, rooms: [1] })
    await unchecked.job.beforeTrial('t#0')
    const off = await care({ rooms: [1] })
    await off.job.beforeTrial('t#0')
    expect([...unchecked.log, ...off.log, ...unchecked.stops, ...off.stops]).toEqual([])
  })

  it('unloads and waits for room before a fresh trial, and starts it once the room is back', async () => {
    const { job, server, log } = await care({ room: { minGiB: 22, waitMs: 60_000, pollMs: 10 }, rooms: [10, 15, 25] })
    await job.beforeTrial('base-1 alpha#0')
    expect(server.unloads).toEqual(['policy:latest', 'role:latest'])
    expect(log[0]).toBe('10.0 GiB of memory is free before trial base-1 alpha#0, under 22 GiB; unloading the run\'s local models and waiting up to 1 min')
    expect(log[1]).toMatch(new RegExp(`^unloaded policy:latest from ${server.origin} to make room for trial base-1 alpha#0 \\(\\d+\\.\\d s\\)$`))
    expect(log.at(-1)).toBe('25.0 GiB of memory is free; trial base-1 alpha#0 starts')
    // With unloads off, the wait says only that it waits.
    const waiting = await care({ unload: undefined, room: { minGiB: 22, waitMs: 60_000, pollMs: 10 }, rooms: [10, 25] })
    await waiting.job.beforeTrial('t#0')
    expect(waiting.log).toEqual(['10.0 GiB of memory is free before trial t#0, under 22 GiB; waiting up to 1 min', '25.0 GiB of memory is free; trial t#0 starts'])
    expect(waiting.server.unloads).toEqual([])
  })

  it('stops the job with the reason when the room does not come back in time', async () => {
    const { job, stops } = await care({ room: { minGiB: 22, waitMs: 0, pollMs: 10 }, rooms: [10] })
    const reason = 'stopped by the memory guard: 10.0 GiB of memory was free before trial base-1 alpha#0 after waiting 0 min; 22 GiB needed'
    await expect(job.beforeTrial('base-1 alpha#0')).rejects.toThrow(reason)
    expect(stops).toEqual([reason])
    const cancelled = await care({ room: { minGiB: 22, waitMs: 60_000, pollMs: 60_000 }, rooms: [10] })
    const controller = new AbortController()
    const waiting = cancelled.job.beforeTrial('t#0', controller.signal)
    setTimeout(() => {
      controller.abort(new Error('operator stop'))
    }, 50)
    await expect(waiting).rejects.toThrow()
  })

  it('skips the room check when vm_stat cannot be read, noting it once', async () => {
    const { job, log } = await care({ room: { minGiB: 22, waitMs: 60_000, pollMs: 10 }, rooms: [new Error('vm_stat: not found'), 10, new Error('busy')] })
    await job.beforeTrial('t#0')
    await job.beforeTrial('t#1')
    expect(log).toEqual([
      'memory check before trials skipped: vm_stat: not found',
      '10.0 GiB of memory is free before trial t#1, under 22 GiB; unloading the run\'s local models and waiting up to 1 min',
      expect.stringMatching(/^unloaded policy:latest/) as string,
      expect.stringMatching(/^unloaded role:latest/) as string,
    ])
    const text = await care({
      room: { minGiB: 22, waitMs: 60_000, pollMs: 10 },
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the spec exercises a sampler that rejects with a non-Error.
      sample: async () => await Promise.reject('no vm_stat'),
    })
    await text.job.beforeTrial('t#0')
    expect(text.log).toEqual(['memory check before trials skipped: no vm_stat'])
  })
})
