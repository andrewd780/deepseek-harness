/**
 * Basic replay-aware compaction backend.
 *
 * @module @deepseek-ai/dsh-compaction-basic
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { CompactionEngine, ManualCompactionError } from '@deepseek-ai/dsh-compaction'
import type { CompactionResult, CompactionTrigger } from '@deepseek-ai/dsh-compaction'
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session'
import { CONTEXT_WINDOW_EXCEEDED_CODE, errorChain, isHarnessError } from '@deepseek-ai/dsh-llm'
import type { LlmCallConfig, LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
// Type-only: makes the optional sibling service available to `ctx.get()`.
import type {} from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import {
  resolveCompactSpec,
  resolveConfig,
  resolveSummaryCap,
  resolveTargetPolicy,
  TargetPressureConfigError,
} from './config.ts'
import {
  assertNoActiveCompaction,
  compactSurfaceRegion,
  selectBoundedPrefix,
  selectCompactableRange,
} from './region.ts'
import type { CompactionTransactionOptions } from './region.ts'
import { SUMMARY_TRUNCATED_CODE, summarizeWithLlm } from './summarizer.ts'
import type { SummarizationInput, SummaryResult } from './summarizer.ts'
import type {
  BasicCompactionConfig,
  ModelCompactPolicyConfig,
  ResolvedConfig,
  ResolvedTargetPolicy,
} from './types.ts'

export type {
  BasicCompactionConfig,
  CompactionPolicyConfig,
  ModelCompactPolicyConfig,
  ResolvedCompactSpec,
  ResolvedConfig,
  ResolvedRetention,
  ResolvedTargetPolicy,
} from './types.ts'

/** Resolve the exact provider/model durably routed for the latest request. */
function routedTarget(
  session: Session,
): Pick<LlmCallConfig, 'provider' | 'model'> | undefined {
  const config = session.requestHeader()?.config
  if (config === undefined || config.provider.length === 0 || config.model.length === 0) {
    return undefined
  }
  return { provider: config.provider, model: config.model }
}

/**
 * Output tokens the routed request reserves, which the provider charges to the
 * same window as the prompt. The effective envelope's own cap wins; otherwise
 * the adapter's per-request default, which the adapter materializes when that
 * envelope omits one. No declared cap means no reservation.
 */
function reservedCompletionTokens(agent: Agent, defaultMaxTokens: number | undefined): number {
  const configured = agent.session.requestHeader()?.config.maxTokens
  return configured ?? defaultMaxTokens ?? 0
}

/** Resolve the conversation target used to select an optional policy override. */
function conversationTarget(
  agent: Agent,
): Pick<LlmCallConfig, 'provider' | 'model'> | undefined {
  const routed = routedTarget(agent.session)
  if (routed !== undefined) return routed
  if (agent.options.provider === undefined || agent.options.provider.length === 0
    || agent.options.model === undefined || agent.options.model.length === 0) return undefined
  return { provider: agent.options.provider, model: agent.options.model }
}

/** Span budget and generation cap for the next summary request of a fold. */
interface SummaryBound {
  readonly spanTokens: number
  readonly maxTokens: number
}

/**
 * Why a summary request did not fit: the provider rejected it as exceeding the
 * context window, or its output stopped at the generation cap or the end of the
 * provider's window.
 */
type SummaryRejection = 'window' | 'truncated'

/**
 * Classify a failed compaction transaction whose summary did not fit.
 * @param error - failure thrown by one compaction transaction.
 * @returns the rejection kind, or `undefined` for every other failure.
 */
function summaryRejection(error: unknown): SummaryRejection | undefined {
  const cause = error instanceof ManualCompactionError
    ? error.code === 'summary' ? error.cause : undefined
    : error
  if (!isHarnessError(cause)) return undefined
  switch (cause.code) {
    case CONTEXT_WINDOW_EXCEEDED_CODE:
      return 'window'
    case SUMMARY_TRUNCATED_CODE:
      return 'truncated'
    // Every other code is a summary failure that a smaller request cannot repair.
    default:
      return undefined
  }
}

/**
 * Bound the next summary request after one over a span of `rejectedSpanTokens`
 * did not fit. A window rejection whose cap exceeds the span's price lowers the
 * cap to that price first, because a summary at least as large as its span is
 * rejected anyway; every other rejection halves the span budget. A window
 * rejection keeps the cap at or below the span budget, while a truncated
 * summary keeps its cap so the smaller span has room to finish.
 * @param bound - bound of the request that did not fit.
 * @param rejection - why it did not fit.
 * @param rejectedSpanTokens - route-priced tokens of its span.
 * @returns the strictly smaller bound for the next request.
 */
