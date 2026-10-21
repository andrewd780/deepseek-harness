/**
 * The roles a self-improvement run composes: the domain that measures a
 * harness revision, the store of revisions, and the models that analyze,
 * propose, and review.
 *
 * @module @deepseek-ai/dsh-experimental-self-improve/types
 */

import type { EvaluationJobId, TaskId } from './brand.ts'
import type { ComponentSet } from './components.ts'
import type { EvaluationResult } from './evaluate.ts'
import type { CandidateEntry, ExplorationDirective, PruneEntry } from './history.ts'
import type { CandidateEdit } from './selection.ts'

/** One request to a model playing a search role. */
export interface TextRequest {
  readonly system: string
  readonly prompt: string
  readonly signal?: AbortSignal | undefined
}

/** A model that answers one request with text. */
export interface TextModel {
  /**
   * Answer one request.
   * @param request - the system text, the prompt, and the cancellation signal.
   * @returns the model's text.
   */
  complete(request: TextRequest): Promise<string>
}

/** A deterministic leakage pattern and the reason a match rejects a diff. */
export interface CriticPattern {
  readonly pattern: RegExp
  readonly reason: string
}

/** The critic's verdict on one candidate diff. */
export interface CriticVerdict {
  readonly verdict: 'accept' | 'reject'
  readonly reasons: readonly string[]
  readonly riskNotes: readonly string[]
}

/** What the critic reviews. */
export interface CriticRequest {
  readonly diff: string
  readonly summary: string
  readonly edits: readonly CandidateEdit[]
  readonly signal?: AbortSignal | undefined
}

/** Reviews a candidate before any evaluation is spent on it. */
export interface Critic {
  /**
   * Review one candidate.
   * @param request - the candidate's diff, summary, and declared edits.
   * @returns the verdict.
   */
  review(request: CriticRequest): Promise<CriticVerdict>
}

/** One evaluation of the harness checked out at `root`. */
export interface EvaluationRequest {
  /** Absolute path of the checkout whose evolved directory is measured. */
  readonly root: string
  readonly job: EvaluationJobId
  readonly tasks: readonly TaskId[]
  readonly trials: number
  readonly signal?: AbortSignal | undefined
}

/** Whether a candidate runs at all; not a selection rule. */
export interface SmokeResult {
  readonly ok: boolean
  readonly detail: string
}

/** A trial chosen as evidence: the worst trial of a weak task, or the best trial of a strong one. */
export interface TraceReference {
  readonly task: TaskId
  readonly trial: number
  readonly kind: 'failure' | 'success'
  readonly reward: number
}

/** A trial's trajectory rendered for the analyst and the proposer. */
export interface RenderedTrace extends TraceReference {
  readonly text: string
}

/** Domain texts that make the search roles speak the task suite's language. */
export interface DomainBriefs {
  readonly analyst: string
  readonly proposer: string
  readonly critic: string
}

/** Everything a run needs from the task suite a harness is measured on. */
export interface SelfImproveDomain {
  readonly componentSet: ComponentSet
  readonly briefs: DomainBriefs
  /** @returns the tasks every candidate is measured on. */
  evolveTasks(): readonly TaskId[]
  /** @returns tasks never shown to the search, for measuring transfer. */
  heldoutTasks(): readonly TaskId[]
  /**
   * Tasks for the liveness check.
   * @param incumbent - the incumbent's evaluation.
   * @returns the smoke tasks.
   */
  smokeTasks(incumbent: EvaluationResult): readonly TaskId[]
  /**
   * Measure the checkout on the tasks. Measuring a job again runs only the
   * trials that produced no result.
   * @param request - the checkout, job, tasks, and trials.
   * @returns the evaluation; a trial without a result counts as reward 0.
   */
  evaluate(request: EvaluationRequest): Promise<EvaluationResult>
  /**
   * Check that the checkout runs at all.
   * @param request - the checkout, job, smoke tasks, and one trial.
   * @returns whether it ran, with the evidence.
   */
  smoke(request: EvaluationRequest): Promise<SmokeResult>
  /**
   * Objections to a checkout's evolved files that no review overrules; the
   * loop raises them before the critic reviews a candidate, and measuring a
   * checkout with an objection fails.
   * @param root - absolute path of the checkout root.
   * @returns one objection per broken rule; empty when the files are acceptable.
   */
  screen(root: string): Promise<readonly string[]>
  /**
   * Non-compensatory criteria a gain cannot buy off.
   * @param incumbent - the incumbent's evaluation.
   * @param candidate - the candidate's evaluation.
   * @returns the violated criteria; empty when none.
   */
  guards(incumbent: EvaluationResult, candidate: EvaluationResult): readonly string[]
  /**
   * Render one trial's trajectory.
   * @param job - the evaluation job.
   * @param task - the task.
   * @param trial - the zero-based trial index.
   * @param signal - cancellation.
   * @returns the rendered text, or `undefined` when the trial left no trajectory.
   */
  renderTrace(job: EvaluationJobId, task: TaskId, trial: number, signal?: AbortSignal): Promise<string | undefined>
}

