import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EvaluationJobId, TaskId } from '../src/brand.ts'
import { RunDirectory } from '../src/directory.ts'
import type { Trajectory } from '../src/directory.ts'
import { aggregate } from '../src/evaluate.ts'
import { EditHistory } from '../src/history.ts'
import { evaluation, componentSet } from './fixtures.ts'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function directory(): Promise<RunDirectory> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-self-improve-directory-'))
  roots.push(root)
  return new RunDirectory(join(root, 'run'))
}

async function plant(run: RunDirectory, path: string, content: string): Promise<void> {
  await mkdir(join(run.root, path, '..'), { recursive: true })
  await writeFile(join(run.root, path), content)
}

describe('RunDirectory', () => {
  it('reads nothing before the first write', async () => {
    const run = await directory()
    expect(await run.readTrajectory()).toBeUndefined()
    expect((await run.readHistory(componentSet)).records()).toEqual([])
    expect(await run.readEvaluation(EvaluationJobId('base'))).toBeUndefined()
    expect(await run.readCalibration()).toBeUndefined()
    expect(await run.readCandidate(0, 'A')).toBeUndefined()
    expect(await run.readRoundText(0, 'analysis.md')).toBeUndefined()
  })

  it('round-trips the trajectory, history, calibration, candidates, and round records', async () => {
    const run = await directory()
    const trajectory: Trajectory = [
      { commit: 'c0', job: EvaluationJobId('base'), score: 0.5, cost: undefined },
      { commit: 'c1', job: EvaluationJobId('r0A'), score: 0.6, cost: 120, variant: 'A' },
    ]
    await run.writeTrajectory(trajectory)
    expect(await run.readTrajectory()).toEqual(trajectory)
    const history = new EditHistory(componentSet)
    history.appendCandidate(0, 'A', [{ id: 'C1', component: 'prompt', hypothesis: 'h' }], 'smoke-failed')
    await run.writeHistory(history)
    expect((await run.readHistory(componentSet)).records()).toEqual(history.records())
    const calibration = { method: 'z' as const, delta: 0.02, z: 2, deviation: 0.01, estimate: 'bootstrap' as const, bootstrapDeviation: 0.01, scores: [0.5] }
    await run.writeCalibration(calibration)
    expect(await run.readCalibration()).toEqual(calibration)
    const spread = { method: 'spread' as const, delta: 0.03, scores: [0.5, 0.53] }
    await run.writeCalibration(spread)
    expect(await run.readCalibration()).toEqual(spread)
    const ready = { status: 'ready' as const, variant: 'A', commit: 'c1', branch: 'b', summary: 's', edits: [{ id: 'C1', component: 'prompt', hypothesis: 'h' }] }
    const gated = { status: 'gated' as const, variant: 'B', outcome: 'smoke-failed' as const, detail: 'd', edits: [] }
    await run.writeCandidate(0, ready)
    await run.writeCandidate(0, gated)
    expect(await run.readCandidate(0, 'A')).toEqual(ready)
    expect(await run.readCandidate(0, 'B')).toEqual(gated)
    await run.writeRoundRecord(0, 'analysis.md', 'report')
    await run.writeRoundRecord(0, join('A', 'smoke.json'), { ok: true })
    expect(await run.readRoundText(0, 'analysis.md')).toBe('report')
    expect(await run.readRoundText(0, join('A', 'smoke.json'))).toBe('{\n "ok": true\n}\n')
  })

  it('stores an evaluation as trials and re-aggregates it on read', async () => {
    const run = await directory()
    const stored = evaluation('r0A', { a: [1, 0], b: [0.5, 1] }, { a: [10, undefined] }, { promptTokens: 9 })
    await run.writeEvaluation(stored)
    expect(await run.readEvaluation(EvaluationJobId('r0A'))).toEqual(stored)
    await expect(run.writeEvaluation(aggregate(EvaluationJobId('../escape'), 1, new Map()))).rejects.toThrow('is not a file name')
  })

  it('rejects files that are not what they claim to be', async () => {
    const run = await directory()
    await plant(run, 'trajectory.json', '[]')
    await expect(run.readTrajectory()).rejects.toThrow('is not a self-improve trajectory')
    await plant(run, 'trajectory.json', '[{"commit":"c0","job":"base","score":"high","cost":null}]')
    await expect(run.readTrajectory()).rejects.toThrow('is not a self-improve trajectory')
    await plant(run, 'trajectory.json', '{"commit":"c0"}')
    await expect(run.readTrajectory()).rejects.toThrow('is not a self-improve trajectory')
    await plant(run, 'trajectory.json', '[{"commit":"c0","job":"base","score":1,"cost":null,"variant":3}]')
    await expect(run.readTrajectory()).rejects.toThrow('is not a self-improve trajectory')
    await plant(run, 'trajectory.json', '{')
    await expect(run.readTrajectory()).rejects.toThrow('is not JSON')
    await plant(run, 'calibration.json', '{"delta":1}')
    await expect(run.readCalibration()).rejects.toThrow('is not a self-improve calibration')
    await plant(run, 'calibration.json', '{"delta":1,"z":2,"deviation":0.5,"method":"bootstrap","bootstrapDeviation":0.5,"scores":[0.5]}')
    await expect(run.readCalibration()).rejects.toThrow('is not a self-improve calibration')
    await plant(run, 'calibration.json', '{"method":"z","delta":1,"z":2,"deviation":0.5,"estimate":"guess","bootstrapDeviation":0.5,"scores":[0.5]}')
    await expect(run.readCalibration()).rejects.toThrow('is not a self-improve calibration')
    await plant(run, join('rounds', '0', 'A', 'candidate.json'), '{"status":"ready","variant":"B","edits":[]}')
    await expect(run.readCandidate(0, 'A')).rejects.toThrow('is not a self-improve candidate record')
  })

  it.each([
    ['another job', { job: 'other', trials: 1, perTask: {}, measures: {} }],
    ['fractional trials', { job: 'base', trials: 1.5, perTask: {}, measures: {} }],
    ['a non-numeric measure', { job: 'base', trials: 1, perTask: {}, measures: { tokens: 'x' } }],
    ['missing measures', { job: 'base', trials: 1, perTask: {} }],
    ['a non-object task', { job: 'base', trials: 1, perTask: { a: 3 }, measures: {} }],
    ['mismatched weights', { job: 'base', trials: 1, perTask: { a: { rewards: [1], weights: [], tokens: [null], missing: 0 } }, measures: {} }],
    ['a non-finite reward', { job: 'base', trials: 1, perTask: { a: { rewards: ['1'], weights: [1], tokens: [null], missing: 0 } }, measures: {} }],
    ['mismatched tokens', { job: 'base', trials: 1, perTask: { a: { rewards: [1], weights: [1], tokens: [], missing: 0 } }, measures: {} }],
    ['tokens that are not an array', { job: 'base', trials: 1, perTask: { a: { rewards: [1], weights: [1], tokens: 4, missing: 0 } }, measures: {} }],
    ['a string token count', { job: 'base', trials: 1, perTask: { a: { rewards: [1], weights: [1], tokens: ['4'], missing: 0 } }, measures: {} }],
    ['a fractional missing count', { job: 'base', trials: 1, perTask: { a: { rewards: [1], weights: [1], tokens: [4], missing: 0.5 } }, measures: {} }],
  ])('rejects an evaluation with %s', async (_label, value) => {
    const run = await directory()
    await plant(run, join('jobs', 'base.json'), JSON.stringify(value))
    await expect(run.readEvaluation(EvaluationJobId('base'))).rejects.toThrow('is not a self-improve evaluation of base')
  })

  it.each([
    ['an unknown status', { status: 'done', variant: 'A', edits: [] }],
    ['an invalid edit', { status: 'gated', variant: 'A', outcome: 'smoke-failed', detail: '', edits: [{ id: 1 }] }],
    ['edits that are not an array', { status: 'gated', variant: 'A', outcome: 'smoke-failed', detail: '', edits: {} }],
    ['an unknown gate', { status: 'gated', variant: 'A', outcome: 'lost', detail: '', edits: [] }],
    ['a ready record without its branch', { status: 'ready', variant: 'A', commit: 'c', summary: '', edits: [] }],
    ['a non-object record', ['A']],
  ])('rejects a candidate record with %s', async (_label, value) => {
    const run = await directory()
    await plant(run, join('rounds', '0', 'A', 'candidate.json'), JSON.stringify(value))
    await expect(run.readCandidate(0, 'A')).rejects.toThrow('is not a self-improve candidate record')
  })

  it('propagates read failures other than a missing file', async () => {
    const run = await directory()
    await mkdir(join(run.root, 'trajectory.json'), { recursive: true })
    await expect(run.readTrajectory()).rejects.toMatchObject({ code: 'EISDIR' })
  })

  it('holds the run for one operation at a time', async () => {
    const run = await directory()
    let release: () => void = () => {}
    let entered: () => void = () => {}
    const holds = new Promise<void>((resolve) => {
      entered = resolve
    })
    const holding = run.exclusive(async () => await new Promise<string>((resolve) => {
      release = () => {
        resolve('first')
      }
      entered()
    }))
    await holds
    await expect(run.exclusive(async () => 'second')).rejects.toThrow('timed out waiting for the writer lock')
    release()
    expect(await holding).toBe('first')
    expect(await run.exclusive(async () => 'third')).toBe('third')
  })
})

describe('evaluation identifiers', () => {
  it('brands task ids without changing them', () => {
    expect(TaskId('a')).toBe('a')
  })
})
