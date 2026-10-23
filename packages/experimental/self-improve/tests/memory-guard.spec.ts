import { afterEach, describe, expect, it, vi } from 'vitest'
import { gib, MEMORY_STOP, MemoryGuard, parseVmStatSample, vmStatSample } from '../src/memory-guard.ts'
import type { VmStatSample } from '../src/memory-guard.ts'
import type { ProcessRunner } from '../src/process.ts'

afterEach(() => {
  vi.useRealTimers()
})

const GIB = 2 ** 30
const MIB = 2 ** 20
const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               200000.
Pages inactive:                           350000.
Pages speculative:                         50000.
Swapins:                               19610009.
Swapouts:                                  1000.
`

describe('vm_stat samples', () => {
  it('read the room and the swap-outs in bytes', async () => {
    expect(parseVmStatSample(VM_STAT)).toEqual({ room: 600_000 * 16_384, swapOutBytes: 1000 * 16_384 })
    expect(() => parseVmStatSample(VM_STAT.replace('Swapouts', 'Swaps'))).toThrow('vm_stat printed no Swapouts count')
    const run: ProcessRunner = async () => ({ exitCode: 0, stdout: VM_STAT, stderr: '' })
    expect(await vmStatSample(run, 1000)).toEqual({ room: 600_000 * 16_384, swapOutBytes: 1000 * 16_384 })
    await expect(vmStatSample(async () => ({ exitCode: 1, stdout: '', stderr: 'no\n' }), 1000)).rejects.toThrow('vm_stat exited with 1: no')
    expect(gib(21.5 * GIB)).toBe('21.5')
  })
})

describe('MemoryGuard', () => {
  function guard(samples: readonly (VmStatSample | Error)[]) {
    const queue = [...samples]
    const stops: string[] = []
    const log: string[] = []
    const memory = new MemoryGuard({
      settings: { maxSwapOutMiB: 256, minFreeGiB: 2, intervalSeconds: 5 },
      sample: async () => {
        const next = queue.shift() ?? { room: 30 * GIB, swapOutBytes: 0 }
        if (next instanceof Error) throw next
        return next
      },
      stop: reason => stops.push(reason),
      log: line => log.push(line),
    })
    return { memory, stops, log }
  }

  it('stops the job once swap-outs since its start exceed the limit', async () => {
    const swapped = (bytes: number): VmStatSample => ({ room: 30 * GIB, swapOutBytes: 5 * GIB + bytes })
    const { memory, stops } = guard([swapped(0), swapped(256 * MIB), swapped(300 * MIB)])
    await memory.start()
    await memory.check()
    expect(stops).toEqual([])
    await memory.check()
    expect(stops).toEqual([`${MEMORY_STOP}: 300 MiB swapped out since the job started, over the 256 MiB limit`])
    memory.dispose()
  })

  it('stops the job when the room stays under the limit for three samples in a row', async () => {
    const low = { room: 1.5 * GIB, swapOutBytes: 0 }
    const { memory, stops } = guard([{ room: 30 * GIB, swapOutBytes: 0 }, low, low, { room: 3 * GIB, swapOutBytes: 0 }, low, low, low])
    await memory.start()
    for (let index = 0; index < 5; index += 1) await memory.check()
    expect(stops).toEqual([])
    await memory.check()
    expect(stops).toEqual([`${MEMORY_STOP}: 1.5 GiB of free, inactive, and speculative memory for 3 samples in a row, under the 2 GiB limit`])
  })

  it('leaves a job unguarded without a baseline, notes one failed sample, and samples on its interval', async () => {
    const off = guard([new Error('vm_stat: not found')])
    await off.memory.start()
    await off.memory.check()
    expect(off.log).toEqual(['memory guard off for this job: vm_stat: not found'])
    const flaky = guard([{ room: 30 * GIB, swapOutBytes: 0 }, new Error('busy'), new Error('still busy')])
    await flaky.memory.start()
    await flaky.memory.check()
    await flaky.memory.check()
    expect(flaky.log).toEqual(['memory guard: a vm_stat sample failed: busy'])
    const text = guard([{ room: 30 * GIB, swapOutBytes: 0 }])
    const { memory } = text
    const sample = vi.spyOn(memory, 'check')
    vi.useFakeTimers()
    await memory.start()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(sample).toHaveBeenCalledTimes(2)
    memory.dispose()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(sample).toHaveBeenCalledTimes(2)
  })

  it('takes one sample at a time', async () => {
    let release: (sample: VmStatSample) => void = () => {}
    const stops: string[] = []
    let calls = 0
    const memory = new MemoryGuard({
      settings: { maxSwapOutMiB: 1, minFreeGiB: 0, intervalSeconds: 5 },
      sample: async () => {
        calls += 1
        if (calls === 1) return { room: GIB, swapOutBytes: 0 }
        return await new Promise<VmStatSample>((resolve) => {
          release = resolve
        })
      },
      stop: reason => stops.push(reason),
      log: () => {},
    })
    await memory.start()
    const first = memory.check()
    await memory.check()
    expect(calls).toBe(2)
    release({ room: GIB, swapOutBytes: 0 })
    await first
    expect(stops).toEqual([])
    const thrown = new MemoryGuard({
      settings: { maxSwapOutMiB: 1, minFreeGiB: 0, intervalSeconds: 5 },
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the spec exercises a sampler that rejects with a non-Error.
      sample: async () => await Promise.reject('text'),
      stop: () => {},
      log: line => stops.push(line),
    })
    await thrown.start()
    expect(stops).toEqual(['memory guard off for this job: text'])
  })
})
