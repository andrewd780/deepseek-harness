/**
 * One self-improvement run: the baseline, the noise-band calibration, the
 * rounds of regularized recursive self-improvement, and held-out measurement.
 *
 * A round, for incumbent H_t:
 * 1. Evidence and analysis: the worst trials of the weakest tasks and the best
 *    trials of the strongest, rendered and analyzed once for every variant.
 * 2. Directives: the annealed edit budget, the stall flag, the components never
 *    tried, the candidate slots a stall reserves for them, and the prune set.
 * 3. Drafts: each variant gets its own checkout of H_t. The proposer edits the
 *    evolved directory; the edit budget, the critic, and a reserved slot's
 *    obligation screen the diff with bounded repair; declared components are
 *    checked against the diff; the candidate is committed and smoke-checked.
 * 4. Evaluation of every screened candidate on the evolve tasks.
 * 5. Selection: the noise floor, the cost rule, and the domain guards; the
 *    highest admissible score wins.
 * 6. The history and then the trajectory are written, the round's commit
 *    point, and the evolve branch moves to the winner.
 *
 * Each stage stores its result under the run directory before the next starts:
 * a round interrupted after evaluating a candidate reuses that evaluation when
 * it runs again. Accepted revisions exist only on the evolve branch; nothing
 * outside the run's checkouts changes.
 *
 * @module @deepseek-ai/dsh-experimental-self-improve/loop
 */

import { join } from 'node:path'

import { EvaluationJobId } from './brand.ts'
import type { TaskId } from './brand.ts'
import { calibrate } from './calibrate.ts'
import type { Calibration, CalibrationSettings } from './calibrate.ts'
import { normalizeComponent } from './components.ts'
import type { CandidateRecord, GatedCandidate, ReadyCandidate, Revision, RunDirectory, Trajectory } from './directory.ts'
import type { EvaluationResult } from './evaluate.ts'
import { renderEvidence, selectTraces } from './evidence.ts'
import { exploration, stallFlag } from './history.ts'
import type { EditRecord, ExplorationDirective, GateOutcome, PruneEntry } from './history.ts'
import { editBudget } from './schedule.ts'
import { selectRound } from './selection.ts'
import type { Candidate, CandidateEdit, Decision, SelectionPolicy } from './selection.ts'
import type {
  Analyst,
  CandidateCheckout,
  Critic,
  CriticVerdict,
  Proposal,
  ProposalRequest,
  Proposer,
  RenderedTrace,
  RevisionStore,
  SelfImproveDomain,
} from './types.ts'

/** The constants of one run. */
export interface RunSettings {
  /** T: rounds in the run. */
  readonly rounds: number
  /** m: candidates drafted per round, at most 26. */
  readonly variants: number
  /** k: trials per task. */
  readonly trials: number
  /** The edit budget at the end of the run. */
  readonly minEdits: number
  /** The edit budget of round 0. */
  readonly maxEdits: number
  /** w: rounds the stall flag compares. */
  readonly stallWindow: number
  /** Candidate slots a stalled round reserves for components the run never changed. */
  readonly reservedSlots: number
  /** Rounds back that count as recent for the prune set. */
  readonly pruneWindow: number
  /** Critic rejections one candidate may repair. */
  readonly repairRounds: number
  /** Weakest tasks whose worst trial is shown as evidence. */
  readonly failureTraces: number
  /** Strongest tasks whose best trial is shown as evidence. */
  readonly successTraces: number
  /** Fraction of trials that may produce no result before an evaluation is invalid. */
  readonly maxMissingFraction: number
  /** History records the proposer sees. */
  readonly historyLimit: number
  /** δ; `undefined` reads the run's calibration. */
  readonly delta: number | undefined
  readonly selection: Omit<SelectionPolicy, 'delta'>
}

/** The roles one run composes. */
export interface RunRoles {
  readonly domain: SelfImproveDomain
  readonly store: RevisionStore
  readonly analyst: Analyst
  readonly proposer: Proposer
  readonly critic: Critic
  readonly directory: RunDirectory
  /** Receives one line per stage. */
  readonly log: (message: string) => void
}

