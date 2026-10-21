/**
 * The edit history of a self-improvement run and the summaries the proposer
 * and the selection rules read from it.
 *
 * One record per edit. A candidate that bundles several edits gets one
 * measurement, and every edit in the bundle carries it; as the edit budget
 * anneals to 1 a record becomes evidence about a single component. A
 * candidate dropped before measurement (critic rejection, failed smoke check)
 * is recorded without a score change and never counts as tried.
 *
 * @module @deepseek-ai/dsh-experimental-self-improve/history
 */

import type { ComponentSet } from './components.ts'
import type { CandidateEdit, Decision } from './selection.ts'

/** How a measured candidate's round ended for it. */
export type MeasuredOutcome = 'accepted' | 'rejected' | 'lost'

/** Why a candidate never reached measurement. */
export type GateOutcome = 'draft-failed' | 'critic-rejected' | 'smoke-failed' | 'evaluation-invalid'

/** One edit of one candidate. */
export interface EditRecord {
  readonly round: number
  readonly variant: string
  readonly editId: string
  readonly component: string
  readonly hypothesis: string
  readonly outcome: MeasuredOutcome | GateOutcome
  /** Whether this edit's candidate became the incumbent. */
  readonly accepted: boolean
  /** ΔS of the edit's candidate; absent when the candidate was never measured. */
  readonly scoreChange?: number
  /** ΔC of the edit's candidate; absent when the candidate was never measured. */
  readonly costChange?: number
  /** Edits in the candidate's bundle. */
  readonly bundle: number
  /** The decision's or the gate's reason, at most 600 characters. */
  readonly detail: string
}

/** A record whose candidate was measured. */
export type MeasuredRecord = EditRecord & { readonly scoreChange: number }

/** A component whose recent edits gained nothing, with the machinery the incumbent carries for it. */
export interface PruneEntry {
  readonly component: string
  /** Best recent ΔS, or `undefined` when the component has no recent measured edit. */
  readonly recentBestGain: number | undefined
  readonly acceptedEdits: readonly { readonly round: number; readonly editId: string; readonly hypothesis: string }[]
}

/** Whether the run has stalled, which components it never exercised, and the directive the proposer receives. */
export interface ExplorationDirective {
  readonly stalled: boolean
  readonly untried: readonly string[]
  /** Candidate slots reserved for edits on untried components this round. */
  readonly reservedSlots: number
  readonly directive: string
}

const MEASURED_OUTCOMES: ReadonlySet<string> = new Set(['accepted', 'rejected', 'lost'])
const GATE_OUTCOMES: ReadonlySet<string> = new Set(['draft-failed', 'critic-rejected', 'smoke-failed', 'evaluation-invalid'])

/** Unmeasured records kept in a rendered view: a wall of gate failures is a feedback loop, not evidence. */
const RENDERED_UNMEASURED = 4

/** The edit history of one run. */
export class EditHistory {
  private readonly entries: EditRecord[]

  /**
   * @param componentSet - the domain's components; records naming another component never count as measured.
   * @param records - existing records, oldest first.
   */
  constructor(private readonly componentSet: ComponentSet, records: readonly EditRecord[] = []) {
    this.entries = [...records]
  }

  /**
   * Every record, oldest first.
   * @returns the records.
   */
  records(): readonly EditRecord[] {
    return this.entries
  }

