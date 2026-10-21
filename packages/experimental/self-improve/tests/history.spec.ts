import { describe, expect, it } from 'vitest'
import { EditHistory, exploration, stallFlag } from '../src/history.ts'
import type { MeasuredDecision } from '../src/selection.ts'
import { componentSet } from './fixtures.ts'

function measured(variant: string, scoreChange: number, admissible = true): MeasuredDecision {
  return { variant, admissible, reason: `reason ${variant}`, score: 0.5, cost: 100, scoreChange, costChange: 0.1, novelty: 0, guards: [] }
}

const promptEdit = { id: 'C1', component: 'prompt', hypothesis: 'shorter plans' }
const skillEdit = { id: 'C2', component: 'skill', hypothesis: 'a review skill' }

describe('EditHistory', () => {
  it('records one entry per edit with the candidate measurement', () => {
    const history = new EditHistory(componentSet)
    const records = history.appendCandidate(0, 'A', [promptEdit, skillEdit], 'accepted', measured('A', 0.1))
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
    })
    expect(history.has(0, 'A')).toBe(true)
    expect(history.has(0, 'B')).toBe(false)
  })

  it('records a gated candidate without a measurement and a placeholder for an empty draft', () => {
    const history = new EditHistory(componentSet)
    const [gated] = history.appendCandidate(1, 'B', [], 'draft-failed', { variant: 'B', admissible: false, reason: 'x'.repeat(700) })
    expect(gated).toMatchObject({ editId: 'none', component: 'prompt', bundle: 0, accepted: false })
    expect(gated?.scoreChange).toBeUndefined()
    expect(gated?.detail).toHaveLength(600)
    const [bare] = history.appendCandidate(1, 'C', [promptEdit], 'critic-rejected')
    expect(bare?.detail).toBe('')
    expect(history.tried().size).toBe(0)
  })

  it('derives tried components, incumbent counts, recent yield, and the prune set', () => {
    const history = new EditHistory(componentSet)
    history.appendCandidate(0, 'A', [promptEdit], 'accepted', measured('A', 0.1))
    history.appendCandidate(0, 'B', [{ ...skillEdit, component: 'retired' }], 'rejected', measured('B', -0.2, false))
    history.appendCandidate(4, 'A', [skillEdit], 'accepted', measured('A', 0))
    history.appendCandidate(5, 'A', [promptEdit], 'rejected', measured('A', -0.05, false))
    expect([...history.tried()].sort()).toEqual(['prompt', 'skill'])
    expect(history.measured()).toHaveLength(3)
    expect(history.incumbentComponentCounts().get('prompt')).toBe(1)
    expect(history.incumbentComponentCounts().get('skill')).toBe(1)
    expect(history.incumbentComponentCounts().has('retired')).toBe(false)
    expect(history.recentYield(5, 4)).toEqual(new Map([['prompt', -0.05], ['skill', 0]]))
    expect(history.recentYield(10, 2)).toEqual(new Map([['prompt', Number.NEGATIVE_INFINITY], ['skill', Number.NEGATIVE_INFINITY]]))
    expect(history.pruneSet(5, 4)).toEqual([
      { component: 'prompt', recentBestGain: -0.05, acceptedEdits: [{ round: 0, editId: 'C1', hypothesis: 'shorter plans' }] },
      { component: 'skill', recentBestGain: 0, acceptedEdits: [{ round: 4, editId: 'C2', hypothesis: 'a review skill' }] },
    ])
    expect(history.pruneSet(10, 2).map(entry => entry.recentBestGain)).toEqual([undefined, undefined])
    expect(history.pruneSet(0, 4).map(entry => entry.component)).toEqual(['skill'])
  })

  it('renders the latest records, keeping only a few unmeasured ones', () => {
    const history = new EditHistory(componentSet)
    history.appendCandidate(0, 'A', [promptEdit], 'accepted', measured('A', 0.1))
    for (let round = 1; round <= 6; round += 1) history.appendCandidate(round, 'A', [promptEdit], 'smoke-failed')
    const rendered = history.render()
    expect(rendered.map(record => record.round)).toEqual([0, 3, 4, 5, 6])
    expect(history.render(2).map(record => record.round)).toEqual([5, 6])
  })

  it('round-trips through JSON Lines and rejects an invalid line', () => {
    const history = new EditHistory(componentSet)
    expect(history.toJsonl()).toBe('')
    history.appendCandidate(0, 'A', [promptEdit], 'accepted', measured('A', 0.1))
    history.appendCandidate(0, 'B', [skillEdit], 'smoke-failed')
    const text = history.toJsonl()
    expect(EditHistory.fromJsonl(`${text}\n`, componentSet).records()).toEqual(history.records())
    expect(() => EditHistory.fromJsonl(`${text}{"round":1}\n`, componentSet)).toThrow('self-improve history line 3 is not an edit record')
    for (const line of ['7', 'null', '{"round":0,"variant":"A","editId":"C1","component":"prompt","hypothesis":"","outcome":"won","accepted":true,"bundle":1,"detail":""}']) {
      expect(() => EditHistory.fromJsonl(line, componentSet)).toThrow('line 1')
    }
    const typed = '{"round":0,"variant":"A","editId":"C1","component":"prompt","hypothesis":"","outcome":"lost","accepted":false,"scoreChange":"0.1","bundle":1,"detail":""}'
    expect(() => EditHistory.fromJsonl(typed, componentSet)).toThrow('line 1')
    const cost = typed.replace('"scoreChange":"0.1"', '"costChange":"0.1"')
    expect(() => EditHistory.fromJsonl(cost, componentSet)).toThrow('line 1')
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