/** The result of one round. */
export interface RoundOutcome {
  readonly round: number
  /** The winning candidate's label, or `undefined` when no candidate was admissible. */
  readonly winner: string | undefined
  /** H_{t+1}. */
  readonly incumbent: Revision
  readonly decisions: readonly Decision[]
}

/** Where a run stands. */
export interface RunStatus {
  /** Incumbents so far, H_0 first; empty before the baseline. */
  readonly trajectory: readonly Revision[]
  /** The next round to run, or `undefined` before the baseline and after the last round. */
  readonly nextRound: number | undefined
}

interface DraftContext {
  readonly round: number
  readonly variant: string
  readonly reserved: boolean
  readonly budget: number
  readonly exploration: ExplorationDirective
  readonly prune: readonly PruneEntry[]
  readonly history: readonly EditRecord[]
  readonly analysis: string
  readonly evidence: readonly RenderedTrace[]
  readonly incumbent: EvaluationResult
  readonly signal: AbortSignal | undefined
}

interface Measured extends Candidate {
  /** The candidate's commit and evaluation; absent when a gate stopped it. */
  readonly revision?: { readonly commit: string; readonly evaluation: EvaluationResult }
  readonly gate?: GateOutcome
}

type Measurement =
  | { readonly ok: true; readonly evaluation: EvaluationResult }
  | { readonly ok: false; readonly detail: string }

const RECORD_DETAIL = 600

/** One run over a domain. */
export class SelfImproveRun {
  /**
   * @param roles - the domain, revision store, search roles, and run directory.
   * @param settings - the run's constants.
   */
  constructor(private readonly roles: RunRoles, private readonly settings: RunSettings) {}

  /**
   * Read the run's progress without taking the run's lock.
   * @returns the trajectory and the next round.
   */
  async status(): Promise<RunStatus> {
    const trajectory = await this.roles.directory.readTrajectory() ?? []
    const nextRound = trajectory.length === 0 || trajectory.length > this.settings.rounds ? undefined : trajectory.length - 1
    return { trajectory, nextRound }
  }

  /**
   * Measure H_0, the evolve branch tip, and start the trajectory.
   * @param signal - cancellation.
   * @returns H_0.
   * @throws Error when the run already has a baseline, or when too many trials produce no result.
   */
  async baseline(signal?: AbortSignal): Promise<Revision> {
    return await this.roles.directory.exclusive(async () => {
      const { directory } = this.roles
      if (await directory.readTrajectory() !== undefined) throw new Error(`self-improve run ${directory.root} already has a baseline`)
      const tasks = this.roles.domain.evolveTasks()
      const { base, evaluation } = await this.measureFresh('baseline', commit => EvaluationJobId(`base-${commit.slice(0, 12)}`), tasks, undefined, signal)
      const revision: Revision = { commit: base, job: evaluation.job, score: evaluation.score, cost: evaluation.cost }
      await directory.writeTrajectory([revision])
      this.roles.log(`baseline ${base}: score ${evaluation.score.toFixed(4)}, cost ${evaluation.cost ?? 'not reported'}`)
      return revision
    })
  }

  /**
   * Measure H_0 again `repeats` times and calibrate δ from every measurement of it.
   * @param repeats - additional measurements; 0 bootstraps from the baseline alone.
   * @param settings - z, resamples, and seed.
   * @param signal - cancellation.
   * @returns the calibration, also stored in the run directory.
   * @throws Error before the baseline, or once a round has run.
   */
  async calibrate(repeats: number, settings: CalibrationSettings, signal?: AbortSignal): Promise<Calibration> {
    return await this.roles.directory.exclusive(async () => {
      const { directory } = this.roles
      const trajectory = await this.requireTrajectory()
      if (trajectory.length > 1) throw new Error('self-improve calibrates the baseline only before the first round')
      const base = trajectory[0]
      const evaluations = [await this.requireEvaluation(base.job)]
      for (let repeat = 1; repeat <= repeats; repeat += 1) {
        const job = EvaluationJobId(`${base.job}-${repeat}`)
        const stored = await directory.readEvaluation(job)
        const tasks = this.roles.domain.evolveTasks()
        const measured = stored ?? (await this.measureFresh(`base-${repeat}`, () => job, tasks, base.commit, signal)).evaluation
        evaluations.push(measured)
      }
      const calibration = calibrate(evaluations, settings)
      await directory.writeCalibration(calibration)
      this.roles.log(`calibrated delta ${calibration.delta.toFixed(5)} (${calibration.method}, ${evaluations.length} evaluation(s))`)
      return calibration
    })
  }

