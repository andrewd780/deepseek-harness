import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { AutoScheduler, dueCheck, isScheduleTime, parseVmStat, readScheduleState, startScheduleTimer, vmStatMemory } from '../src/auto-schedule.ts'
import type { ScheduleSettings, SchedulerDependencies } from '../src/auto-schedule.ts'
import type { ProcessRunner } from '../src/process.ts'

const roots: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

/** vm_stat as macOS prints it, with 16 KiB pages: 600,000 free, inactive, and speculative pages are 9.2 GiB. */
const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               200000.
Pages active:                             900000.
Pages inactive:                           350000.
Pages speculative:                         50000.
Pages throttled:                               0.
Pages wired down:                         300000.
`

const GIB = 2 ** 30
const local = (day: number, hours: number, minutes = 0): Date => new Date(2026, 9, day, hours, minutes)
const settings: ScheduleSettings = { enabled: false, time: '03:00', minIntervalHours: 20, minFreeMemoryGiB: 22, windowHours: 0, checkIntervalMinutes: 5 }

async function scheduler(overrides: Partial<SchedulerDependencies> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-self-improve-schedule-')))
  roots.push(root)
  const statePath = join(root, 'self-improve', 'schedule.json')
  const starts: string[] = []
  let now = local(23, 3, 5)
  const deps: SchedulerDependencies = {
    settings,
    statePath,
    now: () => now,
    memory: async () => 30 * GIB,
    activeJob: () => undefined,
    start: async (owner) => {
      starts.push(owner)
      return `self-improve-${starts.length}`
    },
    ...overrides,
  }
  return {
    statePath,
    starts,
    schedule: new AutoScheduler(deps),
    setNow: (date: Date) => {
      now = date
    },
    state: async () => JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>,
  }
}

describe('dueCheck', () => {
  const due = (now: Date, lastStartedAt?: Date, windowHours = 0) => dueCheck({ now, time: '03:00', lastStartedAt, minIntervalHours: 20, windowHours })

  it('is due once the start time has come and the last start is old enough', () => {
    expect(due(local(23, 2, 59))).toEqual({ due: false, reason: 'waiting for 03:00' })
    expect(due(local(23, 3, 0))).toEqual({ due: true })
    expect(due(local(23, 23, 0), local(22, 3, 0))).toEqual({ due: true })
    expect(due(local(23, 4, 0), local(23, 3, 1))).toEqual({ due: false, reason: 'already started today at 2026-10-23 03:01' })
    expect(due(local(23, 4, 0), local(22, 22, 0))).toEqual({ due: false, reason: 'the last start, 2026-10-22 22:00, is less than 20 h ago' })
    expect(due(local(23, 6, 59), undefined, 4)).toEqual({ due: true })
    expect(due(local(23, 7, 0), undefined, 4)).toEqual({ due: false, reason: 'today\'s window, 03:00 plus 4 h, has passed' })
    expect(() => dueCheck({ now: local(23, 3), time: '3am', lastStartedAt: undefined, minIntervalHours: 0, windowHours: 0 })).toThrow('self-improve schedule time "3am" is not HH:MM')
  })

  it('accepts 24-hour local times only', () => {
    expect(['00:00', '03:00', '23:59'].every(isScheduleTime)).toBe(true)
    expect(['24:00', '3:00', '03:60', '03:00 ', 'noon'].some(isScheduleTime)).toBe(false)
  })
})

describe('memory room', () => {
  it('adds free, inactive, and speculative pages of vm_stat', () => {
    expect(parseVmStat(VM_STAT)).toBe(600_000 * 16_384)
    expect(() => parseVmStat(VM_STAT.replace('Pages speculative', 'Pages special'))).toThrow('vm_stat printed no page size or no free, inactive, or speculative page count')
    expect(() => parseVmStat(VM_STAT.replace('page size of', 'size'))).toThrow('vm_stat printed no page size')
  })

  it('runs vm_stat through the process runner', async () => {
    const calls: string[][] = []
    const ok: ProcessRunner = async ({ argv }) => {
      calls.push([...argv])
      return { exitCode: 0, stdout: VM_STAT, stderr: '' }
    }
    expect(await vmStatMemory(ok, 1000)).toBe(600_000 * 16_384)
    expect(calls).toEqual([['vm_stat']])
    const failing: ProcessRunner = async () => ({ exitCode: 127, stdout: '', stderr: 'vm_stat: not found\n' })
    await expect(vmStatMemory(failing, 1000)).rejects.toThrow('vm_stat exited with 127: vm_stat: not found')
  })
})

describe('readScheduleState', () => {
  it('reads every field and refuses a file that is not a schedule', async () => {
    const { statePath } = await scheduler()
    expect(await readScheduleState(statePath)).toEqual({})
    await mkdir(join(statePath, '..'), { recursive: true })
    const full = { enabled: true, time: '04:30', owner: 'session-a', lastStartedAt: '2026-10-23T03:00:00.000Z', lastJob: 'self-improve-1', lastCheck: { at: '2026-10-23T03:00:00.000Z', reason: 'started job self-improve-1' } }
    await writeFile(statePath, JSON.stringify(full))
    expect(await readScheduleState(statePath)).toEqual({ ...full, owner: SessionId('session-a') })
    await writeFile(statePath, '{')
    await expect(readScheduleState(statePath)).rejects.toThrow(`${statePath} is not JSON`)
    for (const invalid of [[], { enabled: 'yes' }, { time: '4:30' }, { time: 430 }, { owner: 1 }, { lastStartedAt: 1 }, { lastJob: 1 }, { lastCheck: 'x' }, { lastCheck: { at: 'x' } }, { lastCheck: { reason: 'x' } }]) {
      await writeFile(statePath, JSON.stringify(invalid))
      await expect(readScheduleState(statePath)).rejects.toThrow(`${statePath} is not a self-improve schedule`)
    }
    await rm(statePath)
    await mkdir(statePath)
    await expect(readScheduleState(statePath)).rejects.toThrow(/EISDIR/)
  })
})

describe('AutoScheduler', () => {
  it('starts nothing while the schedule is off or not due, and records nothing then', async () => {
    const { schedule, statePath, setNow, starts } = await scheduler()
    expect(await schedule.tick()).toEqual({ started: false, reason: 'the schedule is off' })
    await schedule.set(true, undefined, SessionId('session-a'))
    setNow(local(23, 2, 0))
    expect(await schedule.tick()).toEqual({ started: false, reason: 'waiting for 03:00' })
    expect(await readScheduleState(statePath)).toEqual({ enabled: true, owner: 'session-a' })
    expect(starts).toEqual([])
  })

  it('records why a due run waits: another job, too little memory, a failed memory check, or no owner', async () => {
    let active: string | undefined = 'job self-improve-1 (self-improve baseline loader)'
    let memory: () => Promise<number> = async () => 10 * GIB
    const { schedule, state, starts } = await scheduler({
      activeJob: () => active,
      memory: async () => await memory(),
      settings: { ...settings, enabled: true },
    })
    const reason = async (): Promise<unknown> => (await state())['lastCheck']
    expect(await schedule.tick()).toEqual({ started: false, reason: 'waiting: job self-improve-1 (self-improve baseline loader) is running' })
    expect(await reason()).toEqual({ at: local(23, 3, 5).toISOString(), reason: 'waiting: job self-improve-1 (self-improve baseline loader) is running' })
    active = undefined
    expect(await schedule.tick()).toEqual({ started: false, reason: 'waiting: 10.0 GiB of memory is free, inactive, or speculative; 22 GiB needed' })
    memory = async () => {
      throw new Error('vm_stat exited with 1')
    }
    expect(await schedule.tick()).toEqual({ started: false, reason: 'waiting: the memory check failed: vm_stat exited with 1' })
    memory = async () => {
      throw 'vm_stat is missing'
    }
    expect(await schedule.tick()).toEqual({ started: false, reason: 'waiting: the memory check failed: vm_stat is missing' })
    memory = async () => 22 * GIB
    expect(await schedule.tick()).toEqual({ started: false, reason: 'waiting: no session owns the schedule; run /self-improve schedule on in the session that should own scheduled runs' })
    expect(await reason()).toMatchObject({ reason: 'waiting: no session owns the schedule; run /self-improve schedule on in the session that should own scheduled runs' })
    expect(starts).toEqual([])
  })

  it('starts the run for its owner once every check passes, then not again that day', async () => {
    const { schedule, state, starts, setNow } = await scheduler()
    await schedule.set(true, '03:00', SessionId('session-a'))
    expect(await schedule.tick()).toEqual({ started: true, job: 'self-improve-1' })
    expect(starts).toEqual(['session-a'])
    expect(await state()).toEqual({
      enabled: true,
      time: '03:00',
      owner: 'session-a',
      lastStartedAt: local(23, 3, 5).toISOString(),
      lastJob: 'self-improve-1',
      lastCheck: { at: local(23, 3, 5).toISOString(), reason: 'started job self-improve-1' },
    })
    setNow(local(23, 9, 0))
    expect(await schedule.tick()).toEqual({ started: false, reason: 'already started today at 2026-10-23 03:05' })
    setNow(local(24, 3, 0))
    expect(await schedule.tick()).toEqual({ started: true, job: 'self-improve-2' })
  })

  it('skips the memory check at 0 GiB and records a start that fails', async () => {
    const { schedule, state } = await scheduler({
      settings: { ...settings, minFreeMemoryGiB: 0 },
      memory: async () => {
        throw new Error('unused')
      },
      start: async () => {
        throw new Error('session "session-a" has no live agent (background job owner must be live)')
      },
    })
    await schedule.set(true, undefined, SessionId('session-a'))
    const reason = 'could not start the run for session session-a: session "session-a" has no live agent (background job owner must be live)'
    expect(await schedule.tick()).toEqual({ started: false, reason })
    expect((await state())['lastCheck']).toEqual({ at: local(23, 3, 5).toISOString(), reason })
    expect((await state())['lastStartedAt']).toBeUndefined()
  })

  it('runs one check at a time, and none while another process holds the schedule', async () => {
    const reached = Promise.withResolvers<(room: number) => void>()
    const { schedule, statePath } = await scheduler({
      settings: { ...settings, enabled: true },
      memory: async () => await new Promise<number>((resolve) => {
        reached.resolve(resolve)
      }),
    })
    const first = schedule.tick()
    expect(await schedule.tick()).toEqual({ started: false, reason: 'the previous check is still running' })
    ;(await reached.promise)(30 * GIB)
    expect(await first).toMatchObject({ started: false, reason: expect.stringMatching(/^waiting: no session owns/) as string })
    await writeFile(`${statePath}.lock`, `${process.pid}\n`)
    expect(await schedule.tick()).toEqual({ started: false, reason: `the check failed: atomic-write: timed out waiting for the writer lock at ${statePath}.lock` })
    await rm(`${statePath}.lock`)
    await writeFile(statePath, 'not json')
    expect(await schedule.tick()).toEqual({ started: false, reason: `the check failed: ${statePath} is not JSON` })
  })

  it('lets the first session claim an unowned schedule that is on, and no one else', async () => {
    const off = await scheduler()
    expect(await off.schedule.claim(SessionId('session-a'))).toBe(false)
    await expect(readFile(off.statePath, 'utf8')).rejects.toThrow(/ENOENT/)
    const on = await scheduler({ settings: { ...settings, enabled: true } })
    expect(await on.schedule.claim(SessionId('session-a'))).toBe(true)
    expect(await on.schedule.claim(SessionId('session-b'))).toBe(false)
    expect(await on.state()).toEqual({ owner: 'session-a' })
    await on.schedule.set(false, undefined, undefined)
    expect(await on.state()).toEqual({ enabled: false, owner: 'session-a' })
    // A schedule turned off by the command stays off for claims, and a claim racing an owner keeps the first owner.
    const racing = await scheduler({ settings: { ...settings, enabled: true } })
    const claims = await Promise.all([racing.schedule.claim(SessionId('session-a')), racing.schedule.claim(SessionId('session-b'))])
    expect(claims.filter(Boolean)).toHaveLength(1)
  })

  it('describes the schedule, its checks, its owner, and the last start and check', async () => {
    const { schedule, setNow } = await scheduler({ settings: { ...settings, windowHours: 4, minFreeMemoryGiB: 0 } })
    expect((await schedule.describe()).split('\n')).toEqual([
      'schedule: off (set by the plugin settings)',
      'checks every 5 min: at least 20 h between starts, starts until 4 h after 03:00, no memory check, and no other self-improve job running',
      'owner: none yet; the next session to run /self-improve schedule on, or any /self-improve command while the schedule is on, owns scheduled runs',
    ])
    await schedule.set(true, '03:00', SessionId('session-a'))
    expect((await schedule.describe()).split('\n').slice(0, 1).concat((await schedule.describe()).split('\n').slice(2))).toEqual([
      'schedule: on, daily at 03:00 local time (set by /self-improve schedule)',
      'owner: session session-a, which must be open when a run is due',
      'now: due; the next check starts it when the other checks pass',
    ])
    await schedule.tick()
    setNow(local(23, 5, 0))
    expect((await schedule.describe()).split('\n').slice(3)).toEqual([
      'last start: 2026-10-23 03:05 (job self-improve-1)',
      'last due check: 2026-10-23 03:05: started job self-improve-1',
      'now: already started today at 2026-10-23 03:05',
    ])
    const plain = await scheduler()
    await plain.schedule.set(false, undefined, undefined)
    await writeFile(plain.statePath, JSON.stringify({ enabled: true, lastStartedAt: local(22, 3).toISOString() }))
    expect((await plain.schedule.describe()).split('\n')).toEqual([
      'schedule: on, daily at 03:00 local time (set by /self-improve schedule)',
      'checks every 5 min: at least 20 h between starts, at least 22 GiB of free, inactive, and speculative memory, and no other self-improve job running',
      'owner: none yet; the next session to run /self-improve schedule on, or any /self-improve command while the schedule is on, owns scheduled runs',
      'last start: 2026-10-22 03:00',
      'now: due; the next check starts it when the other checks pass',
    ])
  })

  it('checks on its timer until disposed', async () => {
    vi.useFakeTimers()
    const { schedule } = await scheduler()
    const tick = vi.spyOn(schedule, 'tick').mockResolvedValue({ started: false, reason: 'the schedule is off' })
    const stop = startScheduleTimer(schedule, { checkIntervalMinutes: 5 })
    await vi.advanceTimersByTimeAsync(5 * 60_000 - 1)
    expect(tick).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(tick).toHaveBeenCalledTimes(1)
    stop()
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(tick).toHaveBeenCalledTimes(1)
  })
})
