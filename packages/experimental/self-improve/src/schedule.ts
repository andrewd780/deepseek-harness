/**
 * The annealed edit budget of regularized recursive self-improvement.
 *
 * @module @deepseek-ai/dsh-experimental-self-improve/schedule
 */

/**
 * How many independent edits one candidate may bundle in a round:
 * `ceil(minEdits + (maxEdits − minEdits) · ½ · (1 + cos(π · round / rounds)))`,
 * with `round` clamped to `[0, rounds]`. Early rounds may bundle coordinated
 * edits; late rounds approach single edits whose measured effect is
 * attributable. The budget limits how many edits one proposal carries, not
 * which components the harness may eventually contain. Because of the
 * ceiling, the last round of a run (`rounds − 1`) can still exceed `minEdits`:
 * 1 to 4 over 20 rounds ends at 2.
 * @param round - zero-based round index.
 * @param rounds - total rounds of the run; a non-positive count gives `maxEdits`.
 * @param minEdits - the budget at `round = rounds`, at least 1.
 * @param maxEdits - the budget at round 0, at least `minEdits`.
 * @returns the edit budget for `round`.
 */
export function editBudget(round: number, rounds: number, minEdits: number, maxEdits: number): number {
  if (rounds <= 0) return maxEdits
  const t = Math.max(0, Math.min(round, rounds))
  const value = minEdits + (maxEdits - minEdits) * 0.5 * (1 + Math.cos(Math.PI * t / rounds))
  // Nine decimals keep floating error at t = rounds (1.0000000002) from rounding up to 2.
  return Math.ceil(Number(value.toFixed(9)))
}
