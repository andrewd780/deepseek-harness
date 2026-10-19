# Plan: custom-endpoint context overflow ends the turn

Working planning document for branch `claude/deepskee-context-limit-a7gjrz`. Remove it before proposing any of this work upstream.

## Problem as reported (2026-10-19)

- Symptom (Andrew, via question): "Error ends the turn" — a context-window-exceeded error stops the chat; retrying or `/compact` does not recover.
- Route (Andrew): a custom endpoint added on the Models page (gateway, OpenRouter, or local server).
- No issue, commit, note, or earlier session records the symptom; the fork is upstream `release-0.2.1-alpha.2` with no local commits.

## Established facts

- DeepSeek built-in catalog assumes `contextWindow` 1,000,000 and `maxTokens` 256,000 (`packages/llm/llm-deepseek/src/defaults.ts`).
- Compaction trigger is `floor(min(W × 0.8, W − O − 65,536))`; retained tail is `0.16 × (W − O)` (`packages/compaction/compaction-basic/src/config.ts`).
- With the DeepSeek defaults the trigger is 678,464 tokens; it is correct only when the endpoint really serves W.
- Overflow recovery runs only for errors classified `CONTEXT_WINDOW_EXCEEDED` (`packages/llm/llm/src/error.ts`, `isContextWindowExceededError`), with `maxOverflowRetries` 1.
- Documented gaps in `compaction-basic` README: heuristic meter (4 chars/token) underprices CJK and JSON; classification is adapter-maintained; indivisible units and envelopes cannot be compacted; summarization failure keeps the over-budget surface.

## Hypotheses (to confirm or kill)

1. The harness believes a larger window than the server enforces, so pressure compaction never fires in time.
2. The server's overflow wording is not classified, so recovery never runs.
3. Recovery runs but its budgets come from the wrong window, and the summarization request itself overflows, so `/compact` fails too. **CONFIRMED (reproduced).**
4. A correctly small window collides with the default 65,536 headroom and compaction refuses to resolve.

## Root cause (reproduced 2026-10-19)

- Overflow recovery and `/compact` both call `selectCompactableRange(session, measurement, 0)` (retain zero), so they summarize everything except the newest surface node in **one** request (`packages/compaction/compaction-basic/src/index.ts`, `compactIfNeeded` and `compactNow`).
- The summary request is `[system, the whole selected span, instruction]` (`summarizer.ts`, `summarizeWithLlm`), so after a real overflow it is about as large as the request that just failed, and larger when the newest node is shorter than the ~800-token instruction.
- The summary request reserves `maxTokens` = `headroomTokens` = 65,536 output tokens by default, whatever the window. On servers that check input plus requested output (vLLM, OpenAI-compatible gateways) every summary is rejected for windows under ~70k, and whenever the conversation reserved less output than the summary does.
- No `compaction/summary-error` listener recovers a text-only overflow, so the attempt closes with an error and the original overflow ends the turn.
- It works on the DeepSeek built-in route only because conversation requests reserve 256,000 output tokens, leaving about 190k of slack for a 65,536-token summary reservation.

Reproduction: `packages/compaction/compaction-basic/tests/provider-window-overflow.spec.ts` — 5 of 5 fail on unmodified source (prompt-only server with chat growth: turn 7 ends `CONTEXT_WINDOW_EXCEEDED`, summary asked 9,999 > 8,000; output-reserving server: turn 1 ends, `/compact` fails; correct 32,768 window: `/compact` asks 69,329 tokens).

## Custom-endpoint facts (investigator, spot-checked in source)

- Custom endpoints are served by `llm-pi-ai`. A blank context-window field means `DEFAULT_CONTEXT_WINDOW = 262_144` (`packages/llm/llm-pi-ai/src/config.ts:65`); a blank output field means 32,768 output tokens on the wire (`config.ts:68`), yet compaction reserves 0 because pi-ai reports `defaultMaxTokens` only when configured (`adapter.ts:315-324`, `compaction-basic/src/index.ts:60-68`).
- pi-ai clamps output to `min(requested, believedWindow − estimate − 4096)` using the believed window (`@earendil-works/pi-ai/dist/api/simple-options.js:5-10`).
- With W = 262,144 and O = 0 the pressure trigger is 196,608, above most local and open-model windows, so proactive compaction never fires before the real limit.
- Model discovery reads `context_length` and similar fields but not vLLM `max_model_len` or llama.cpp `n_ctx`; no code learns a window from an overflow error.

## Prior art from j-research (sweep, 2026-10-19)

