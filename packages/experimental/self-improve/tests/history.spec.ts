import { describe, expect, it } from 'vitest'
import { EditHistory, exploration, stallFlag } from '../src/history.ts'
import type { EditRecord } from '../src/history.ts'
import type { MeasuredDecision } from '../src/selection.ts'
import { componentSet } from './fixtures.ts'

function measured(variant: string, scoreChange: number, admissible = true): MeasuredDecision {
  return { variant, admissible, reason: `reason ${variant}`, score: 0.5, cost: 100, scoreChange, costChange: 0.1, novelty: 0, guards: [] }
}

const promptEdit = { id: 'C1', component: 'prompt', hypothesis: 'shorter plans' }
const skillEdit = { id: 'C2', component: 'skill', hypothesis: 'a review skill' }
const diffOf = (label: string) => `+++ b/AGENTS.md\n+${label} "quoted"`

describe('EditHistory', () => {
  it('records one entry per edit with the candidate measurement and source diff', () => {
    const history = new EditHistory(componentSet)
    const records = history.appendCandidate(0, 'A', [promptEdit, skillEdit], diffOf('r0A'), 'accepted', measured('A', 0.1))
    expect(records).toHaveLength(2)
    expect(records[0]).toEqual({
      round: 0,
      variant: 'A',
      editId: 'C1',
      component: 'prompt',
      hypothesis: 'shorter plans',
      outcome: 'accepted',
      accepted: true,
      scoreChange: 0.1,
      costChange: 0.1,
      bundle: 2,
      detail: 'reason A',
      diff: diffOf('r0A'),
    })
    expect(records[1]?.diff).toBe(diffOf('r0A'))
    expect(history.has(0, 'A')).toBe(true)
    expect(history.has(0, 'B')).toBe(false)
  })

  it('records a gated candidate without a measurement and a placeholder for an empty draft', () => {
    const history = new EditHistory(componentSet)
    const [gated] = history.appendCandidate(1, 'B', [], '', 'draft-failed', { variant: 'B', admissible: false, reason: 'x'.repeat(700) })
    expect(gated).toMatchObject({ editId: 'none', component: 'prompt', bundle: 0, accepted: false, diff: '' })
    expect(gated?.scoreChange).toBeUndefined()
    expect(gated?.detail).toHaveLength(600)
    const [bare] = history.appendCandidate(1, 'C', [promptEdit], diffOf('r1C'), 'critic-rejected')
    expect(bare?.detail).toBe('')
    expect(history.tried().size).toBe(0)
  })

  it('derives tried components, incumbent counts, recent yield, and the prune set with accepted diffs', () => {
    const history = new EditHistory(componentSet)
    history.appendCandidate(0, 'A', [promptEdit, { ...promptEdit, id: 'C3', hypothesis: 'check the plan' }], diffOf('r0A'), 'accepted', measured('A', 0.1))
    history.appendCandidate(0, 'B', [{ ...skillEdit, component: 'retired' }], diffOf('r0B'), 'rejected', measured('B', -0.2, false))
    history.appendCandidate(4, 'A', [skillEdit], diffOf('r4A'), 'accepted', measured('A', 0))
    history.appendCandidate(5, 'A', [promptEdit], diffOf('r5A'), 'rejected', measured('A', -0.05, false))
    expect([...history.tried()].sort()).toEqual(['prompt', 'skill'])
    expect(history.measured()).toHaveLength(4)
    expect(history.incumbentComponentCounts().get('prompt')).toBe(2)
    expect(history.incumbentComponentCounts().get('skill')).toBe(1)
    expect(history.incumbentComponentCounts().has('retired')).toBe(false)
    expect(history.recentYield(5, 4)).toEqual(new Map([['prompt', -0.05], ['skill', 0]]))
    expect(history.recentYield(10, 2)).toEqual(new Map([['prompt', Number.NEGATIVE_INFINITY], ['skill', Number.NEGATIVE_INFINITY]]))
    const accepted = { outcome: 'accepted', accepted: true, costChange: 0.1, detail: 'reason A' }
    expect(history.pruneSet(5, 4)).toEqual([
      {
        component: 'prompt',
        recentBestGain: -0.05,
        acceptedCandidates: [{ round: 0, variant: 'A', ...accepted, scoreChange: 0.1, edits: [promptEdit, { ...promptEdit, id: 'C3', hypothesis: 'check the plan' }], diff: diffOf('r0A') }],
      },
      { component: 'skill', recentBestGain: 0, acceptedCandidates: [{ round: 4, variant: 'A', ...accepted, scoreChange: 0, edits: [skillEdit], diff: diffOf('r4A') }] },
    ])
    expect(history.pruneSet(10, 2).map(entry => entry.recentBestGain)).toEqual([undefined, undefined])
    expect(history.pruneSet(0, 4).map(entry => entry.component)).toEqual(['skill'])
  })

  it('renders only measured candidates, one entry per candidate with its diff', () => {
    const history = new EditHistory(componentSet)
    history.appendCandidate(0, 'A', [promptEdit, skillEdit], diffOf('r0A'), 'accepted', measured('A', 0.1))
    for (let round = 1; round <= 3; round += 1) history.appendCandidate(round, 'A', [promptEdit], diffOf(`r${round}A`), 'smoke-failed')
    history.appendCandidate(4, 'B', [skillEdit], diffOf('r4B'), 'lost', measured('B', 0.02))
    history.appendCandidate(4, 'C', [], '', 'draft-failed')
    const uncosted: EditRecord = {
      round: 5, variant: 'D', editId: 'C1', component: 'prompt', hypothesis: 'shorter plans', outcome: 'rejected', accepted: false, scoreChange: -0.1, bundle: 1, detail: 'no cost', diff: diffOf('r5D'),
    }
    const rendered = new EditHistory(componentSet, [...history.records(), uncosted])
    expect(rendered.render()).toEqual([
      { round: 0, variant: 'A', outcome: 'accepted', accepted: true, scoreChange: 0.1, costChange: 0.1, detail: 'reason A', edits: [promptEdit, skillEdit], diff: diffOf('r0A') },
      { round: 4, variant: 'B', outcome: 'lost', accepted: false, scoreChange: 0.02, costChange: 0.1, detail: 'reason B', edits: [skillEdit], diff: diffOf('r4B') },
      { round: 5, variant: 'D', outcome: 'rejected', accepted: false, scoreChange: -0.1, detail: 'no cost', edits: [promptEdit], diff: diffOf('r5D') },
    ])
    expect(rendered.render(3).map(entry => [entry.round, entry.edits.map(edit => edit.id)])).toEqual([[0, ['C2']], [4, ['C2']], [5, ['C1']]])
  })

  it('round-trips through JSON Lines and rejects an invalid line', () => {
    const history = new EditHistory(componentSet)
    expect(history.toJsonl()).toBe('')
    history.appendCandidate(0, 'A', [promptEdit], diffOf('r0A'), 'accepted', measured('A', 0.1))
    history.appendCandidate(0, 'B', [skillEdit], '', 'smoke-failed')
    const text = history.toJsonl()
    expect(EditHistory.fromJsonl(`${text}\n`, componentSet).records()).toEqual(history.records())
    expect(() => EditHistory.fromJsonl(`${text}{"round":1}\n`, componentSet)).toThrow('self-improve history line 3 is not an edit record')
    const valid = '{"round":0,"variant":"A","editId":"C1","component":"prompt","hypothesis":"","outcome":"lost","accepted":false,"bundle":1,"detail":"","diff":""}'
    expect(EditHistory.fromJsonl(valid, componentSet).records()).toHaveLength(1)
    for (const line of [
      '7',
      'null',
      valid.replace('"outcome":"lost"', '"outcome":"won"'),
      valid.replace('"bundle":1', '"scoreChange":"0.1","bundle":1'),
      valid.replace('"bundle":1', '"costChange":"0.1","bundle":1'),
      valid.replace(',"diff":""', ''),
      valid.replace('"diff":""', '"diff":3'),
    ]) {
      expect(() => EditHistory.fromJsonl(line, componentSet), line).toThrow('line 1')
    }
  })
})

