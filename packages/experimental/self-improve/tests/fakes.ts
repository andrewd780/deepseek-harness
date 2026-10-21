import { EvaluationJobId, TaskId } from '../src/brand.ts'
import type { EvaluationResult } from '../src/evaluate.ts'
import type { CandidateEdit } from '../src/selection.ts'
import type {
  Analyst,
  AnalysisRequest,
  CandidateCheckout,
  Critic,
  CriticRequest,
  CriticVerdict,
  EvaluationRequest,
  Proposal,
  ProposalRequest,
  Proposer,
  RevisionStore,
  SelfImproveDomain,
  SmokeResult,
} from '../src/types.ts'
import { evaluation, componentSet } from './fixtures.ts'

/** Commits are strings; each candidate commit's parent is its checkout's base. */
export class FakeStore implements RevisionStore {
  tipCommit = 'c0'
  readonly parents = new Map<string, string>()
  readonly branches = new Map<string, string>()
  readonly checkouts = new Map<string, CandidateCheckout>()
  readonly pending = new Map<string, string>()
  readonly released: string[] = []
  private serial = 0

  async tip(): Promise<string> {
    return this.tipCommit
  }

  async advance(commit: string): Promise<void> {
    for (let cursor: string | undefined = commit; cursor !== undefined; cursor = this.parents.get(cursor)) {
      if (cursor === this.tipCommit) {
        this.tipCommit = commit
        return
      }
    }
    throw new Error(`evolve branch tip ${this.tipCommit} is not an ancestor of ${commit}`)
  }

  async create(name: string, from?: string): Promise<CandidateCheckout> {
    this.pending.delete(name)
    return this.open(name, from ?? this.tipCommit)
  }

  async reopen(name: string): Promise<CandidateCheckout> {
    const existing = this.checkouts.get(name)
    if (existing !== undefined) return existing
    const commit = this.branches.get(name)
    if (commit === undefined) throw new Error(`no branch ${name}`)
    return this.open(name, commit)
  }

  async release(name: string): Promise<void> {
    this.checkouts.delete(name)
    this.released.push(name)
  }

  /** The edit a proposer makes in a checkout's evolved directory. */
  edit(name: string, diff: string): void {
    this.pending.set(name, diff)
  }

  private open(name: string, base: string): CandidateCheckout {
    const checkout: CandidateCheckout = {
      name,
      branch: `self-improve/${name}`,
      base,
      root: `/runs/${name}`,
      evolvedDirectory: `/runs/${name}/evolved`,
      diff: async () => this.pending.get(name) ?? '',
      commit: async () => {
        this.serial += 1
        const commit = `c${name}-${this.serial}`
        this.parents.set(commit, base)
        this.branches.set(name, commit)
        return commit
      },
    }
    this.checkouts.set(name, checkout)
    return checkout
  }
}

/** A domain whose evaluations come from a table keyed by job, and by checkout root as a fallback. */
export class FakeDomain implements SelfImproveDomain {
  readonly componentSet = componentSet
  readonly briefs = { analyst: 'analyst brief', proposer: 'proposer brief', critic: 'critic brief' }
  readonly evaluations: EvaluationRequest[] = []
  readonly smokes: EvaluationRequest[] = []
  readonly rewards = new Map<string, Readonly<Record<string, readonly number[]>>>()
  readonly tokens = new Map<string, number>()
  readonly missing = new Map<string, number[]>()
  readonly failures = new Map<string, unknown>()
  smokeResult: (request: EvaluationRequest) => SmokeResult = () => ({ ok: true, detail: 'ran' })
  /** Objections per screening, consumed in order; screenings past the queue raise none. */
  readonly objections: (readonly string[])[] = []
  readonly screened: string[] = []
  guardResult: (incumbent: EvaluationResult, candidate: EvaluationResult) => readonly string[] = () => []
  traces = true

  evolveTasks(): readonly TaskId[] {
    return [TaskId('a'), TaskId('b')]
  }

  heldoutTasks(): readonly TaskId[] {
    return [TaskId('h')]
  }

  smokeTasks(): readonly TaskId[] {
    return [TaskId('a')]
  }

  async evaluate(request: EvaluationRequest): Promise<EvaluationResult> {
    this.evaluations.push(request)
    const failure = this.failures.get(request.job)
    if (failure !== undefined) throw failure
    const rewards = this.rewards.get(request.job) ?? this.rewards.get(request.root) ?? { a: [0, 0], b: [0, 0] }
    const tokens = this.tokens.get(request.job) ?? 100
    const perTaskTokens = Object.fromEntries(Object.entries(rewards).map(([task, values]) => [task, values.map(() => tokens)]))
    const result = evaluation(request.job, rewards, perTaskTokens)
    const missing = this.missing.get(request.job)?.shift() ?? 0
    return { ...result, missing }
  }

  async smoke(request: EvaluationRequest): Promise<SmokeResult> {
    this.smokes.push(request)
    return this.smokeResult(request)
  }

  async screen(root: string): Promise<readonly string[]> {
    this.screened.push(root)
    return this.objections.shift() ?? []
  }

  guards(incumbent: EvaluationResult, candidate: EvaluationResult): readonly string[] {
    return this.guardResult(incumbent, candidate)
  }

  async renderTrace(job: string, task: string, trial: number): Promise<string | undefined> {
    return this.traces ? `${job}/${task}/${trial}` : undefined
  }
}

/** One scripted proposer answer: the diff it leaves in the checkout and the proposal it returns. */
export interface ScriptedDraft {
  readonly diff?: string
  readonly status?: Proposal['status']
  readonly summary?: string
  readonly edits?: readonly CandidateEdit[]
}

export const edit = (component = 'prompt', id = 'C1'): CandidateEdit => ({ id, component, hypothesis: `change ${component}` })

/** Answers each variant's drafts in order; an unscripted call drafts one prompt edit. */
export class ScriptedProposer implements Proposer {
  readonly requests: ProposalRequest[] = []
  readonly script = new Map<string, ScriptedDraft[]>()

  constructor(private readonly store: FakeStore) {}

  async propose(request: ProposalRequest): Promise<Proposal> {
    this.requests.push(request)
    const draft = this.script.get(request.checkout.name)?.shift() ?? {}
    this.store.edit(request.checkout.name, draft.diff ?? `+++ b/AGENTS.md\n+${request.checkout.name}`)
    return { status: draft.status ?? 'done', summary: draft.summary ?? `draft ${request.checkout.name}`, edits: draft.edits ?? [edit()] }
  }
}

/** Accepts unless a verdict is scripted for the candidate's summary. */
export class ScriptedCritic implements Critic {
  readonly requests: CriticRequest[] = []
  readonly script = new Map<string, CriticVerdict[]>()

  async review(request: CriticRequest): Promise<CriticVerdict> {
    this.requests.push(request)
    return this.script.get(request.summary)?.shift() ?? { verdict: 'accept', reasons: [], riskNotes: ['none'] }
  }
}

export class ScriptedAnalyst implements Analyst {
  readonly requests: AnalysisRequest[] = []

  async analyze(request: AnalysisRequest): Promise<string> {
    this.requests.push(request)
    return `report ${request.round}`
  }
}

export const job = (id: string): EvaluationJobId => EvaluationJobId(id)