  /**
   * Record one candidate's edits with its decision, or with the gate that stopped it.
   * @param round - the round the candidate was drafted in.
   * @param variant - the candidate's label within the round.
   * @param edits - the candidate's edits; a candidate whose draft produced none is recorded as one placeholder edit.
   * @param outcome - the gate failure, or the measured outcome.
   * @param decision - the selection decision of a measured candidate.
   * @returns the appended records.
   */
  appendCandidate(
    round: number,
    variant: string,
    edits: readonly CandidateEdit[],
    outcome: MeasuredOutcome | GateOutcome,
    decision?: Decision,
  ): readonly EditRecord[] {
    const bundle = edits.length
    const recorded: readonly CandidateEdit[] = bundle === 0
      ? [{ id: 'none', component: this.componentSet.fallback, hypothesis: '' }]
      : edits
    const measured = decision !== undefined && 'score' in decision ? decision : undefined
    const appended = recorded.map((edit): EditRecord => ({
      round,
      variant,
      editId: edit.id,
      component: edit.component,
      hypothesis: edit.hypothesis,
      outcome,
      accepted: outcome === 'accepted',
      ...measured === undefined ? {} : { scoreChange: measured.scoreChange, costChange: measured.costChange },
      bundle,
      detail: (decision?.reason ?? '').slice(0, 600),
    }))
    this.entries.push(...appended)
    return appended
  }

  /**
   * Whether a candidate of a round is already recorded, so a resumed round does not record it twice.
   * @param round - the round.
   * @param variant - the candidate's label within the round.
   * @returns true when any record carries both.
   */
  has(round: number, variant: string): boolean {
    return this.entries.some(record => record.round === round && record.variant === variant)
  }

  /**
   * Records whose candidate was measured, on a component of the set.
   * @returns the measured records, oldest first.
   */
  measured(): readonly MeasuredRecord[] {
    return this.entries.filter((record): record is MeasuredRecord =>
      record.scoreChange !== undefined && this.componentSet.names.includes(record.component))
  }

  /**
   * Components with at least one measured edit.
   * @returns the tried components.
   */
  tried(): ReadonlySet<string> {
    return new Set(this.measured().map(record => record.component))
  }

  /**
   * Accepted edits per component: the machinery the incumbent carries.
   * @returns the count for every component of the set.
   */
  incumbentComponentCounts(): ReadonlyMap<string, number> {
    const counts = new Map(this.componentSet.names.map(component => [component, 0]))
    for (const record of this.entries) {
      const count = counts.get(record.component)
      if (record.accepted && count !== undefined) counts.set(record.component, count + 1)
    }
    return counts
  }

  /**
   * The best ΔS each tried component reached within `window` rounds of `round`.
   * @param round - the current round.
   * @param window - how many rounds back count as recent.
   * @returns the recent best gain per tried component; `-Infinity` when nothing is recent.
   */
  recentYield(round: number, window: number): ReadonlyMap<string, number> {
    const recent = this.recent(round, window)
    return new Map([...this.tried()].map(component => [component, bestGain(component, recent)]))
  }

  /**
   * Tried components whose recent best gain is not positive, with the
   * accepted machinery the proposer may remove.
   * @param round - the current round.
   * @param window - how many rounds back count as recent.
   * @returns the prune set, ordered by component name.
   */
  pruneSet(round: number, window: number): readonly PruneEntry[] {
    const recent = this.recent(round, window)
    return [...this.tried()].sort().flatMap((component) => {
      const gain = bestGain(component, recent)
      if (gain > 0) return []
      return [{
        component,
        recentBestGain: gain === Number.NEGATIVE_INFINITY ? undefined : gain,
        acceptedEdits: this.entries
          .filter(record => record.accepted && record.component === component)
          .map(record => ({ round: record.round, editId: record.editId, hypothesis: record.hypothesis })),
      }]
    })
  }

  /**
   * The most recent records for the proposer's context. Measured records
   * dominate: only the latest few unmeasured records are kept.
   * @param limit - most records returned.
   * @returns the records, oldest first.
   */
  render(limit = 40): readonly EditRecord[] {
    const kept: EditRecord[] = []
    let unmeasured = 0
    for (const record of [...this.entries].reverse()) {
      if (kept.length >= limit) break
      if (record.scoreChange === undefined) {
        unmeasured += 1
        if (unmeasured > RENDERED_UNMEASURED) continue
      }
      kept.push(record)
    }
    return kept.reverse()
  }