function nextSummaryBound(
  bound: SummaryBound,
  rejection: SummaryRejection,
  rejectedSpanTokens: number,
): SummaryBound {
  if (rejection === 'window' && bound.maxTokens > rejectedSpanTokens) {
    return { spanTokens: rejectedSpanTokens, maxTokens: Math.max(1, rejectedSpanTokens) }
  }
  const spanTokens = Math.floor(rejectedSpanTokens / 2)
  return {
    spanTokens,
    maxTokens: rejection === 'window' ? Math.max(1, Math.min(bound.maxTokens, spanTokens)) : bound.maxTokens,
  }
}

/** Whether a manual transaction closed at the summary stage without a replacement. */
function isManualSummaryStageFailure(error: unknown): boolean {
  return error instanceof ManualCompactionError && (error.code === 'summary' || error.code === 'changed')
}

const thresholdRatioSchema = z.number()
const headroomTokensSchema = z.number().step(1).min(0)
const retainRatioSchema = z.number()
const retainTokensSchema = z.number().step(1).min(0)
const summarizationProviderSchema = z.string()
const summarizationModelSchema = z.string()
const maxTokensSchema = z.number().step(1).min(1)
const compactionRetriesSchema = z.number().step(1).min(0)
const maxOverflowRetriesSchema = z.number().step(1).min(0)

const modelPolicy: z<ModelCompactPolicyConfig> = z.object({
  provider: z.string().required(),
  model: z.string().required(),
  thresholdRatio: thresholdRatioSchema,
  headroomTokens: headroomTokensSchema,
  retainRatio: retainRatioSchema,
  retainTokens: retainTokensSchema,
  summarizationProvider: summarizationProviderSchema,
  summarizationModel: summarizationModelSchema,
  maxTokens: maxTokensSchema,
  compactionRetries: compactionRetriesSchema,
  maxOverflowRetries: maxOverflowRetriesSchema,
})

/**
 * Dependency-light compaction backend using `ctx.tokenMeter` for pressure,
 * retention, cited source events, and summary-convergence pricing.
 *
 * `summarize()` is the sole subclass customization hook; the replay and durable
 * mutation strategy stays fixed so every pricing decision uses the singleton
 * token meter.
 */
export class BasicCompactionEngine extends CompactionEngine {
  static inject = ['llm', 'tokenMeter', 'sessions']

  static Config: z<BasicCompactionConfig> = z.object({
    thresholdRatio: thresholdRatioSchema,
    headroomTokens: headroomTokensSchema,
    retainRatio: retainRatioSchema,
    retainTokens: retainTokensSchema,
    summarizationProvider: summarizationProviderSchema,
    summarizationModel: summarizationModelSchema,
    maxTokens: maxTokensSchema,
    compactionRetries: compactionRetriesSchema,
    maxOverflowRetries: maxOverflowRetriesSchema,
    modelPolicies: z.array(modelPolicy),
    auto: z.boolean(),
  })

  /** Resolved and validated compaction configuration. */
  readonly config: ResolvedConfig

  private readonly warnedPressureConfigTargets = new Set<string>()
  private readonly overflowRetries = new WeakMap<Agent, number>()
  private readonly overflowAgents = new WeakMap<Session, Agent>()

  constructor(ctx: Context, config: BasicCompactionConfig = {}) {
    super(ctx)
    this.config = resolveConfig(config)
    if (this.config.auto) this._registerAutomaticCompaction()
  }

