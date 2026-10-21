# Agent Note: pi-ai learns the context window an Ollama endpoint serves

Status: implemented

English | [中文](2026-10-19-ollama-served-context-window.zh.md)

## Problem

A custom endpoint added on the Models page with a blank Context window resolves to pi-ai's 262,144-token default. Ollama serves far less: it sizes each model's window when it loads the model — from the Modelfile's `num_ctx`, `OLLAMA_CONTEXT_LENGTH`, or a VRAM-tiered default of 4,096, 32,768, or 262,144 tokens that it may lower after a load failure — and its OpenAI-compatible chat handler drops the oldest non-system messages of a request that does not fit, without an error. The harness therefore never compacted before Ollama truncated, a long `/goal` chat could lose its earliest messages (the goal objective among them) without any signal, and the reported turn ended with an error. Declaring the true window was not enough on its own: the same model can be served at 32,768 or 8,192 tokens depending on the server's environment, and no Ollama API reports the window before the model loads.

## Decision

`dsh-llm-pi-ai` probes Ollama's process listing, `GET {root}/api/ps`, on declared routes — routes the installed catalog does not ship — that have a `baseURL` and an OpenAI or Anthropic protocol, unless the route sets `servedContextProbe: off`. Every `resolveModel()` probes; concurrent probes of one route share one request, bounded by `servedContextProbeTimeoutMs` (default 5,000 ms). A listed model's `context_length` is learned per route and canonical Ollama model name and kept in memory, so an unloaded model keeps its last observed window. The adapter reports `min(configured, learned)` from `resolveModel()` and prepared calls, gives pi-ai a model descriptor with that window so its output clamp and usage-based overflow detection use it, and refuses a request whose pi-ai estimate exceeds the learned window with `CONTEXT_WINDOW_EXCEEDED` before network I/O, which hands the history to compaction's overflow recovery. A reply that is not a process listing marks the route as unprobed until its profile changes; a transient failure is retried on the next lookup. The [package README](../../../../packages/llm/llm-pi-ai/README.md) owns the operational rule.

## Alternatives considered

**Read the window during model discovery only.** Rejected: discovery results become stored configuration when adopted, so a value captured while the server ran at 32k becomes a stale ceiling after it moves to 8k, and discovery cannot see a model that is not loaded.

**Use `/api/show`.** Rejected: its `model_info` context length is the trained length, and its `parameters` carry `num_ctx` only when the Modelfile sets it; neither reports the environment or VRAM default the server actually applies.

**Load an unloaded model before probing.** Deferred: it would close the first-request gap after a restart, but model-info lookups also run when the model catalog is listed, where loading every listed model is an unacceptable side effect; a send-path load needs its own lifecycle.

**Detect truncation from reported prompt tokens.** Rejected: a shortfall is ambiguous, because Ollama's reported prompt count has been observed to exclude a reused cache prefix (not verified in Ollama's source), so it cannot prove truncation.

**Probe only when the user opts in.** Rejected as the default: the reported deployment left every capacity field blank, so a switch the user must discover would not fix it; `off` remains available, and a non-Ollama route answers once with a 404 and is not probed again.

## Consequences

On an Ollama route, compaction prices against the served window once a lookup has seen the model loaded, so a blank Context window compacts proactively under the derived default headroom (a 32,768-token window at 26,214 tokens), and a request that would still be truncated fails as a classified overflow that compaction recovers from. Every declared route with an endpoint receives one extra GET per configuration change, and Ollama routes one per model-info lookup. A request made before any lookup has seen the model loaded in this process — the first request after a Host restart while Ollama has unloaded the model — still uses the configured window. The pre-send check shares pi-ai's four-characters-per-token estimate, which under-counts dense scripts. Only Ollama is probed; LM Studio, llama.cpp, and vLLM report their windows elsewhere.

## Testing

`served-context.spec.ts` covers probe resolution per route kind and setting, canonical model names, listing validation, every probe outcome (listing, absent replies, transient statuses, unreachable and stalled endpoints, credential failure), shared probes, per-caller cancellation, disposal, and the headers sent; through the adapter it pins the reported window, the one-time warning, pi-ai's output clamp against the served window, a smaller configured window, the `off` setting, and the pre-send refusal before any request reaches the endpoint. `loader-composition.spec.ts` boots the plugin through the Loader with a declared route that has no capacity fields and asserts the learned 32,768-token window and clamp, and `egress.spec.ts` sends the probe through the configured proxy. The plugin-level tests fail when the tracker is not wired, when pi-ai receives the configured descriptor, or when the pre-send check is removed.