  /**
   * Measure a revision of the trajectory on the domain's held-out tasks.
   * @param index - the trajectory entry; omitted measures the current incumbent.
   * @param signal - cancellation.
   * @returns the evaluation, also stored as job `heldout-<index>`.
   * @throws Error before the baseline, for an index outside the trajectory, or when too many trials produce no result.
   */
  async heldout(index: number | undefined, signal?: AbortSignal): Promise<EvaluationResult> {
    return await this.roles.directory.exclusive(async () => {
      const trajectory = await this.requireTrajectory()
      const entry = index ?? trajectory.length - 1
      const revision = trajectory[entry]
      if (revision === undefined) throw new Error(`self-improve trajectory has no revision ${entry}`)
      const job = EvaluationJobId(`heldout-${entry}`)
      const stored = await this.roles.directory.readEvaluation(job)
      if (stored !== undefined) return stored
      return (await this.measureFresh(`heldout-${entry}`, () => job, this.roles.domain.heldoutTasks(), revision.commit, signal)).evaluation
    })
  }

  /**
   * Run the next round.
   * @param signal - cancellation.
   * @returns the round's outcome.
   * @throws Error before the baseline, after the last round, without a noise band, or when the evolve branch
   * carries a revision the run never measured.
   */
  async round(signal?: AbortSignal): Promise<RoundOutcome> {
    return await this.roles.directory.exclusive(async () => await this.runRound(signal))
  }

  private async runRound(signal: AbortSignal | undefined): Promise<RoundOutcome> {
    const { domain, store, directory, log } = this.roles
    const { settings } = this
    const trajectory = await this.requireTrajectory()
    const round = trajectory.length - 1
    if (round >= settings.rounds) throw new Error(`self-improve run ${directory.root} has completed its ${settings.rounds} round(s)`)
    const incumbent = latest(trajectory)
    await store.advance(incumbent.commit, signal)
    const incumbentEvaluation = await this.requireEvaluation(incumbent.job)
    const delta = await this.noiseBand()
    const policy: SelectionPolicy = { ...settings.selection, delta }
    const bestScore = Math.max(...trajectory.map(entry => entry.score))
    const tasks = domain.evolveTasks()

    const references = selectTraces(incumbentEvaluation.perTask, settings.failureTraces, settings.successTraces)
    const evidence = await renderEvidence(domain, incumbent.job, references, signal)
    const wanted = Math.min(tasks.length, settings.failureTraces + settings.successTraces)
    if (evidence.length < wanted / 2) {
      throw new Error(`only ${evidence.length} of ${wanted} evidence trials of ${incumbent.job} left a trajectory`)
    }
    const analysis = await this.analysis(round, evidence, incumbentEvaluation, signal)

    const history = await directory.readHistory(domain.componentSet)
    const budget = editBudget(round, settings.rounds, settings.minEdits, settings.maxEdits)
    const stalled = stallFlag(trajectory.map(entry => entry.score), round, settings.stallWindow, delta)
    const directive = exploration(stalled, history.tried(), Math.min(settings.reservedSlots, settings.variants), domain.componentSet)
    const prune = history.pruneSet(round, settings.pruneWindow)
    await directory.writeRoundRecord(round, 'directives.json', {
      budget,
      stalled,
      tried: [...history.tried()].sort(),
      exploration: directive,
      prune,
      delta,
      bestScore,
    })
    log(`round ${round}: incumbent ${incumbent.commit} score ${incumbent.score.toFixed(4)}, budget ${budget}, stalled ${stalled}, reserved ${directive.reservedSlots}`)

    const rendered = history.render(settings.historyLimit)
    const drafts: CandidateRecord[] = []
    for (let index = 0; index < settings.variants; index += 1) {
      drafts.push(await this.draft({
        round,
        variant: String.fromCharCode(65 + index),
        reserved: index >= settings.variants - directive.reservedSlots,
        budget,
        exploration: directive,
        prune,
        history: rendered,
        analysis,
        evidence,
        incumbent: incumbentEvaluation,
        signal,
      }))
    }
    const measured: Measured[] = []
    for (const draft of drafts) measured.push(await this.measureDraft(round, draft, tasks, signal))

    const { winner, judged } = selectRound(
      measured,
      incumbentEvaluation,
      bestScore,
      policy,
      history.incumbentComponentCounts(),
      domain.componentSet,
      (left, right) => domain.guards(left, right),
    )
    const decisions = judged.map(entry => entry.decision)
    await directory.writeRoundRecord(round, 'decisions.json', decisions)
    for (const { candidate, decision } of judged) {
      if (history.has(round, candidate.variant)) continue
      const outcome = candidate.gate ?? (candidate === winner ? 'accepted' : decision.admissible ? 'lost' : 'rejected')
      history.appendCandidate(round, candidate.variant, candidate.edits, outcome, decision)
      log(`r${round}${candidate.variant}: ${outcome}: ${decision.reason}`)
    }
    await directory.writeHistory(history)

    const next: Revision = winner?.revision === undefined
      ? { commit: incumbent.commit, job: incumbent.job, score: incumbent.score, cost: incumbent.cost }
      : {
        commit: winner.revision.commit,
        job: winner.revision.evaluation.job,
        score: winner.revision.evaluation.score,
        cost: winner.revision.evaluation.cost,
        variant: winner.variant,
      }
    await directory.writeTrajectory([...trajectory, next])
    await store.advance(next.commit, signal)
    for (const draft of drafts) await store.release(candidateName(round, draft.variant), signal)
    log(next.variant === undefined ? `round ${round}: no admissible candidate` : `round ${round}: accepted ${next.variant} at ${next.commit}`)
    return { round, winner: next.variant, incumbent: next, decisions }
  }