/** A candidate's isolated checkout of the evolved directory. */
export interface CandidateCheckout {
  readonly name: string
  readonly branch: string
  /** The commit the checkout was created from. */
  readonly base: string
  /** Absolute path of the checkout root. */
  readonly root: string
  /** Absolute path of the evolved directory inside the checkout. */
  readonly evolvedDirectory: string
  /**
   * The evolved directory's changes against the checkout's base, new files included.
   * @param signal - cancellation.
   * @returns a unified diff; empty when nothing changed.
   */
  diff(signal?: AbortSignal): Promise<string>
  /**
   * Commit the evolved directory's changes on the candidate branch.
   * @param message - the commit message.
   * @param signal - cancellation.
   * @returns the commit.
   */
  commit(message: string, signal?: AbortSignal): Promise<string>
}

/** The revisions of the evolved directory: the evolve branch and one checkout per candidate. */
export interface RevisionStore {
  /**
   * @param signal - cancellation.
   * @returns the commit at the tip of the evolve branch.
   */
  tip(signal?: AbortSignal): Promise<string>
  /**
   * Move the evolve branch to `commit`.
   * @param commit - the new incumbent.
   * @param signal - cancellation.
   * @throws Error when the branch tip is neither `commit` nor an ancestor of it: the branch carries a revision the run never measured.
   */
  advance(commit: string, signal?: AbortSignal): Promise<void>
  /**
   * Create the checkout `name` on a new branch, discarding a checkout and
   * branch an interrupted draft of the same name left behind.
   * @param name - the checkout's name, unique within the run.
   * @param from - the commit to start from; omitted starts from the evolve branch tip.
   * @param signal - cancellation.
   * @returns the checkout.
   */
  create(name: string, from?: string, signal?: AbortSignal): Promise<CandidateCheckout>
  /**
   * The checkout of an existing branch, checked out again when it was released.
   * @param name - the checkout's name.
   * @param signal - cancellation.
   * @returns the checkout.
   */
  reopen(name: string, signal?: AbortSignal): Promise<CandidateCheckout>
  /**
   * Remove a checkout when present and keep its branch.
   * @param name - the checkout's name.
   * @param signal - cancellation.
   */
  release(name: string, signal?: AbortSignal): Promise<void>
}

/** The rejection a repair attempt answers. */
export interface RepairBrief {
  readonly reasons: readonly string[]
  readonly riskNotes: readonly string[]
  readonly declared: readonly CandidateEdit[]
}

/** The context of one candidate draft. */
export interface ProposalRequest {
  readonly round: number
  readonly rounds: number
  readonly variant: string
  readonly variants: number
  readonly checkout: CandidateCheckout
  /** Most independent edits the candidate may declare. */
  readonly budget: number
  readonly exploration: ExplorationDirective
  /** Whether this variant holds a slot reserved for untried components. */
  readonly reserved: boolean
  /** B_t: components whose recent edits gained nothing, each with its accepted edits and their source diffs. */
  readonly prune: readonly PruneEntry[]
  /** L_t: measured candidates, oldest first, each with its edits, measurement, and source diff. */
  readonly history: readonly CandidateEntry[]
  readonly analysis: string
  readonly evidence: readonly RenderedTrace[]
  readonly incumbent: EvaluationResult
  readonly componentSet: ComponentSet
  readonly briefs: DomainBriefs
  /** Present when the critic rejected the previous draft of this variant. */
  readonly repair?: RepairBrief
  readonly signal?: AbortSignal | undefined
}

/** A drafted candidate, edited in place in its checkout. */
export interface Proposal {
  /** `failed` when the proposer could not ship a candidate. */
  readonly status: 'done' | 'failed'
  readonly summary: string
  readonly edits: readonly CandidateEdit[]
  /** The draft's model interaction, kept in the run directory. */
  readonly transcript?: string
}

/** Drafts candidates by editing the evolved directory in a checkout. */
export interface Proposer {
  /**
   * Draft or repair one candidate.
   * @param request - the round's directives and evidence.
   * @returns the proposal.
   */
  propose(request: ProposalRequest): Promise<Proposal>
}

/** The context of one round's analysis. */
export interface AnalysisRequest {
  readonly round: number
  readonly evidence: readonly RenderedTrace[]
  readonly incumbent: EvaluationResult
  readonly briefs: DomainBriefs
  /** The previous round's report, so recurring findings stay named consistently. */
  readonly previous: string
  readonly signal?: AbortSignal | undefined
}

/** Turns the incumbent's evidence into a report every variant of the round shares. */
export interface Analyst {
  /**
   * Analyze the incumbent's trajectories.
   * @param request - the evidence and the previous report.
   * @returns the report.
   */
  analyze(request: AnalysisRequest): Promise<string>
}