  /**
   * Register automatic between-step pressure and model-request overflow
   * recovery. `compactIfNeeded` stays dynamically dispatched so subclass
   * overrides are honored at event time.
   */
  private _registerAutomaticCompaction(): void {
    const { ctx } = this
    const logResult = (result: CompactionResult, trigger: string): void => {
      ctx.logger.info(
        `compaction (${trigger}): shadowed ${result.shadowedSeqs.length} surface nodes `
        + `(seqs ${result.shadowedRange.start}-${result.shadowedRange.end}, `
        + `~${result.shadowedTokenCount} tokens)`,
      )
    }

    ctx.on('agent/pre-step', async (
      { agent, signal },
      next,
    ): Promise<PreStepDecision> => {
      if (!signal.aborted) {
        try {
          const result = await this.compactIfNeeded(agent, 'pressure', signal)
          if (result !== null) logResult(result, 'step pressure')
        } catch (error: unknown) {
          if (error instanceof TargetPressureConfigError) {
            if (this.warnedPressureConfigTargets.has(error.targetKey)) return next()
            this.warnedPressureConfigTargets.add(error.targetKey)
          }
          const message = error instanceof Error ? error.message : String(error)
          ctx.logger.warn(`step compaction failed: ${message}; continuing the turn`)
        }
      }
      return next()
    })

    ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle') this.overflowRetries.delete(agent)
    })

    // A successful response starts a fresh overflow-recovery sequence even
    // when tool calls continue the same turn into another request.
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'assistant/message') return
      const agent = this.overflowAgents.get(session)
      if (agent !== undefined) this.overflowRetries.delete(agent)
    })

    ctx.on('agent/request-error', async (
      { agent, failure, signal },
      next,
    ) => {
      if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE || signal.aborted) return next()
      this.overflowAgents.set(agent.session, agent)
      const target = routedTarget(agent.session)
      if (target === undefined) return next()
      const policy = resolveTargetPolicy(this.config, target)
      const retries = this.overflowRetries.get(agent) ?? 0
      if (retries >= policy.maxOverflowRetries) return next()

      const generation = agent.session.surface.replaceGeneration
      let result: CompactionResult | null
      try {
        result = await this.compactIfNeeded(agent, 'context-overflow', signal)
      } catch (recoveryError: unknown) {
        const message = recoveryError instanceof Error ? recoveryError.message : String(recoveryError)
        // A model-free prune can land before later summary work fails. That
        // durable reduction is sufficient retry proof; do not discard it just
        // because the optional second phase threw. Cancellation still wins.
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- the signal can abort while recovery is awaited.
        if (!signal.aborted && agent.session.surface.replaceGeneration > generation) {
          ctx.logger.warn(
            `context-overflow compaction failed after durable surface progress: ${message}; `
            + 'retrying from the replacement surface',
          )
          this.overflowRetries.set(agent, retries + 1)
          return { kind: 'retry' }
        }
        ctx.logger.warn(
          // oxlint-disable-next-line typescript/no-unnecessary-condition -- the signal can abort while recovery is awaited.
          `context-overflow compaction failed: ${message}; ${signal.aborted
            ? 'cancellation prevents retry'
            : 'preserving the original request error'}`,
        )
        return next()
      }
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- the signal can abort while compaction is awaited.
      if (signal.aborted
        || agent.session.surface.replaceGeneration <= generation) return next()
      if (result !== null) logResult(result, 'context overflow recovery')
      this.overflowRetries.set(agent, retries + 1)
      return { kind: 'retry' }
    })
  }

  /**
   * Summarize the replayed conversation region through a direct one-shot
   * `ctx.llm.stream()` call whose prefix reuses the conversation's own system
   * prompt, tools, and messages so the provider's KV cache is not invalidated.
   * Override this sole hook for a template or remote summarizer.
   * @param input - replayed conversation prefix (system, tools, and leading messages) to condense.
   * @param agent - supplies routed-model history, fallback model, and session id.
   * @param signal - optional cancellation forwarded to the adapter.
   * @returns safe text summary blocks and the exact auxiliary call envelope and output.
   */
  protected async summarize(
    input: SummarizationInput,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<SummaryResult> {
    return summarizeWithLlm(this.ctx, this.summaryPolicy(agent), input, agent, signal)
  }

  /**
   * Compact for replayed step-boundary pressure or one provider-confirmed context
   * overflow. Both triggers price the latest durable routed request envelope;
   * overflow bypasses the normal threshold and retained-tail policy so it can
   * force one useful balanced reduction.
   * @param agent - agent whose latest durable routed request is measured.
   * @param trigger - normal step-boundary pressure or context-overflow recovery.
   * @param signal - live turn cancellation signal forwarded to summarization.
   * @returns the latest summary compaction result, or `null` when no summary ran.
   */
  override async compactIfNeeded(
    agent: Agent,
    trigger: CompactionTrigger,
    signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    const target = routedTarget(agent.session)
    if (target === undefined) return null
    const policy = resolveTargetPolicy(this.config, target)
    const meter = this.ctx.tokenMeter
    let measurement = meter.measure(agent.session)
    switch (trigger) {
      case 'context-overflow':
        break
      case 'pressure':
        break
      /* v8 ignore next -- closed-union exhaustiveness guard */
      default:
        assertNever(trigger, 'compaction trigger')
    }

    // Pruning is optional so compaction-basic remains independently composable.
    // Overflow always qualifies; pressure first resolves the routed model's
    // capacity and checks its target-specific threshold.
    const prune = this.ctx.get('toolResultPruner')

    if (trigger === 'context-overflow') {
      prune?.pruneSession(agent.session)
      return this.compactWithinProviderWindow(
        agent,
        { owner: 'current-turn', stability: 'whole-surface' },
        signal,
      )
    }

    const info = await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal)
    assertNoActiveCompaction(agent.session, 'automatic pressure compaction')
    const targetKey = `${target.provider}/${target.model}`
    if (info.context === undefined) {
      throw new TargetPressureConfigError(
        targetKey,
        `compaction-basic: no context capacity for ${targetKey}; `
        + 'configure contextWindow on that adapter model',
      )
    }
    const spec = resolveCompactSpec(
      policy,
      info.context.contextWindow,
      reservedCompletionTokens(agent, info.defaultMaxTokens),
    )
    if (measurement.totalTokens < spec.thresholdTokens) return null

    // Once pressure qualifies, land the model-free pass before choosing a
    // summary range, then remeasure through the singleton replay fold.
    if (prune !== undefined) {
      prune.pruneSession(agent.session)
      measurement = meter.measure(agent.session)
    }
    if (measurement.totalTokens < spec.thresholdTokens) return null

    let result: CompactionResult | null = null
    for (let attempt = 0; attempt <= spec.compactionRetries; attempt += 1) {
      const range = selectCompactableRange(agent.session, measurement, spec.retainTokens)
      if (range === null) {
        /* v8 ignore else -- concrete replacement preserves a compactable checkpoint; subclass hooks cannot mutate it. */
        if (result === null) return null
        /* v8 ignore next -- paired with the defensive post-success branch above. */
        break
      }
      result = await this.compactRegion(range.start, range.end, agent, signal)
      measurement = meter.measure(agent.session)
      if (measurement.totalTokens < spec.thresholdTokens) return result
    }

    throw new Error(
      `compaction still above threshold after ${spec.compactionRetries + 1} compaction attempts `
      + `(${measurement.totalTokens} estimated tokens >= threshold ${spec.thresholdTokens})`,
    )
  }

  /**
   * Compact one inclusive positional range from the agent-owned surface using
   * the effective token meter for all retention and shrink pricing.
   * @param start - inclusive first surface-node seq.
   * @param end - inclusive last surface-node seq.
   * @param agent - owner of the target session, used by the summarizer.
   * @param signal - optional summarization cancellation signal.
   * @returns the successful durable compaction result.
   */
  override async compactRegion(
    start: SessionSeq,
    end: SessionSeq,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<CompactionResult> {
    return compactSurfaceRegion(
      this.regionDependencies(),
      agent.session,
      start,
      end,
      agent,
      { owner: 'current-turn', stability: 'whole-surface', maxTokens: await this.summaryCap(agent, signal) },
      signal,
    )
  }

  /**
   * Force one useful idle-session compaction below the pressure threshold, and
   * resolve only after its standalone marker pair is durably checkpointed.
   * @param agent - idle agent whose next-turn admission this call reserves.
   * @param signal - cancellation scoped to this compaction request.
   * @param sourceCommandId - initiating command identity for presentation correlation.
   * @returns the committed result, or `null` when no safe useful range exists.
   */
  override compactNow(
    agent: Agent,
    signal: AbortSignal,
    sourceCommandId?: CommandId,
  ): Promise<CompactionResult | null> {
    signal.throwIfAborted()
    try {
      return agent.runMaintenance(async (agentSignal) => {
        const operationSignal = AbortSignal.any([agentSignal, signal])
        try {
          operationSignal.throwIfAborted()
          return await this.compactWithinProviderWindow(
            agent,
            {
              owner: null,
              stability: 'selected-span',
              ...sourceCommandId === undefined ? {} : { sourceCommandId },
              flush: async () => {
                await this.ctx.sessions.flush(agent.session)
              },
            },
            operationSignal,
          )
        } catch (error: unknown) {
          if (agentSignal.aborted && operationSignal.reason === agentSignal.reason) {
            throw new ManualCompactionError(
              'cancelled',
              'manual compaction was cancelled',
              { cause: error },
            )
          }
          operationSignal.throwIfAborted()
          throw error
        }
      })
    } catch (error: unknown) {
      throw new ManualCompactionError(
        'busy',
        'manual compaction requires an idle agent with no waking queued work',
        { cause: error },
      )
    }
  }

  /**
   * Compact the whole compactable range for overflow recovery or a manual
   * request. The first transaction summarizes the range in one request under
   * the policy's generation cap. When a summary does not fit the provider's
   * window, the bound for the next request shrinks, and later transactions
   * fold oldest-first balanced prefixes within that bound into the running
   * checkpoint until the range is consumed. Every request is smaller than the
   * one that did not fit, so the fold ends once no admissible prefix fits.
   * @param agent - agent whose session surface is compacted.
   * @param options - transaction ownership, stability, and durability; the fold chooses each cap.
   * @param signal - cancellation forwarded to every transaction.
   * @returns the last committed result, or `null` when no compactable range exists.
   * After a committed fold, a later manual summary-stage failure or a bound that
   * admits no prefix returns the committed progress instead of throwing.
   * @throws the latest summary rejection when no admissible prefix fits before
   * any transaction commits, or any other transaction failure.
   */
  private async compactWithinProviderWindow(
    agent: Agent,
    options: Omit<CompactionTransactionOptions, 'maxTokens'>,
    signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    const dependencies = this.regionDependencies()
    let bound: SummaryBound = {
      spanTokens: Number.POSITIVE_INFINITY,
      maxTokens: await this.summaryCap(agent, signal),
    }
    let foldCheckpoint: SessionSeq | undefined
    let result: CompactionResult | null = null
    let rejection: unknown
    for (;;) {
      signal.throwIfAborted()
      const measurement = this.ctx.tokenMeter.measure(agent.session)
      const range = selectCompactableRange(agent.session, measurement, 0)
      if (range === null) return result
      const span = selectBoundedPrefix(agent.session, measurement, range, bound.spanTokens, foldCheckpoint)
      if (span === null) {
        if (result !== null) return result
        throw rejection
      }
      try {
        result = await compactSurfaceRegion(
          dependencies,
          agent.session,
          span.start,
          span.end,
          agent,
          { ...options, maxTokens: bound.maxTokens },
          signal,
        )
      } catch (error: unknown) {
        if (signal.aborted) throw error
        const kind = summaryRejection(error)
        if (kind === undefined) {
          if (result !== null && isManualSummaryStageFailure(error)) return result
          throw error
        }
        rejection = error
        bound = nextSummaryBound(bound, kind, span.tokens)
        continue
      }
      if (span.end === range.end) return result
      foldCheckpoint = agent.session.surface.nodes[span.position]
    }
  }

  /** Resolve the exact-target policy for the agent's conversation, or the defaults without one. */
  private summaryPolicy(agent: Agent): ResolvedConfig | ResolvedTargetPolicy {
    const target = conversationTarget(agent)
    return target === undefined ? this.config : resolveTargetPolicy(this.config, target)
  }

  /**
   * Generation cap for the next summary of the agent's conversation: the
   * configured cap, or the headroom derived from the routed model's window
   * and output reservation. A window lookup that fails is treated as an
   * unknown window; a summary that then does not fit is shrunk by the caller.
   * @param agent - agent whose conversation target and request envelope size the cap.
   * @param signal - cancellation forwarded to the model-info lookup.
   * @returns positive summary generation cap.
   */
  private async summaryCap(agent: Agent, signal?: AbortSignal): Promise<number> {
    const target = conversationTarget(agent)
    const policy = this.summaryPolicy(agent)
    if (target === undefined || policy.maxTokens !== undefined) return resolveSummaryCap(policy, undefined)
    let info: LlmResolvedModelInfo
    try {
      info = await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal)
    } catch (error: unknown) {
      if (signal?.aborted) throw error
      this.ctx.logger.warn(
        `compaction: no context window for ${target.provider}/${target.model} (${errorChain(error)}); `
        + 'sizing the summary cap as for an unknown window',
      )
      return resolveSummaryCap(policy, undefined)
    }
    return resolveSummaryCap(
      policy,
      info.context === undefined
        ? undefined
        : info.context.contextWindow - reservedCompletionTokens(agent, info.defaultMaxTokens),
    )
  }

  /** Bind the effective token meter and dynamically dispatched summarizer hook. */
  private regionDependencies(): Parameters<typeof compactSurfaceRegion>[0] {
    return {
      meter: this.ctx.tokenMeter,
      summarize: (input, owner, abort) => this.summarize(input, owner, abort),
      recover: (error, agent, sourceEventSeqs, signal) => this.ctx.waterfall('compaction/summary-error', {
        session: agent.session,
        sourceEventSeqs,
        error,
        ...signal === undefined ? {} : { signal },
      }, () => false),
    }
  }
}

export default BasicCompactionEngine