  private async draft(context: DraftContext): Promise<CandidateRecord> {
    const { domain, store, directory, log } = this.roles
    const { round, variant, signal } = context
    const stored = await directory.readCandidate(round, variant)
    if (stored !== undefined) {
      log(`r${round}${variant}: resuming the ${stored.status} candidate`)
      return stored
    }
    const name = candidateName(round, variant)
    const checkout = await store.create(name, undefined, signal)
    const gate = async (outcome: GateOutcome, detail: string, edits: readonly CandidateEdit[]): Promise<GatedCandidate> => {
      const record: GatedCandidate = { status: 'gated', variant, outcome, detail: detail.slice(0, RECORD_DETAIL), edits }
      await directory.writeCandidate(round, record)
      await store.release(name, signal)
      log(`r${round}${variant}: ${outcome}: ${record.detail}`)
      return record
    }
    const request: ProposalRequest = {
      round,
      rounds: this.settings.rounds,
      variant,
      variants: this.settings.variants,
      checkout,
      budget: context.budget,
      exploration: context.exploration,
      reserved: context.reserved,
      prune: context.prune,
      history: context.history,
      analysis: context.analysis,
      evidence: context.evidence,
      incumbent: context.incumbent,
      componentSet: domain.componentSet,
      briefs: domain.briefs,
      signal,
    }
    let proposal = await this.propose(request, 0)
    if (proposal.status !== 'done') return await gate('draft-failed', proposal.summary, proposal.edits)
    let diff = await this.recordDiff(checkout, round, variant, signal)
    let verdict = await this.screen(diff, proposal, context, 0)
    for (let attempt = 1; verdict.verdict === 'reject' && attempt <= this.settings.repairRounds; attempt += 1) {
      log(`r${round}${variant}: repair ${attempt}/${this.settings.repairRounds}: ${verdict.reasons.join('; ').slice(0, 200)}`)
      const repaired = await this.propose({
        ...request,
        repair: { reasons: verdict.reasons, riskNotes: verdict.riskNotes, declared: proposal.edits },
      }, attempt)
      if (repaired.status !== 'done') break
      proposal = repaired
      diff = await this.recordDiff(checkout, round, variant, signal)
      verdict = await this.screen(diff, proposal, context, attempt)
    }
    if (verdict.verdict === 'reject') return await gate('critic-rejected', verdict.reasons.join('; '), proposal.edits)
    const edits = proposal.edits.map(edit => ({ ...edit, component: normalizeComponent(edit.component, diff, domain.componentSet) }))
    const commit = await checkout.commit(`self-improve ${name}: ${oneLine(proposal.summary)}`, signal)
    const smoke = await domain.smoke({
      root: checkout.root,
      job: EvaluationJobId(`${name}-smoke-${commit.slice(0, 12)}`),
      tasks: domain.smokeTasks(context.incumbent),
      trials: 1,
      signal,
    })
    await directory.writeRoundRecord(round, join(variant, 'smoke.json'), smoke)
    if (!smoke.ok) return await gate('smoke-failed', smoke.detail, edits)
    const record: ReadyCandidate = { status: 'ready', variant, commit, branch: checkout.branch, summary: proposal.summary, edits }
    await directory.writeCandidate(round, record)
    log(`r${round}${variant}: ${edits.length} edit(s) on ${edits.map(edit => edit.component).join(', ')} at ${commit}`)
    return record
  }

