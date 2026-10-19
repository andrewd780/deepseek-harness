# Agent Note: Unset compaction headroom fits small context windows

Status: implemented

English | [中文](2026-10-19-small-window-default-headroom.zh.md)

## Problem

`dsh-compaction-basic` reserved a fixed 65,536 tokens of pressure headroom unless configured, and the summary cap followed it. The trigger `floor(min(W × 0.8, W − O − 65,536))` has no positive pressure budget when the window `W` minus reserved output `O` is 65,536 tokens or less, so a correctly declared 32,768-token window failed `resolveCompactSpec` with `TargetPressureConfigError`; the pre-step listener warned once and never compacted proactively on that route. Up to a message budget of 78,019 tokens the retained tail reached the trigger and failed the same way, and just above it the trigger came very early (an 81,920-token window compacted at 16,384). A summary request reserving 65,536 output tokens is also rejected outright by servers that count requested output against a 32k window. Local servers such as Ollama commonly serve 4k to 32k windows, so declaring the true window did not give such a route working compaction.

## Decision

Unset `headroomTokens` is derived per routed target from its message budget `M = W − O`: `min(65,536, M − floor(thresholdRatio × min(M, 65,536)))`. For a budget of at most 65,536 tokens the trigger becomes `floor(thresholdRatio × M)` and the headroom is the rest of the budget. At the default ratio every budget of at least 117,964 tokens keeps the fixed 65,536, so the DeepSeek route (1,000,000 window, 256,000 output) and the pi-ai blank-window default (262,144) keep their triggers and summary caps. An unset `maxTokens` follows the derived headroom for pressure compaction, `compactRegion()`, overflow recovery, and `compactNow()`; it is 65,536 when the routed window is unknown, its lookup fails, or `thresholdRatio: 1` leaves no derived headroom. Configured `headroomTokens` and `maxTokens` keep their values and checks. `ResolvedConfig` and `ResolvedTargetPolicy` omit the unset fields, and `resolveCompactSpec` and `resolveSummaryCap` are the resolve steps that derive them. The [package README](../../../../packages/compaction/compaction-basic/README.md) owns the operational rule.

## Alternatives considered

**`min(65,536, floor(M × (1 − thresholdRatio)))`.** Rejected: it also changes budgets between 117,964 and 327,680 tokens, including the pi-ai blank-window default (trigger 196,608 becomes 209,715), which changes recorded sessions without fixing a failure.

**Keep the fixed headroom and document configuration for small windows.** Rejected: the failure is visible only as one log warning, and the remedy requires knowing the trigger formula; the reported deployment left the window fields blank.

**Reject a window too small for the headroom at plugin load.** Rejected: capacity is resolved per routed target at first use, not at load, and refusing to compact helps no deployment.

## Consequences

A route whose adapter declares its real small window compacts proactively under default settings: a 32,768-token window with no reserved output compacts at 26,214 tokens with a 6,554-token summary cap, and an 8,192-token window at 6,553 with 1,639. For budgets from 65,537 to 117,963 tokens the trigger stays at 52,428 at the default ratio while the cap rises toward 65,536. The fixed request overhead (system prompt and tool schemas, about 7.8k tokens in the shipped web profile) cannot be compacted, so a window near that size still cannot serve a conversation. Overflow recovery and `/compact` resolve the routed model's window before their first transaction to size the cap, so their start marker follows that lookup. The window itself still comes from the adapter; a blank pi-ai window remains 262,144 tokens, and the [overflow fold](2026-10-19-overflow-summary-folding.md) remains the recovery when the declared window exceeds the served one.

## Testing

`compaction-basic.spec.ts` pins the derived trigger, retained budget, and summary cap for budgets from 8,192 to 1,000,000 tokens, including both sides of 117,964; explicit headroom, explicit caps, and per-model headroom; the `thresholdRatio: 1` cap; the cap through `compactRegion()` for known, reserved-output, unknown, unrouted, and failed-lookup windows; and cancellation during the lookup. `provider-window-overflow.spec.ts` drives a 30-turn chat against a prompt-only 32,768-token window without a rejected request, and a `compactNow()` whose first summary fits; both fail on the fixed-headroom implementation, and a configured 65,536-token cap still exercises the fold.
