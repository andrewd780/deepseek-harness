import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RunDirectory } from '../src/directory.ts'
import type { Trajectory } from '../src/directory.ts'
import { SelfImproveRun, candidateName } from '../src/loop.ts'
import type { RunSettings } from '../src/loop.ts'
import { FakeDomain, FakeStore, ScriptedAnalyst, ScriptedCritic, ScriptedProposer, edit, job } from './fakes.ts'
import { componentSet } from './fixtures.ts'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

const settings: RunSettings = {
  rounds: 3,
  variants: 2,
  trials: 2,
  minEdits: 1,
  maxEdits: 2,
  stallWindow: 1,
  reservedSlots: 1,
  pruneWindow: 4,
  repairRounds: 1,
  failureTraces: 2,
  successTraces: 1,
  maxMissingFraction: 0.25,
  historyLimit: 40,
  delta: 0.05,
  selection: {
    costAllowance: 0.1,
    costPerGain: { value: 2, perPass: false },
    scoreWeight: { value: 0, perPass: false },
    costWeight: 15,
    noveltyWeight: 0.5,
  },
}

class FlakyDirectory extends RunDirectory {
  failTrajectoryWrites = 0

  override async writeTrajectory(trajectory: Trajectory): Promise<void> {
    if (this.failTrajectoryWrites > 0) {
      this.failTrajectoryWrites -= 1
      throw new Error('disk full')
    }
    await super.writeTrajectory(trajectory)
  }
}

async function harness(overrides: Partial<RunSettings> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-self-improve-loop-'))
  roots.push(root)
  const store = new FakeStore()
  const domain = new FakeDomain()
  const proposer = new ScriptedProposer(store)
  const critic = new ScriptedCritic()
  const analyst = new ScriptedAnalyst()
  const directory = new FlakyDirectory(join(root, 'run'))
  const lines: string[] = []
  const roles = { domain, store, analyst, proposer, critic, directory, log: (line: string) => lines.push(line) }
  const run = new SelfImproveRun(roles, { ...settings, ...overrides })
  domain.rewards.set('base-c0', { a: [1, 0], b: [0, 0] })
  return { run, store, domain, proposer, critic, analyst, directory, lines }
}

describe('SelfImproveRun baseline', () => {
  it('measures the evolve branch tip once and starts the trajectory', async () => {
    const { run, store, domain } = await harness()
    expect(await run.status()).toEqual({ trajectory: [], nextRound: undefined })
    await expect(run.round()).rejects.toThrow('has no baseline; measure the baseline first')
    expect(await run.baseline()).toEqual({ commit: 'c0', job: 'base-c0', score: 0.25, cost: 100 })
    expect((await run.status()).nextRound).toBe(0)
    expect(domain.evaluations.map(request => [request.job, request.tasks, request.trials])).toEqual([['base-c0', ['a', 'b'], 2]])
    expect(store.released).toEqual(['baseline'])
    await expect(run.baseline()).rejects.toThrow('already has a baseline')
  })

  it('logs a baseline that reported no tokens', async () => {
    const { run, domain, lines } = await harness()
    domain.tokens.set('base-c0', 0)
    expect(await run.baseline()).toMatchObject({ cost: undefined })
    expect(lines).toEqual(['baseline c0: score 0.2500, cost not reported'])
  })

  it('refuses a baseline whose trials produced too few results', async () => {
    const { run, store, domain } = await harness()
    domain.missing.set('base-c0', [4])
    await expect(run.baseline()).rejects.toThrow('self-improve baseline is invalid: 4/4 trials produced no result')
    expect((await run.status()).trajectory).toEqual([])
    expect(store.released).toEqual(['baseline'])
  })
})