describe('stallFlag', () => {
  it('flags a score that rose by no more than the band over the window', () => {
    expect(stallFlag([0.5, 0.52, 0.53, 0.54], 3, 3, 0.05)).toBe(true)
    expect(stallFlag([0.5, 0.52, 0.53, 0.6], 3, 3, 0.05)).toBe(false)
    expect(stallFlag([0.5, 0.5], 1, 3, 0.05)).toBe(false)
    expect(stallFlag([0.5], 3, 3, 0.05)).toBe(false)
  })
})

describe('exploration', () => {
  it('reserves slots for untried components only when stalled', () => {
    const stalled = exploration(true, new Set(['prompt']), 1, componentSet)
    expect(stalled).toMatchObject({ stalled: true, reservedSlots: 1, untried: ['control_flow', 'config', 'context_mgmt', 'skill', 'subagent'] })
    expect(stalled.directive).toMatch(/1 candidate slot\(s\) this round are reserved/)
    const moving = exploration(false, new Set(['prompt']), 1, componentSet)
    expect(moving).toMatchObject({ stalled: false, reservedSlots: 0 })
    expect(moving.directive).toMatch(/^Components this run has not changed yet: control_flow/)
    const complete = exploration(true, new Set(componentSet.names), 1, componentSet)
    expect(complete).toMatchObject({ reservedSlots: 0, untried: [], directive: 'Every component has been changed at least once.' })
  })
})
