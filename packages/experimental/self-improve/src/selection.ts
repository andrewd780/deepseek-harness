/**
 * The selection side of regularized recursive self-improvement: which
 * measured candidate, if any, replaces the incumbent.
 *
 * For a candidate with score S′ and cost C′ against an incumbent (S, C) and a
 * best score so far S*: ΔS = S′ − S and ΔC = (C′ − C) / C. The candidate is
 * admissible when S′ ≥ S* − δ, the cost rule holds, and no domain guard is
 * violated. The cost rule: when ΔS > δ, ΔC ≤ β₀ + β₁·ΔS (added tokens must be
 * paid for by measured gain); otherwise w_s·ΔS − w_c·ΔC + w_n·ν > 0 (inside the
 * noise band only a token saving or new structural machinery admits). The
 * winner is the admissible candidate with the highest S′.
 *
 * @module @deepseek-ai/dsh-experimental-self-improve/selection
 */

import { novelty } from './components.ts'
import type { ComponentSet } from './components.ts'
import { relativeCostChange } from './evaluate.ts'
import type { EvaluationResult } from './evaluate.ts'

/** The selection constants of one run. */
export interface SelectionPolicy {
  /** Noise band δ: a score change within it is not evidence of a gain. */
  readonly delta: number
  /** Relative cost increase allowed for any gain above δ. */
  readonly costAllowance: number
  /** Relative cost increase allowed per unit of score gain above δ. */
  readonly costPerGain: number
  /** Within-band weight of the score change. */
  readonly scoreWeight: number
  /** Within-band weight of the relative cost change. */
  readonly costWeight: number
  /** Within-band weight of novelty. */
  readonly noveltyWeight: number
}

/** A selection constant per unit of score, or per passing trial. */
export interface ScoreRate {
  readonly value: number
  /** Whether `value` is per passing trial, so the evaluation's trial count scales it. */
  readonly perPass: boolean
}

/** A run's selection constants before the size of its evaluations is known. */
export interface SelectionSettings {
  /** β₀: relative cost increase allowed for any gain above δ. */
  readonly costAllowance: number
  /** β₁: relative cost increase allowed per unit of score gain above δ. */
  readonly costPerGain: ScoreRate
  /** w_s: within-band weight of the score change. */
  readonly scoreWeight: ScoreRate
  /** w_c: within-band weight of the relative cost change. */
  readonly costWeight: number
  /** w_n: within-band weight of novelty. */
  readonly noveltyWeight: number
}

/**
 * The selection constants for evaluations of `trials` trials. One passing
 * trial moves the score by 1 / `trials`, so a per-pass rate is multiplied by
 * `trials`: 25% more tokens per pass over 89 tasks × 2 trials is the
 * reference coding instance's β₁ of 44.5.
 * @param settings - the run's selection settings.
 * @param trials - trials per evaluation: evolve tasks × trials per task.
 * @param delta - the noise band.
 * @returns the policy.
 */
export function resolveSelectionPolicy(settings: SelectionSettings, trials: number, delta: number): SelectionPolicy {
  const perScore = (rate: ScoreRate): number => (rate.perPass ? rate.value * trials : rate.value)
  return {
    delta,
    costAllowance: settings.costAllowance,
    costPerGain: perScore(settings.costPerGain),
    scoreWeight: perScore(settings.scoreWeight),
    costWeight: settings.costWeight,
    noveltyWeight: settings.noveltyWeight,
  }
}

/** One candidate edit, tagged with the component it changes and why. */
export interface CandidateEdit {
  readonly id: string
  readonly component: string
  readonly hypothesis: string
}

/** A drafted candidate: its edits, and either its evaluation or why it was not evaluated. */
export interface Candidate {
  readonly variant: string
  readonly edits: readonly CandidateEdit[]
  readonly evaluation?: EvaluationResult
  /** Why the candidate never reached evaluation (critic rejection, failed smoke check). */
  readonly gateFailure?: string
}

/** The verdict on a candidate that never reached evaluation. */
export interface UnmeasuredDecision {
  readonly variant: string
  readonly admissible: false
  readonly reason: string
}

/** The verdict on an evaluated candidate, with the measurements it rests on. */
export interface MeasuredDecision {
  readonly variant: string
  readonly admissible: boolean
  readonly reason: string
  readonly score: number
  readonly cost: number | undefined
  readonly scoreChange: number
  readonly costChange: number
  readonly novelty: number
  readonly guards: readonly string[]
}

/** The verdict on one candidate. */
export type Decision = UnmeasuredDecision | MeasuredDecision

/**
 * The cost rule for one measured change.
 * @param scoreChange - ΔS against the incumbent.
 * @param costChange - ΔC, the relative cost change.
 * @param noveltyCount - ν, new structural components.
 * @param policy - the run's selection constants.
 * @returns whether the rule holds, and the arithmetic behind it.
 */