  /** Measured records within `window` rounds of `round`. */
  private recent(round: number, window: number): readonly MeasuredRecord[] {
    return this.measured().filter(record => round - record.round <= window)
  }

  /**
   * Serialize as JSON Lines, one record per line.
   * @returns the JSONL text, ending with a newline when not empty.
   */
  toJsonl(): string {
    return this.entries.map(record => `${JSON.stringify(record)}\n`).join('')
  }

  /**
   * Read a history persisted with {@link EditHistory.toJsonl}.
   * @param text - the JSONL file contents.
   * @param componentSet - the domain's components.
   * @returns the history.
   * @throws Error naming the line of a record that is not a valid edit record.
   */
  static fromJsonl(text: string, componentSet: ComponentSet): EditHistory {
    const records = text.split('\n').flatMap((line, index) => {
      if (line.trim().length === 0) return []
      const value: unknown = JSON.parse(line)
      if (!isEditRecord(value)) throw new Error(`self-improve history line ${index + 1} is not an edit record`)
      return [value]
    })
    return new EditHistory(componentSet, records)
  }
}

/** The best score change among a component's records; `-Infinity` when it has none. */
function bestGain(component: string, records: readonly MeasuredRecord[]): number {
  return Math.max(Number.NEGATIVE_INFINITY, ...records.filter(record => record.component === component).map(record => record.scoreChange))
}

/** Validate one parsed history line. */
function isEditRecord(value: unknown): value is EditRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Readonly<Record<string, unknown>>
  return Number.isInteger(record['round'])
    && typeof record['variant'] === 'string'
    && typeof record['editId'] === 'string'
    && typeof record['component'] === 'string'
    && typeof record['hypothesis'] === 'string'
    && typeof record['outcome'] === 'string'
    && (MEASURED_OUTCOMES.has(record['outcome']) || GATE_OUTCOMES.has(record['outcome']))
    && typeof record['accepted'] === 'boolean'
    && (record['scoreChange'] === undefined || typeof record['scoreChange'] === 'number')
    && (record['costChange'] === undefined || typeof record['costChange'] === 'number')
    && Number.isInteger(record['bundle'])
    && typeof record['detail'] === 'string'
}

/**
 * Whether the incumbent has stopped moving: its score rose by no more than the
 * noise band over the last `window` rounds.
 * @param trajectory - the incumbent's score after each round, index 0 the baseline.
 * @param round - the current round.
 * @param window - rounds compared.
 * @param delta - the noise band.
 * @returns true when stalled; false while fewer than `window` rounds exist.
 */
export function stallFlag(trajectory: readonly number[], round: number, window: number, delta: number): boolean {
  const current = trajectory[round]
  const earlier = trajectory[round - window]
  if (round < window || current === undefined || earlier === undefined) return false
  return current - earlier <= delta
}

/**
 * The exploration directive for a round: when the run has stalled, reserve
 * candidate slots for edits on components it has never exercised.
 * @param stalled - the stall flag.
 * @param tried - components with a measured edit.
 * @param reservedSlots - slots a stalled round reserves.
 * @param componentSet - the domain's components.
 * @returns the directive.
 */
export function exploration(
  stalled: boolean,
  tried: ReadonlySet<string>,
  reservedSlots: number,
  componentSet: ComponentSet,
): ExplorationDirective {
  const untried = componentSet.names.filter(component => !tried.has(component))
  if (stalled && untried.length > 0) {
    return {
      stalled,
      untried,
      reservedSlots,
      directive: 'The incumbent has not improved beyond the noise band in recent rounds. '
        + `${reservedSlots} candidate slot(s) this round are reserved for components this run has never `
        + `changed: ${untried.join(', ')}. A candidate in a reserved slot must change at least one of them.`,
    }
  }
  return {
    stalled,
    untried,
    reservedSlots: 0,
    directive: untried.length > 0
      ? `Components this run has not changed yet: ${untried.join(', ')}. No slot is reserved this round.`
      : 'Every component has been changed at least once.',
  }
}
