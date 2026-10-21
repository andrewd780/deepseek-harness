/**
 * The annealed edit budget of regularized recursive self-improvement.
 *
 * @module @deepseek-ai/dsh-experimental-self-improve/schedule
 */

/**
 * How many independent edits one candidate may bundle in a round:
 * `ceil(minEdits + (maxEdits − minEdits) · ½ · (1 + cos(π · round / (rounds − 1))))`,
 * with `round` clamped to `[0, rounds − 1]`, so round 0 gets `maxEdits` and the
 * last round gets `minEdits`, the paper's final-round budget. The paper's
 * Eq. 4 divides by `rounds` over rounds `0 … rounds − 1` and so never reaches
 * `minEdits` (1 to 4 over 20 rounds ends at 2); the cosine here runs to the
 * last round played, as the paper's text describes the schedule. Early rounds
 * may bundle coordinated edits; late rounds make single edits whose measured
 * effect is attributable. The budget limits how many edits one proposal
 * carries, not which components the harness may eventually contain.
 * @param round - zero-based round index.
 * @param rounds - total rounds of the run; one round or fewer gives `maxEdits`.
 * @param minEdits - the budget of the last round, at least 1.
 * @param maxEdits - the budget of round 0, at least `minEdits`.
 * @returns the edit budget for `round`.
 */
export function editBudget(round: number, rounds: number, minEdits: number, maxEdits: number): number {
  if (rounds <= 1) return maxEdits
  const last = rounds - 1
  const t = Math.max(0, Math.min(round, last))
  const value = minEdits + (maxEdits - minEdits) * 0.5 * (1 + Math.cos(Math.PI * t / last))
  // Nine decimals keep floating error at the last round (1.0000000002) from rounding up to 2.
  return Math.ceil(Number(value.toFixed(9)))
}
