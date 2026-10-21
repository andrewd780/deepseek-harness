import { describe, expect, it, vi } from 'vitest'
import { costRule, judgeCandidate, selectRound } from '../src/selection.ts'
import type { Candidate } from '../src/selection.ts'
import { evaluation, policy, componentSet } from './fixtures.ts'

const incumbent = evaluation('base', { a: [1, 0], b: [0, 0] }, { a: [100, 100], b: [100, 100] })
const edit = { id: 'C1', component: 'prompt', hypothesis: 'h' }

function candidate(variant: string, rewards: Record<string, number[]>, tokens = 100, component = 'prompt'): Candidate {
  const perTaskTokens = Object.fromEntries(Object.keys(rewards).map(task => [task, [tokens, tokens]]))
  return { variant, edits: [{ ...edit, component }], evaluation: evaluation(`r0${variant}`, rewards, perTaskTokens) }
}

describe('costRule', () => {
  it('lets a gain above the band pay for proportional cost', () => {
    expect(costRule(0.1, 0.3, 0, policy)).toEqual({
      holds: true,
      reason: 'gain +0.1000 above band 0.05; cost change +0.3000 <= allowance 0.3000',
    })
    expect(costRule(0.1, 0.31, 0, policy).holds).toBe(false)
  })

  it('admits a change inside the band only on shaped value', () => {
    expect(costRule(0.01, -0.1, 0, policy)).toEqual({
      holds: true,
      reason: 'gain +0.0100 within band 0.05; shaped value +1.5000 > 0 (novelty 0)',
    })
    expect(costRule(0, 0, 1, policy).holds).toBe(true)
    expect(costRule(0, 0.04, 1, policy)).toEqual({
      holds: false,
      reason: 'gain +0.0000 within band 0.05; shaped value -0.1000 <= 0 (novelty 1)',
    })
  })
})

describe('judgeCandidate', () => {
  it('rejects an unmeasured candidate with its gate failure', () => {
    expect(judgeCandidate({ variant: 'A', edits: [], gateFailure: 'smoke-failed: x' }, incumbent, 0.25, policy, new Map(), componentSet))
      .toEqual({ variant: 'A', admissible: false, reason: 'smoke-failed: x' })
    expect(judgeCandidate({ variant: 'B', edits: [] }, incumbent, 0.25, policy, new Map(), componentSet).reason).toBe('not evaluated')
  })

  it('rejects a score below the noise-adjusted best', () => {
    const decision = judgeCandidate(candidate('A', { a: [1, 0], b: [0, 0] }), incumbent, 0.4, policy, new Map(), componentSet)
    expect(decision).toMatchObject({ admissible: false, score: 0.25, scoreChange: 0, costChange: 0, novelty: 0 })
    expect(decision.reason).toBe('below the noise-adjusted floor: 0.2500 < best 0.4000 - band 0.05')
  })

  it('rejects a failed cost rule, then a violated guard, and admits the rest', () => {
    const expensive = judgeCandidate(candidate('A', { a: [1, 1], b: [0, 0] }, 300), incumbent, 0.25, policy, new Map(), componentSet)
    expect(expensive.admissible).toBe(false)
    expect(expensive.reason).toMatch(/^cost rule failed: gain \+0\.2500 above band/)
    const guarded = judgeCandidate(candidate('B', { a: [1, 1], b: [0, 0] }), incumbent, 0.25, policy, new Map(), componentSet, ['prompt grew'])
    expect(guarded).toMatchObject({ admissible: false, reason: 'domain guard violated: prompt grew', guards: ['prompt grew'] })
    const admitted = judgeCandidate(candidate('C', { a: [1, 1], b: [0, 0] }), incumbent, 0.25, policy, new Map(), componentSet)
    expect(admitted).toMatchObject({ admissible: true, scoreChange: 0.25 })
    expect(admitted.reason).toMatch(/^admissible: gain \+0\.2500/)
  })
})

describe('selectRound', () => {
  it('picks the first admissible candidate with the highest score and guards only measured ones', () => {
    const guards = vi.fn(() => [] as string[])
    const candidates = [
      { variant: 'A', edits: [edit], gateFailure: 'critic-rejected: leak' },
      candidate('B', { a: [1, 1], b: [0, 0] }),
      candidate('C', { a: [1, 1], b: [1, 0] }),
      candidate('D', { a: [1, 1], b: [1, 0] }),
    ]
    const { winner, judged } = selectRound(candidates, incumbent, 0.25, policy, new Map(), componentSet, guards)
    expect(winner).toBe(candidates[2])
    expect(judged.map(({ candidate, decision }) => [candidate.variant, decision.admissible])).toEqual([['A', false], ['B', true], ['C', true], ['D', true]])
    expect(guards).toHaveBeenCalledTimes(3)
  })

  it('has no winner when nothing is admissible', () => {
    const { winner, judged } = selectRound([candidate('A', { a: [0, 0], b: [0, 0] })], incumbent, 0.25, policy, new Map(), componentSet)
    expect(winner).toBeUndefined()
    expect(judged[0]?.decision.admissible).toBe(false)
  })
})