- The served window is a deployment fact: Qwen3.8-27B runs at Ollama's 32K default or 8K while its GGUF advertises 262,144 (`j-research/workspace/findings/103-…`). A learned window belongs to the endpoint configuration, not the model name.
- chars/4 measured against Ollama `prompt_eval_count`: ratio 0.93–1.06 over 10 turns, undercounting log/thread turns by ~6% (`j-research/qwen-heavy/acceptance/REGISTER.md:211-230`). Sizing from the estimate needs a margin; rejections are the ground truth.
- Multi-hop summaries corrupt: "pointers not paraphrases" (`j-research/workspace/BUILD-SPEC-2026-08-31-agents.md:21-39`). A fold should minimize hops.
- Discipline carried over: the reproduction was written and seen failing before any fix.

## Second root cause: the conversation's own output reservation (verified)

- With Max output blank, pi-ai sends `min(32_768, believedWindow − estimate − 4096)` output tokens, and its estimate counts only `context.messages` (`@earendil-works/pi-ai/dist/utils/estimate.js`); the harness puts the system prompt in `systemPrompt` and tools in `context.tools` (`packages/llm/llm-pi-ai/src/context.ts:139-164`), and replayed history carries zero usage (`replay.ts:180`).
- On servers that count prompt plus requested output (vLLM, OpenRouter, OpenAI-compatible gateways), once the clamp engages each request totals `W − 4096 + system + tools`, so it overflows whenever system + tools exceed 4,096 tokens. With a ~32k window that is every request; compaction cannot fix it.

## Classification gaps (investigator, upstream sources downloaded)

- Classified correctly: OpenAI, vLLM ≤ 0.31, llama.cpp's main overflow error, Ollama's explicit error, OpenRouter, SGLang, Groq, Mistral, DeepSeek, Anthropic, Gemini, Kimi, Together.
- Misclassified: LM Studio wording and vLLM 0.32 engine wording → `INVALID_REQUEST`; llama.cpp "Context size has been exceeded." (HTTP 500) → `SERVER`, retried 5 times; llama.cpp mid-stream "context shift is disabled" → `PI_AI_ERROR`; all TGI wordings; LiteLLM's `ContextWindowExceededError` label. Ollama chat truncates silently by default.
- In-band SSE errors lose code and type before classification (pi-ai `streaming.mjs`).

## Council round 1 (2026-10-19) — digest

- Builds: right layer (compaction-basic), no seam or session-format change; "cap first, then halve the span" keeps rejections cheap.
- Splits: output reservation is a second root cause compaction cannot fix (debug, challenger); after a rescue the believed window is still wrong, so pressure never fires and every later compaction is an emergency fold (philosopher, challenger); folds over history ≫ window cost one summary per chunk with no bound (system design).
- Testing obligations: keyless headless snapshot (llm-replay bare `ReplayEntry[]` override), exact wire counts and start/end pairing, in-band rejection, termination tests for every branch (100% coverage gate), an SDK `/compact` scenario.
- Challenger's lever: read the rejection, parse the stated window, stop and name the Models-page field when the fixed prompt plus reservation cannot fit, otherwise fold straight to that window; halve only without a number.

## Iteration plan (one branch; each iteration its own commit so they can be split into PRs later)

1. Rejection-driven bounded fold for overflow recovery and `/compact` (prototype passes 4/5 reproductions). Round-1 refinements: partial success for `/compact` after a committed fold, fold on a truncated (`MAX_TOKENS`) summary by halving the span, termination tests.
2. Output reservation on pi-ai routes: reproduce with a fake that reserves 32,768 unreported, then size the request cap from a complete estimate.
3. Learned window: parse stated limits from overflow errors, size folds directly, and tell the user the configured window is wrong.
4. Classifier additions for the misclassified wordings.

## Andrew's answers (2026-10-19, second question round)

- Push: skip the pre-push hook for this push (authorized once); pushed `86bdfeef6`, draft PR andrewd780/deepseek-harness#1, subscribed.
- Server: **Ollama**, limited to a **32k** context. Fields: **left blank**. When: a **long chat pursuing a goal** (`/goal`).

## Ollama facts (upstream source read as data)

- `server/prompt.go` `chatPrompt`: with `truncate` on, drops the oldest messages (keeps system messages and the newest message) until the rendered prompt fits `num_ctx`, silently. The OpenAI-compatible layer never sets `truncate`, so it is on; context shift is on. Default `num_ctx` is VRAM-tiered: 262,144 (≥47 GiB), 32,768 (≥23 GiB), else 4,096.
- pi-ai: Ollama "may truncate input silently for some setups, but may also return explicit overflow errors" (`prompt too long; exceeded max context length by X tokens`, classified by both classifiers). Andrew saw an error, so an explicit path occurred; silent truncation likely dropped the goal earlier without the harness knowing.

## Small-window arithmetic (default headroom 65,536, O = 0)