describe('SelfImproveRun rounds', () => {
  it('accepts the best admissible candidate and moves the evolve branch to it', async () => {
    const { run, store, domain, proposer, critic, analyst, directory } = await harness()
    domain.rewards.set('r0A', { a: [1, 1], b: [1, 0] })
    domain.rewards.set('r0B', { a: [1, 1], b: [0, 0] })
    await run.baseline()
    const outcome = await run.round()
    expect(outcome.winner).toBe('A')
    expect(outcome.incumbent).toMatchObject({ job: 'r0A', score: 0.75, cost: 100, variant: 'A' })
    expect(store.tipCommit).toBe(outcome.incumbent.commit)
    expect(outcome.decisions.map(decision => decision.admissible)).toEqual([true, true])
    expect((await directory.readHistory(componentSet)).records().map(record => [record.variant, record.outcome, record.diff]))
      .toEqual([['A', 'accepted', '+++ b/AGENTS.md\n+r0A'], ['B', 'lost', '+++ b/AGENTS.md\n+r0B']])
    expect(analyst.requests.map(request => [request.round, request.previous, request.evidence.length])).toEqual([[0, '', 2]])
    expect(proposer.requests.map(request => [request.variant, request.budget, request.reserved, request.analysis])).toEqual([['A', 2, false, 'report 0'], ['B', 2, false, 'report 0']])
    expect(critic.requests).toHaveLength(2)
    expect(domain.smokes.map(request => [request.job, request.trials])).toEqual([['r0A-smoke-cr0A-1', 1], ['r0B-smoke-cr0B-2', 1]])
    expect(store.released).toEqual(['baseline', 'r0A', 'r0B'])
    expect(await directory.readRoundText(0, 'decisions.json')).toContain('"variant": "A"')
    expect(JSON.parse(await directory.readRoundText(0, 'directives.json') ?? '{}')).toMatchObject({
      budget: 2,
      stalled: false,
      delta: 0.05,
      bestScore: 0.25,
      policy: { delta: 0.05, costAllowance: 0.1, costPerGain: 2, scoreWeight: 0, costWeight: 15, noveltyWeight: 0.5 },
    })
    expect(await run.status()).toMatchObject({ nextRound: 1 })
  })

  it('scales per-pass rates by the trials of an evaluation', async () => {
    const { run, directory, domain } = await harness({
      selection: { ...settings.selection, costPerGain: { value: 0.25, perPass: true }, scoreWeight: { value: 1, perPass: true } },
    })
    await run.baseline()
    domain.rewards.set('r0A', { a: [1, 1], b: [0, 0] })
    domain.tokens.set('r0A', 300)
    const outcome = await run.round()
    expect(JSON.parse(await directory.readRoundText(0, 'directives.json') ?? '{}')).toMatchObject({ policy: { costPerGain: 1, scoreWeight: 4 } })
    expect(outcome.decisions[0]).toMatchObject({
      admissible: false,
      reason: 'cost rule failed: gain +0.2500 above band 0.05; cost change +2.0000 > allowance 0.3500',
    })
  })

  it('keeps the incumbent when no candidate clears the floor, then reserves a slot once the run stalls', async () => {
    const { run, store, proposer, critic, directory, analyst } = await harness()
    await run.baseline()
    const first = await run.round()
    expect(first.winner).toBeUndefined()
    expect(first.incumbent).toEqual({ commit: 'c0', job: 'base-c0', score: 0.25, cost: 100 })
    expect(store.tipCommit).toBe('c0')
    proposer.script.set('r1B', [{ edits: [edit('prompt')] }, { diff: '+++ b/skills/review/SKILL.md', edits: [edit('skill', 'C2')] }])
    const second = await run.round()
    expect(second.winner).toBeUndefined()
    const firstOfRound1 = proposer.requests.find(request => request.round === 1)
    expect(firstOfRound1?.history.map(entry => [entry.round, entry.variant, entry.outcome, entry.diff]))
      .toEqual([[0, 'A', 'rejected', '+++ b/AGENTS.md\n+r0A'], [0, 'B', 'rejected', '+++ b/AGENTS.md\n+r0B']])
    const reserved = proposer.requests.filter(request => request.checkout.name === 'r1B')
    expect(reserved.map(request => request.reserved)).toEqual([true, true])
    expect(reserved[1]?.repair?.reasons[0]).toMatch(/^this candidate holds a slot reserved for components the run never changed/)
    expect(critic.requests.filter(request => request.summary === 'draft r1B')).toHaveLength(2)
    expect(await directory.readCandidate(1, 'B')).toMatchObject({ status: 'ready', edits: [edit('skill', 'C2')] })
    expect(analyst.requests[1]?.previous).toBe('report 0')
    await rm(join(directory.root, 'rounds', '1', 'analysis.md'))
    await run.round()
    expect(analyst.requests[2]?.previous).toBe('')
    expect(JSON.parse(await directory.readRoundText(1, 'directives.json') ?? '{}')).toMatchObject({ stalled: true, tried: ['prompt'] })
  })

  it('records each gate a candidate can fail', async () => {
    const { run, domain, proposer, critic, directory } = await harness()
    await run.baseline()
    proposer.script.set('r0A', [{ status: 'failed', summary: 'nothing to change' }])
    critic.script.set('draft r0B', [
      { verdict: 'reject', reasons: ['names a task'], riskNotes: [] },
      { verdict: 'reject', reasons: ['still names a task'], riskNotes: [] },
    ])
    await run.round()
    expect(await directory.readCandidate(0, 'A')).toMatchObject({ status: 'gated', outcome: 'draft-failed', detail: 'nothing to change' })
    expect(await directory.readCandidate(0, 'B')).toMatchObject({ status: 'gated', outcome: 'critic-rejected', detail: 'still names a task' })
    expect(proposer.requests.find(request => request.checkout.name === 'r0B' && request.repair !== undefined)?.repair)
      .toEqual({ reasons: ['names a task'], riskNotes: [], declared: [edit()] })

    proposer.script.set('r1A', [{ edits: [edit('prompt', 'C1'), edit('config', 'C2'), edit('skill', 'C3')] }, { status: 'failed' }])
    proposer.script.set('r1B', [{ edits: [edit('skill')], diff: '+++ b/skills/a/SKILL.md' }])
    domain.smokeResult = request => ({ ok: !request.job.startsWith('r1B-smoke'), detail: 'the profile did not load' })
    await run.round()
    expect(await directory.readCandidate(1, 'A')).toMatchObject({ outcome: 'critic-rejected', detail: 'the candidate declares 3 edits; this round allows at most 2' })
    expect(critic.requests.some(request => request.summary === 'draft r1A')).toBe(false)
    expect(await directory.readCandidate(1, 'B')).toMatchObject({ outcome: 'smoke-failed', detail: 'the profile did not load' })

    proposer.script.set('r2A', [{ edits: [] }, { edits: [] }])
    domain.missing.set('r2B', [2, 2])
    await run.round()
    expect(await directory.readCandidate(2, 'A')).toMatchObject({ outcome: 'critic-rejected', detail: 'the candidate declares no edit' })
    const history = (await directory.readHistory(componentSet)).records()
    expect(history.filter(record => record.round === 2).map(record => [record.variant, record.outcome, record.detail]))
      .toEqual([['A', 'critic-rejected', 'critic-rejected: the candidate declares no edit'], ['B', 'evaluation-invalid', 'evaluation-invalid: 2/4 trials produced no result after one retry']])
    expect(domain.evaluations.filter(request => request.job === 'r2B')).toHaveLength(2)
    expect(history.filter(record => record.round === 0).map(record => [record.variant, record.diff])).toEqual([['A', ''], ['B', '+++ b/AGENTS.md\n+r0B']])
    expect(proposer.requests.flatMap(request => request.history)).toEqual([])
  })

  it('raises the domain\'s objections before the critic and lets the proposer repair them', async () => {
    const { run, domain, proposer, critic, directory } = await harness()
    await run.baseline()
    domain.objections.push(['overlay.patch.yml entry 1 (sandbox-policy): its config cannot change'], [], ['still broken'], ['still broken'])
    await run.round()
    expect(domain.screened).toEqual(['/runs/r0A', '/runs/r0A', '/runs/r0B', '/runs/r0B'])
    expect(proposer.requests.find(request => request.checkout.name === 'r0A' && request.repair !== undefined)?.repair)
      .toEqual({ reasons: ['overlay.patch.yml entry 1 (sandbox-policy): its config cannot change'], riskNotes: [], declared: [edit()] })
    expect(critic.requests.filter(request => request.summary === 'draft r0A')).toHaveLength(1)
    expect(await directory.readCandidate(0, 'A')).toMatchObject({ status: 'ready' })
    expect(await directory.readCandidate(0, 'B')).toMatchObject({ status: 'gated', outcome: 'critic-rejected', detail: 'still broken' })
    expect(critic.requests.some(request => request.summary === 'draft r0B')).toBe(false)
  })

  it('contains a failed evaluation and rethrows cancellation', async () => {
    const { run, domain, directory } = await harness()
    await run.baseline()
    domain.failures.set('r0A', new Error('runner crashed'))
    domain.failures.set('r0B', 'a thrown string')
    await run.round()
    const history = (await directory.readHistory(componentSet)).records()
    expect(history.map(record => record.detail)).toEqual([
      'evaluation-invalid: the evaluation failed: runner crashed',
      'evaluation-invalid: the evaluation failed: a thrown string',
    ])
    const controller = new AbortController()
    controller.abort(new Error('stopped'))
    domain.failures.set('r1A', new Error('aborted run'))
    await expect(run.round(controller.signal)).rejects.toThrow('stopped')
  })

  it('resumes an interrupted round from its stored drafts and evaluations', async () => {
    const { run, domain, proposer, directory, lines } = await harness()
    domain.rewards.set('r0A', { a: [1, 1], b: [1, 0] })
    await run.baseline()
    domain.guardResult = () => {
      throw new Error('guard crashed')
    }
    await expect(run.round()).rejects.toThrow('guard crashed')
    const drafted = proposer.requests.length
    const evaluated = domain.evaluations.length
    domain.guardResult = () => []
    directory.failTrajectoryWrites = 1
    await expect(run.round()).rejects.toThrow('disk full')
    const outcome = await run.round()
    expect(outcome.winner).toBe('A')
    expect(proposer.requests).toHaveLength(drafted)
    expect(domain.evaluations).toHaveLength(evaluated)
    expect((await directory.readHistory(componentSet)).records()).toHaveLength(2)
    expect(lines).toContain('r0A: resuming the ready candidate')
    expect(lines).toContain('r0A: reusing the stored evaluation')
  })

  it('evaluates a resumed candidate whose evaluation was never stored', async () => {
    const { run, store, domain, proposer } = await harness()
    await run.baseline()
    domain.guardResult = () => {
      throw new Error('guard crashed')
    }
    domain.failures.set('r0A', new Error('first attempt failed'))
    await expect(run.round()).rejects.toThrow('guard crashed')
    domain.guardResult = () => []
    domain.failures.delete('r0A')
    store.checkouts.clear()
    const outcome = await run.round()
    expect(outcome.decisions[0]).toMatchObject({ variant: 'A', admissible: false })
    expect(proposer.requests).toHaveLength(2)
    expect(domain.evaluations.filter(request => request.job === 'r0A').map(request => request.root)).toEqual(['/runs/r0A', '/runs/r0A'])
  })

  it('fails loudly on missing evidence, a finished run, and an evolve branch moved outside the run', async () => {
    const empty = await harness()
    await empty.run.baseline()
    empty.domain.traces = false
    await expect(empty.run.round()).rejects.toThrow('only 0 of 2 evidence trials of base-c0 left a trajectory')

    const finished = await harness({ rounds: 1 })
    await finished.run.baseline()
    await finished.run.round()
    expect((await finished.run.status()).nextRound).toBeUndefined()
    await expect(finished.run.round()).rejects.toThrow('has completed its 1 round(s)')

    const moved = await harness()
    await moved.run.baseline()
    moved.store.tipCommit = 'outside'
    await expect(moved.run.round()).rejects.toThrow('evolve branch tip outside is not an ancestor of c0')
  })

  it('names the stored evaluation an incumbent is missing', async () => {
    const { run, directory } = await harness()
    await directory.writeTrajectory([{ commit: 'c0', job: job('lost'), score: 0, cost: undefined }])
    await expect(run.round()).rejects.toThrow('has no stored evaluation lost')
  })
})

