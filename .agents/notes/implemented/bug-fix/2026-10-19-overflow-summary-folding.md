# Agent Note: Overflow recovery folds a summary the provider rejects

Status: implemented

English | [中文](2026-10-19-overflow-summary-folding.zh.md)

## Problem

On a custom endpoint, a context-overflow error ended the turn, and neither a retry nor `/compact` recovered the session. Overflow recovery and `compactNow()` summarized everything except the newest surface node in one request: the system head, the whole selected span, and the compaction instruction, reserving the policy's `maxTokens` (65,536 by default) for output. After a real overflow that request is about as large as the rejected one, and larger when the newest node is shorter than the instruction or when the server counts requested output against the window, so the provider rejected it for the same reason. No `compaction/summary-error` listener repairs a text overflow, so the attempt closed with an error and the original failure ended the turn. The built-in DeepSeek route recovered only because its conversation requests reserve 256,000 output tokens, which leaves room for a 65,536-token summary reservation. A pi-ai custom route with a blank context window believes 262,144 tokens and reserves 32,768, so its recovery could not succeed on a smaller real window.

## Decision

`dsh-compaction-basic` folds the compactable range for overflow recovery and `compactNow()`. The first transaction is the single request used before: the whole compactable range under the policy cap. When a summary request is rejected as `CONTEXT_WINDOW_EXCEEDED` or truncated at its cap, the next request is smaller. A window rejection whose cap exceeds the rejected span's route price lowers the cap to that price; otherwise the span budget halves and the cap stays at or below it. A truncated summary halves the span budget and keeps its cap. Later transactions summarize the longest balanced oldest-first prefix within the budget that adds history beyond the fold's own checkpoint, until the range is consumed or no prefix fits.

Each transaction is the ordinary logged bracket, so no event type, wire field, or Session format changes, and every model request stays reconstructable from the log. The generation cap travels in `SummarizationInput.maxTokens` and is recorded on `compaction/summary`. Once a fold has committed, a bound that admits no prefix, or a manual `summary` or `changed` failure, returns the committed progress; other failures propagate unchanged. Pressure compaction and `compactRegion()` keep one request under the policy cap, and a first attempt that fits sends the same request as before, so the DeepSeek route and existing recorded sessions are unchanged. The [package README](../../../../packages/compaction/compaction-basic/README.md) owns the operational rule.

## Alternatives considered

**Parse the window the provider states and size one request to fit.** Deferred: OpenAI-compatible, vLLM, llama.cpp, and Anthropic-style errors often state the limit, but the wording differs per server and several servers state none, and the meter's four-characters-per-token estimate differs from the server's tokenizer by several percent. Halving on the canonical code works for every classified provider; a stated limit can later shorten the search without replacing it.

**Summarize chunks independently and keep every partial summary.** Rejected for now: it avoids re-summarizing a checkpoint but leaves several summaries on the surface and changes how a resumed model sees its history. The fold reuses the instruction's existing rule for merging a prior `<compacted-summary>` block.

**Drop the oldest history when the summary does not fit.** Rejected: discarding history without a summary defeats the checkpoint; the fold keeps a summary of everything it replaces.

**Lower the first attempt's cap to the span's price.** Rejected: it would change the DeepSeek route's recorded summaries and could truncate a reasoning model's summary of a short span that fits today.

**Retry the conversation with less reserved output.** Out of scope: the conversation request's output reservation belongs to the adapter and the agent request policy, not to compaction.

## Consequences

A session whose configured window is larger than the window its endpoint enforces stays usable after an overflow, and `/compact` can shrink it. The cost is one rejected request per shrink step and one summary call per fold, and each fold after the first rewrites the previous checkpoint, so detail can drift across folds. The declared window is not corrected: pressure policy still prices against the adapter's `contextWindow`, so later overflows again fall to recovery folding, which keeps no recent history verbatim. A window rejection can lower the cap below what a reasoning model needs for a small span; a truncated summary then halves the span. An overflow caused by the conversation's own output reservation, or by a newest node, system prompt, or tool set that alone exceeds the window, remains outside compaction.

## Testing

`packages/compaction/compaction-basic/tests/provider-window-overflow.spec.ts` drives the real agent loop against adapters that declare one window and enforce a smaller one on every request, including summaries, with thrown and in-band rejections, for a prompt-only server and an output-reserving server. Automatic recovery completes the turn; each summary request after a rejection is no larger in prompt or cap and smaller in total; every bracket closes, failed brackets match rejected summaries, and logged caps match the wire; `/compact` after an overflow makes the next request fit; and a later manual fold failure reports the committed progress. All 13 of its cases fail on the single-request implementation. `overflow-fold.spec.ts` pins the cap-first step, truncation handling, an indivisible oldest unit, partial progress, non-window failures, a durability failure after a committed fold, and cancellation between and during folds.