  /** Draft once and keep the draft's model interaction beside the candidate's other records. */
  private async propose(request: ProposalRequest, attempt: number): Promise<Proposal> {
    const proposal = await this.roles.proposer.propose(request)
    if (proposal.transcript !== undefined) {
      await this.roles.directory.writeRoundRecord(request.round, join(request.variant, `proposal-${attempt}.txt`), proposal.transcript)
    }
    return proposal
  }

  /** The edit budget, the critic, and a reserved slot's obligation, in that order. */
  private async screen(diff: string, proposal: Proposal, context: DraftContext, attempt: number): Promise<CriticVerdict> {
    const verdict = await this.verdict(diff, proposal, context)
    await this.roles.directory.writeRoundRecord(context.round, join(context.variant, `critic-${attempt}.json`), verdict)
    return verdict
  }

  private async verdict(diff: string, proposal: Proposal, context: DraftContext): Promise<CriticVerdict> {
    const declared = proposal.edits
    if (declared.length === 0) return { verdict: 'reject', reasons: ['the candidate declares no edit'], riskNotes: [] }
    if (declared.length > context.budget) {
      return {
        verdict: 'reject',
        reasons: [`the candidate declares ${declared.length} edits; this round allows at most ${context.budget}`],
        riskNotes: [],
      }
    }
    const verdict = await this.roles.critic.review({
      diff,
      summary: proposal.summary,
      edits: declared,
      signal: context.signal,
    })
    if (verdict.verdict === 'reject' || !context.reserved) return verdict
    const componentSet = this.roles.domain.componentSet
    const untried = context.exploration.untried
    if (declared.some(edit => untried.includes(normalizeComponent(edit.component, diff, componentSet)))) return verdict
    return {
      verdict: 'reject',
      reasons: [`this candidate holds a slot reserved for components the run never changed (${untried.join(', ')}); judged by the diff, none of its edits changes one`],
      riskNotes: verdict.riskNotes,
    }
  }

  private async measureDraft(
    round: number,
    draft: CandidateRecord,
    tasks: readonly TaskId[],
    signal: AbortSignal | undefined,
  ): Promise<Measured> {
    const { variant, edits } = draft
    if (draft.status === 'gated') return { variant, edits, gateFailure: `${draft.outcome}: ${draft.detail}`, gate: draft.outcome }
    const name = candidateName(round, variant)
    const job = EvaluationJobId(name)
    const stored = await this.roles.directory.readEvaluation(job)
    if (stored !== undefined) {
      this.roles.log(`${name}: reusing the stored evaluation`)
      return { variant, edits, evaluation: stored, revision: { commit: draft.commit, evaluation: stored } }
    }
    const checkout = await this.roles.store.reopen(name, signal)
    const measurement = await this.measure(checkout.root, job, tasks, signal)
    if (!measurement.ok) {
      this.roles.log(`${name}: evaluation-invalid: ${measurement.detail}`)
      return { variant, edits, gateFailure: `evaluation-invalid: ${measurement.detail}`, gate: 'evaluation-invalid' }
    }
    const evaluation = measurement.evaluation
    await this.roles.directory.writeEvaluation(evaluation)
    return { variant, edits, evaluation, revision: { commit: draft.commit, evaluation } }
  }