describe('SelfImproveRun noise band', () => {
  it('calibrates the baseline before the first round and reads the band from it', async () => {
    const { run, store, domain, directory, lines } = await harness({ delta: undefined })
    const z = { method: 'z' as const, z: 2, resamples: 100, seed: 1 }
    await expect(run.calibrate(1, z)).rejects.toThrow('has no baseline')
    await run.baseline()
    await expect(run.round()).rejects.toThrow('self-improve has no noise band: configure delta or calibrate the baseline')
    domain.rewards.set('base-c0-1', { a: [1, 1], b: [0, 0] })
    domain.rewards.set('base-c0-2', { a: [0, 0], b: [0, 0] })
    const calibration = await run.calibrate(2, z)
    expect(calibration).toMatchObject({ method: 'z', estimate: 'repeated' })
    expect([...store.parents.keys()]).toEqual([])
    expect(domain.evaluations.map(request => request.job)).toEqual(['base-c0', 'base-c0-1', 'base-c0-2'])
    expect(await run.calibrate(2, { method: 'spread' })).toEqual({ method: 'spread', delta: 0.5, scores: [0.25, 0.5, 0] })
    expect(lines.at(-1)).toBe('calibrated delta 0.50000 (spread, 3 evaluation(s))')
    expect(await run.calibrate(2, z)).toEqual(calibration)
    expect(domain.evaluations).toHaveLength(3)
    await run.round()
    expect(JSON.parse(await directory.readRoundText(0, 'directives.json') ?? '{}')).toMatchObject({ delta: calibration.delta })
    await expect(run.calibrate(0, z)).rejects.toThrow('calibrates the baseline only before the first round')
  })
})

describe('SelfImproveRun held-out measurement', () => {
  it('measures a trajectory revision on the held-out tasks once', async () => {
    const { run, domain } = await harness()
    await run.baseline()
    domain.rewards.set('heldout-0', { h: [1, 0] })
    const measured = await run.heldout(undefined)
    expect(measured).toMatchObject({ job: 'heldout-0', score: 0.5 })
    expect(domain.evaluations.at(-1)).toMatchObject({ tasks: ['h'], root: '/runs/heldout-0' })
    expect(await run.heldout(0)).toEqual(measured)
    expect(domain.evaluations).toHaveLength(2)
    await expect(run.heldout(5)).rejects.toThrow('self-improve trajectory has no revision 5')
  })
})

describe('candidateName', () => {
  it('joins the round and the label', () => {
    expect(candidateName(3, 'A')).toBe('r3A')
  })
})