- `retain ≥ threshold` whenever `W − O ≤ 78,019`, so proactive compaction is disabled for 32k and 64k windows even when declared correctly; just above, the trigger is absurdly early (W = 81,920 → threshold 16,384).
- Candidate default with no new tunable: headroom = `min(65,536, floor((W − O) × (1 − thresholdRatio)))` → W 32,768: threshold 26,214, cap 6,553; W 1,000,000/O 256,000: unchanged 678,464; W 262,144/O 0: 196,608 → 209,715 (changes the blank-field pi-ai trigger).

## Council round 2 (seated 2026-10-19)

- Motion: A) a correctly declared small window compacts proactively under default settings; B) obtain the real window from the endpoint (discovery) or a stated limit, and tell the user which field to fix; C) detect silent truncation from reported prompt tokens; D) pi-ai output-reservation clamp.

## Process

1. Diagnose with three parallel investigators (config path, classification, recovery) plus own reading.
2. Reproduce with a failing test before any fix.
3. Council rounds (engineer seats + challenger) on the fix design; orchestrator-reviewer at verdict.
4. Implement with unit and real-composition tests, README/JSDoc updates.
5. Pre-push checks per `dsh-pre-push-checks`; push; draft PR.

## Status log

- 2026-10-19: environment ready; `pnpm install` excludes `@deepseek-ai/dsh-client-ui-sidebar-documentpreview` because the network policy blocks `cdn.sheetjs.com` (its `xlsx` tarball). Investigators launched.
- 2026-10-19, iteration 1 implemented (uncommitted): `compactWithinProviderWindow` fold in `compaction-basic/src/index.ts`, `selectBoundedPrefix` in `region.ts`, cap carried in `SummarizationInput.maxTokens`, truncation is a typed `LlmError('MAX_TOKENS')`.
  - Evidence: `provider-window-overflow.spec.ts` 13/13 fail on the previous implementation and pass now; `overflow-fold.spec.ts` 11/11; 9 single-rule mutations of the fold each caught; `compaction-basic/src` at 100% statements/branches/functions/lines with all compaction tests (252 passed).
  - Lint: oxlint clean on changed files (plant `no-unused-vars` caught first).
  - Typecheck: only the two environmental errors (`exceljs`, `xlsx` in documentpreview tests); a planted TS2322 in a compaction-basic test was reported, so the program covers these tests.
  - Docs: README en/zh sections updated and re-recorded; new Agent Note `.agents/notes/implemented/bug-fix/2026-10-19-overflow-summary-folding.*`; `2026-07-20-routed-model-context-and-compaction-policy` updated with a cross-link; `verify-agent-note-format` passes (301 notes).
  - Pending: `doc-sync`, keyless snapshot scenario, push (pre-push typecheck hook fails only on the environmental errors; bypass needs Andrew's agreement per `dsh-pre-push-checks`).
- 2026-10-19, iteration 2 evidence started: end-to-end run of the real `llm-pi-ai` adapter against a local window-enforcing OpenAI-compatible server.
- 2026-10-19, `doc-sync`: 41 passed, 2 failed — `doc-typecheck` (its `build:lib:host` prerequisite hits the `exceljs`/`xlsx` errors; its own step `doc-typecheck:contracts-ready` passes: 81 blocks compiled) and `Cordis inspect catalog` (fails identically on the original tree at `ui-sidebar-documentpreview/src/client/document/contract.ts:45:27`). Both are the uninstallable documentpreview package.
- 2026-10-19, commits: `ba8452c77` fix(compaction) iteration 1; `9ed029085` fix(llm) iteration 4 — vLLM 0.32 engine, llama.cpp "Context size has been exceeded." / "context shift is disabled", TGI, LiteLLM class name; 6 positives fail on the original classifier, an overflow-worded HTTP 500 now maps to `CONTEXT_WINDOW_EXCEEDED` instead of `SERVER` on the pi-ai route. LM Studio's newer wording was left out: only recalled from memory, not grounded in a source.

## Decisions waiting on Andrew

- Exact error text, server type (vLLM / OpenRouter / LM Studio / llama.cpp / Ollama / hosted), and whether it hit on the first message or after a long conversation — decides whether the history fold (iteration 1) or the output reservation (iteration 2) is the fix that matters for him.
- Whether the Context window and Max output fields were filled for that model.
- Agreement to push past the pre-push typecheck hook, which fails only on `xlsx`/`exceljs` missing from this environment (or allow `cdn.sheetjs.com` in the environment's network settings so the hook can pass).
- Workaround available today: set the model's Context window and Max output on the Models page to what the endpoint enforces, and in `cordis.patch.yml` set `@deepseek-ai/dsh-compaction-basic` `headroomTokens` small enough that `window − maxOutput − headroom > 0` (a 32,768 window with 4,096 output and 4,096 headroom compacted proactively in the recovery investigator's control run).