export function costRule(
  scoreChange: number,
  costChange: number,
  noveltyCount: number,
  policy: SelectionPolicy,
): { readonly holds: boolean; readonly reason: string } {
  if (scoreChange > policy.delta) {
    const allowance = policy.costAllowance + policy.costPerGain * scoreChange
    const holds = costChange <= allowance
    return {
      holds,
      reason: `gain ${signed(scoreChange)} above band ${policy.delta}; cost change ${signed(costChange)} `
        + `${holds ? '<=' : '>'} allowance ${round(allowance)}`,
    }
  }
  const shaped = policy.scoreWeight * scoreChange - policy.costWeight * costChange + policy.noveltyWeight * noveltyCount
  const holds = shaped > 0
  return {
    holds,
    reason: `gain ${signed(scoreChange)} within band ${policy.delta}; shaped value ${signed(shaped)} `
      + `${holds ? '>' : '<='} 0 (novelty ${noveltyCount})`,
  }
}

/**
 * Judge one candidate against the incumbent.
 * @param candidate - the drafted candidate.
 * @param incumbent - the incumbent's evaluation.
 * @param bestScore - S*, the best incumbent score so far.
 * @param policy - the run's selection constants.
 * @param incumbentCounts - accepted edits per component in the incumbent.
 * @param componentSet - the domain's components.
 * @param guards - violated domain guards for this candidate.
 * @returns the decision.
 */
export function judgeCandidate(
  candidate: Candidate,
  incumbent: EvaluationResult,
  bestScore: number,
  policy: SelectionPolicy,
  incumbentCounts: ReadonlyMap<string, number>,
  componentSet: ComponentSet,
  guards: readonly string[] = [],
): Decision {
  const evaluation = candidate.evaluation
  if (evaluation === undefined) {
    return { variant: candidate.variant, admissible: false, reason: candidate.gateFailure ?? 'not evaluated' }
  }
  const scoreChange = evaluation.score - incumbent.score
  const costChange = relativeCostChange(evaluation.cost, incumbent.cost)
  const noveltyCount = novelty(candidate.edits.map(edit => edit.component), incumbentCounts, componentSet)
  const measured = {
    variant: candidate.variant,
    score: evaluation.score,
    cost: evaluation.cost,
    scoreChange,
    costChange,
    novelty: noveltyCount,
    guards,
  }
  const floor = bestScore - policy.delta
  if (evaluation.score < floor) {
    return {
      ...measured,
      admissible: false,
      reason: `below the noise-adjusted floor: ${round(evaluation.score)} < best ${round(bestScore)} - band ${policy.delta}`,
    }
  }
  const rule = costRule(scoreChange, costChange, noveltyCount, policy)
  if (!rule.holds) return { ...measured, admissible: false, reason: `cost rule failed: ${rule.reason}` }
  if (guards.length > 0) return { ...measured, admissible: false, reason: `domain guard violated: ${guards.join('; ')}` }
  return { ...measured, admissible: true, reason: `admissible: ${rule.reason}` }
}

/**
 * Judge every candidate of a round and pick the winner.
 * @param candidates - the round's candidates, in draft order.
 * @param incumbent - the incumbent's evaluation.
 * @param bestScore - S*, the best incumbent score so far.
 * @param policy - the run's selection constants.
 * @param incumbentCounts - accepted edits per component in the incumbent.
 * @param componentSet - the domain's components.
 * @param guardsFor - violated domain guards for one evaluated candidate.
 * @returns the winner (the first admissible candidate with the highest score), or `undefined`, and every
 * candidate with its decision in draft order.
 */
export function selectRound<C extends Candidate>(
  candidates: readonly C[],
  incumbent: EvaluationResult,
  bestScore: number,
  policy: SelectionPolicy,
  incumbentCounts: ReadonlyMap<string, number>,
  componentSet: ComponentSet,
  guardsFor: (incumbent: EvaluationResult, candidate: EvaluationResult) => readonly string[] = () => [],
): { readonly winner: C | undefined; readonly judged: readonly { readonly candidate: C; readonly decision: Decision }[] } {
  const judged = candidates.map(candidate => ({
    candidate,
    decision: judgeCandidate(
      candidate,
      incumbent,
      bestScore,
      policy,
      incumbentCounts,
      componentSet,
      candidate.evaluation === undefined ? [] : guardsFor(incumbent, candidate.evaluation),
    ),
  }))
  let winner: C | undefined
  let winningScore = Number.NEGATIVE_INFINITY
  for (const { candidate, decision } of judged) {
    if (decision.admissible && decision.score > winningScore) {
      winner = candidate
      winningScore = decision.score
    }
  }
  return { winner, judged }
}

function signed(value: number): string {
  return `${value >= 0 ? '+' : ''}${round(value)}`
}

function round(value: number): string {
  return value.toFixed(4)
}
