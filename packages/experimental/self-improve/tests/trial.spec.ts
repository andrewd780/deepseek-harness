import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import { finalResponse, firstRequestInputTokens, internals, renderTrial, runTrial, trialTokens } from '../src/trial.ts'
import type { TrialLaunch, TrialRecord } from '../src/trial.ts'
import { useFakeRuntime } from './fake-runtime.ts'

let fake: ReturnType<typeof useFakeRuntime>
const roots: string[] = []

beforeEach(() => {
  fake = useFakeRuntime()
})

afterEach(async () => {
  fake.restore()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function launch(env: Record<string, string>, timeoutMs = 20_000): Promise<TrialLaunch> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-self-improve-trial-')))
  roots.push(root)
  return {
    profile: 'sdk',
    patches: ['/evolved/overlay.patch.yml', '/policy.patch.yml'],
    home: join(root),
    cwd: root,
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    env,
    timeoutMs,
    shutdownTimeoutMs: 5_000,
  }
}

function event(type: string, data: object, seq = 0): SessionEvent {
  return { type, data, seq, time: 0 } as never
}

function usageTurn(turn: number, usage: object | undefined): SessionEvent[] {
  return [
    event('turn/start', { turn }),
    event('step/start', { turn, step: 1 }),
    event('assistant/message', {
      turn,
      step: 1,
      stream: usage === undefined ? [] : [{ type: 'chunk', time: 0, chunk: { type: 'usage', usage } }],
      message: { id: `m${turn}`, role: 'assistant', content: [{ type: 'text', text: 'done' }], source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' } },
      ...usage === undefined ? {} : { usage },
    }),
    event('step/end', { turn, step: 1 }),
    event('turn/end', { turn, reason: { kind: 'completed' } }),
  ]
}

describe('runTrial', () => {
  it('runs the task in a fresh runtime and keeps the whole Session tree', async () => {
    const trial = await launch({
      FAKE_TEXT: 'all done',
      FAKE_ECHO_CWD: '1',
      FAKE_ECHO_ENV: 'TRIAL_FLAG',
      TRIAL_FLAG: 'on',
      FAKE_SUBAGENT: '1',
      FAKE_SESSION_EVENTS: JSON.stringify([{ type: 'tool/call', data: { turn: 0, step: 0, callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' } }]),
    })
    const record = await runTrial(trial, 'List the files.')
    expect(record.failure).toBeUndefined()
    expect(fake.launches[0]).toMatchObject({
      profile: 'sdk',
      patches: ['/evolved/overlay.patch.yml', '/policy.patch.yml'],
      dshHome: trial.home,
      processCwd: trial.cwd,
      cwd: trial.cwd,
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      shutdownTimeoutMs: 5_000,
    })
    expect(fake.launches[0]?.env).toMatchObject({ TRIAL_FLAG: 'on' })
    expect(finalResponse(record)).toBe(`cwd=${trial.cwd}\nTRIAL_FLAG=on\nall done`)
    const sessions = new Set(record.events.map(entry => entry.sessionId))
    expect(sessions).toEqual(new Set([record.sessionId, `${record.sessionId}-child`]))
    const trace = renderTrial(record, 1_000)
    expect(trace).toContain('[tool call] bash {"command":"ls"}')
    expect(trace).toContain(`(${record.sessionId}-child) [assistant] child says hi`)
    expect(trace).toContain('[turn end] completed')
    expect(trialTokens(record.events)).toBeUndefined()
    expect(firstRequestInputTokens(record)).toBeUndefined()
  })

  it('records a runtime that fails or outlives its deadline', async () => {
    const failed = await runTrial(await launch({ FAKE_INIT_ERROR: '1' }), 'p')
    expect(failed.failure).toBe('scripted init failure')
    expect(failed.events).toEqual([])
    const hung = await runTrial(await launch({ FAKE_HANG_PROMPT: '1' }, 300), 'p')
    expect(hung.failure).toMatch(/timed out|SELF_IMPROVE_TRIAL_TIMEOUT|deadline/i)
  })

  it('rejects when the run is cancelled', async () => {
    const controller = new AbortController()
    controller.abort(new Error('stopped'))
    await expect(runTrial(await launch({}), 'p', controller.signal)).rejects.toThrow('stopped')
  })
})

describe('runTrial without the fake runtime', () => {
  it('constructs the SDK runtime lazily', async () => {
    fake.restore()
    const harness = internals.createHarness({ profile: 'sdk' })
    expect(harness).toBeInstanceOf(DeepSeekHarness)
    await harness.close()
  })

  it('records a rejection that is not an Error', async () => {
    internals.createHarness = () => ({
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the spec exercises a runtime that rejects with a non-Error.
      start: async () => await Promise.reject('refused'),
      close: async () => {},
    }) as never
    expect((await runTrial(await launch({}), 'p')).failure).toBe('refused')
  })
})

describe('trial accounting', () => {
  it('sums exact turn totals across Sessions and refuses unproven usage', () => {
    const usage = { inputTokens: 100, outputTokens: 20, totalTokens: 170, cacheReadTokens: 50 }
    const events = [
      ...usageTurn(1, usage).map(entry => ({ sessionId: 'root', event: entry })),
      ...usageTurn(1, { ...usage, totalTokens: 30, inputTokens: 10, cacheReadTokens: 0 }).map(entry => ({ sessionId: 'child', event: entry })),
    ]
    expect(trialTokens(events)).toBe(200)
    expect(trialTokens([...events, ...usageTurn(2, undefined).map(entry => ({ sessionId: 'root', event: entry }))])).toBeUndefined()
    expect(trialTokens([])).toBeUndefined()
  })

  it('reads the first root request and the last root answer', () => {
    const message = (text: string, usage?: object) => event('assistant/message', {
      turn: 1,
      step: 1,
      stream: [],
      message: { id: 'm', role: 'assistant', content: text.length === 0 ? [] : [{ type: 'text', text }], source: { kind: 'model', provider: 'p', model: 'm' } },
      ...usage === undefined ? {} : { usage },
    })
    const record: TrialRecord = {
      sessionId: 'root',
      events: [
        { sessionId: 'child', event: message('child', { inputTokens: 1, outputTokens: 1 }) },
        { sessionId: 'root', event: message('first', { inputTokens: 300, outputTokens: 5, cacheReadTokens: 700, cacheWriteTokens: 10 }) },
        { sessionId: 'root', event: message('second') },
        { sessionId: 'root', event: message('') },
      ],
    }
    expect(firstRequestInputTokens(record)).toBe(1_010)
    expect(firstRequestInputTokens({ sessionId: 'root', events: [] })).toBeUndefined()
    expect(firstRequestInputTokens({ ...record, events: record.events.slice(2) })).toBeUndefined()
    expect(firstRequestInputTokens({ ...record, events: [{ sessionId: 'root', event: message('x', { inputTokens: 4, outputTokens: 1 }) }] })).toBe(4)
    expect(finalResponse(record)).toBe('second')
  })

  it('renders conversation events and the failure, clipping long payloads', () => {
    const record: TrialRecord = {
      sessionId: 'root',
      failure: 'runtime exited',
      events: [
        { sessionId: 'root', event: event('user/message', { id: 'u', role: 'user', content: [{ type: 'text', text: 'Fix it.' }, { type: 'image' }], source: { kind: 'user' } }) },
        { sessionId: 'root', event: event('tool/call', { turn: 1, step: 1, callId: 'c', name: 'read', arguments: 'x'.repeat(30) }) },
        { sessionId: 'root', event: event('tool/result', { turn: 1, step: 1, message: { role: 'tool', content: [{ type: 'text', text: 'denied' }], isError: true } }) },
        { sessionId: 'root', event: event('tool/result', { turn: 1, step: 1, message: { role: 'tool', content: [{ type: 'text', text: 'ok' }] } }) },
        { sessionId: 'root', event: event('step/start', { turn: 1, step: 1 }) },
        { sessionId: 'root', event: event('turn/end', { turn: 1, reason: { kind: 'error' } }) },
      ],
    }
    expect(renderTrial(record, 10).split('\n')).toEqual([
      '[user] Fix it. [i ...[5 more characters]',
      '[tool call] read xxxxxxxxxx ...[20 more characters]',
      '[tool result, error] denied',
      '[tool result] ok',
      '[turn end] error',
      '[trial failed] runtime exited',
    ])
  })
})
