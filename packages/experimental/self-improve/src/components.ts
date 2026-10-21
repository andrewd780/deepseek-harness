/**
 * The set of harness components a candidate edit may change, and the
 * rules that keep an edit's declared component honest.
 *
 * @module @deepseek-ai/dsh-experimental-self-improve/components
 */

/** Diff patterns that are evidence a change touches one component. */
export interface ComponentSignal {
  readonly component: string
  readonly patterns: readonly RegExp[]
}

/**
 * A domain's component set. Structural components add machinery (a
 * tool, a skill, a memory, a sub-agent) rather than changing text or values;
 * only they count toward novelty.
 */
export interface ComponentSet {
  /** Every component name an edit may declare. */
  readonly names: readonly string[]
  /** The subset of `names` that adds machinery. */
  readonly structural: readonly string[]
  /** Per-component diff evidence, checked in order. */
  readonly signals: readonly ComponentSignal[]
  /** The component of a diff no signal matches, usually the instruction text. */
  readonly fallback: string
}

/**
 * The component a diff changes by its evidence: the first signal that matches,
 * else the set's fallback.
 * @param diff - unified diff of one candidate.
 * @param componentSet - the domain's components and signals.
 * @returns the classified component.
 */
export function classifyDiff(diff: string, componentSet: ComponentSet): string {
  for (const signal of componentSet.signals) {
    if (signal.patterns.some(pattern => pattern.test(diff))) return signal.component
  }
  return componentSet.fallback
}

/**
 * Keep a declared component only when it is in the set and the diff
 * carries evidence for it; otherwise classify the diff. A proposer can name a
 * structural component it never shipped, or relabel an edit to fill an
 * exploration slot, and an unverified label corrupts the tried set, the
 * recent yield, and novelty.
 * @param declared - the component the proposer declared, if any.
 * @param diff - unified diff of the candidate.
 * @param componentSet - the domain's components and signals.
 * @returns the component recorded for the edit.
 */
export function normalizeComponent(declared: string | undefined, diff: string, componentSet: ComponentSet): string {
  const name = (declared ?? '').trim().toLowerCase()
  if (componentSet.names.includes(name) && hasEvidence(name, diff, componentSet)) return name
  return classifyDiff(diff, componentSet)
}

/** Whether any signal for `component` matches the diff; the fallback needs none. */
function hasEvidence(component: string, diff: string, componentSet: ComponentSet): boolean {
  if (component === componentSet.fallback) return true
  return componentSet.signals.some(signal => signal.component === component
    && signal.patterns.some(pattern => pattern.test(diff)))
}

/**
 * Structural components a candidate touches on which the incumbent has no
 * accepted edit. Novelty only breaks ties inside the noise band.
 * @param components - components of the candidate's edits.
 * @param incumbentCounts - accepted edits per component in the incumbent.
 * @param componentSet - the domain's components.
 * @returns the novelty count.
 */
export function novelty(
  components: readonly string[],
  incumbentCounts: ReadonlyMap<string, number>,
  componentSet: ComponentSet,
): number {
  return [...new Set(components)]
    .filter(component => componentSet.structural.includes(component) && (incumbentCounts.get(component) ?? 0) === 0)
    .length
}