  /** Measure once, and once more when too many trials produced no result; a failed evaluation is contained as invalid. */
  private async measure(
    root: string,
    job: EvaluationJobId,
    tasks: readonly TaskId[],
    signal: AbortSignal | undefined,
  ): Promise<Measurement> {
    let missing = ''
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let evaluation: EvaluationResult
      try {
        evaluation = await this.roles.domain.evaluate({
          root,
          job,
          tasks,
          trials: this.settings.trials,
          signal,
        })
      } catch (error) {
        signal?.throwIfAborted()
        return { ok: false, detail: `the evaluation failed: ${error instanceof Error ? error.message : String(error)}` }
      }
      if (!this.invalid(evaluation)) return { ok: true, evaluation }
      missing = `${evaluation.missing}/${evaluation.expectedTrials} trials produced no result`
      this.roles.log(`${job}: ${missing}${attempt === 0 ? '; measuring the missing trials again' : ''}`)
    }
    return { ok: false, detail: `${missing} after one retry` }
  }

  /**
   * Measure a revision in a fresh checkout that is released afterwards; failures propagate. The job is named
   * after the checkout's commit, so stored trials of an interrupted measurement are reused only for that commit.
   */
  private async measureFresh(
    name: string,
    job: (commit: string) => EvaluationJobId,
    tasks: readonly TaskId[],
    from: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<{ readonly base: string; readonly evaluation: EvaluationResult }> {
    const { domain, store, directory } = this.roles
    const checkout = await store.create(name, from, signal)
    try {
      const evaluation = await domain.evaluate({
        root: checkout.root,
        job: job(checkout.base),
        tasks,
        trials: this.settings.trials,
        signal,
      })
      if (this.invalid(evaluation)) {
        throw new Error(`self-improve ${name} is invalid: ${evaluation.missing}/${evaluation.expectedTrials} trials produced no result`)
      }
      await directory.writeEvaluation(evaluation)
      return { base: checkout.base, evaluation }
    } finally {
      await store.release(name, signal)
    }
  }

  private invalid(evaluation: EvaluationResult): boolean {
    return evaluation.missing > this.settings.maxMissingFraction * evaluation.expectedTrials
  }

  private async analysis(
    round: number,
    evidence: readonly RenderedTrace[],
    incumbent: EvaluationResult,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    const { directory, analyst, domain } = this.roles
    const stored = await directory.readRoundText(round, 'analysis.md')
    if (stored !== undefined) return stored
    const previous = round === 0 ? '' : await directory.readRoundText(round - 1, 'analysis.md') ?? ''
    const report = await analyst.analyze({
      round,
      evidence,
      incumbent,
      briefs: domain.briefs,
      previous,
      signal,
    })
    await directory.writeRoundRecord(round, 'analysis.md', report)
    return report
  }

  private async recordDiff(checkout: CandidateCheckout, round: number, variant: string, signal: AbortSignal | undefined): Promise<string> {
    const diff = await checkout.diff(signal)
    await this.roles.directory.writeRoundRecord(round, join(variant, 'diff.patch'), diff)
    return diff
  }

  private async noiseBand(): Promise<number> {
    if (this.settings.delta !== undefined) return this.settings.delta
    const calibration = await this.roles.directory.readCalibration()
    if (calibration === undefined) throw new Error('self-improve has no noise band: configure delta or calibrate the baseline')
    return calibration.delta
  }

  private async requireTrajectory(): Promise<Trajectory> {
    const trajectory = await this.roles.directory.readTrajectory()
    if (trajectory === undefined) throw new Error(`self-improve run ${this.roles.directory.root} has no baseline; measure the baseline first`)
    return trajectory
  }

  private async requireEvaluation(job: EvaluationJobId): Promise<EvaluationResult> {
    const evaluation = await this.roles.directory.readEvaluation(job)
    if (evaluation === undefined) throw new Error(`self-improve run ${this.roles.directory.root} has no stored evaluation ${job}`)
    return evaluation
  }
}

/**
 * The checkout, branch suffix, and evaluation job of one candidate.
 * @param round - the round.
 * @param variant - the candidate's label.
 * @returns `r<round><variant>`, such as `r3A`.
 */
export function candidateName(round: number, variant: string): string {
  return `r${round}${variant}`
}

/** The newest incumbent of a trajectory. */
function latest(trajectory: Trajectory): Revision {
  return trajectory.reduce((_previous, entry) => entry)
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 200)
}
