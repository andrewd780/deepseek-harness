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

- Push: skip the pre-push hook for this push (authorized once); pushed the branch, draft PR andrewd780/deepseek-harness#1, subscribed.
- Server: **Ollama**, limited to a **32k** context. Fields: **left blank**. When: a **long chat pursuing a goal** (`/goal`).

## Ollama facts (upstream source read as data)

- `server/prompt.go` `chatPrompt`: with `truncate` on, drops the oldest messages (keeps system messages and the newest message) until the rendered prompt fits `num_ctx`, silently. The OpenAI-compatible layer never sets `truncate`, so it is on; context shift is on. Default `num_ctx` is VRAM-tiered: 262,144 (≥47 GiB), 32,768 (≥23 GiB), else 4,096.
- pi-ai: Ollama "may truncate input silently for some setups, but may also return explicit overflow errors" (`prompt too long; exceeded max context length by X tokens`, classified by both classifiers). Andrew saw an error, so an explicit path occurred; silent truncation likely dropped the goal earlier without the harness knowing.

## Small-window arithmetic (default headroom 65,536, O = 0)

- `retain ≥ threshold` whenever `W − O ≤ 78,019`, so proactive compaction is disabled for 32k and 64k windows even when declared correctly; just above, the trigger is absurdly early (W = 81,920 → threshold 16,384).
- Candidate default with no new tunable: headroom = `min(65,536, floor((W − O) × (1 − thresholdRatio)))` → W 32,768: threshold 26,214, cap 6,553; W 1,000,000/O 256,000: unchanged 678,464; W 262,144/O 0: 196,608 → 209,715 (changes the blank-field pi-ai trigger).

## Council round 2 (seated 2026-10-19)

- Motion: A) a correctly declared small window compacts proactively under default settings; B) obtain the real window from the endpoint (discovery) or a stated limit, and tell the user which field to fix; C) detect silent truncation from reported prompt tokens; D) pi-ai output-reservation clamp.

## Andrew, 2026-10-19 (third message)

- "Ollama doesn't have 1 m context can you fix that". Premise corrected in chat: with blank fields the custom-endpoint card believes 262,144 tokens; 1,000,000 is the DeepSeek card's default. Either way it is far above Ollama's 32k.

## Council round 3 (2026-10-19): learning Ollama's served window — digest

- Brief: scratchpad `council/brief-round3.md`. Seats: system design, challenger.
- Verified in Ollama source: `/api/ps` `context_length` is `llama.ContextLength()` (`server/sched.go:1836`), the same value the scheduler writes into the request's `num_ctx` after load (`sched.go:743-744`) and that caps chat truncation (`routes.go` `optionsForPrompt`). An automatic `num_ctx` can also be lowered on a load OOM (`sched.go:701`), so only the loaded runner knows the served window. MLX-runner models never truncate (`routes.go` ~3261), so they fail with an explicit error instead.
- Challenger: the shipped web profile's fixed prompt is about 7.8k tokens (system prompt plus 31 tool schemas, `snapshots/web/fresh-round-trip`), so an 8,192 window cannot work under any compaction setting; 32,768 leaves about 18.4k for conversation and compacts every 7-13k tokens. Strongest objection: a request sent while the window is unknown (cold model after a restart) is silently truncated; lever: refuse to send a request the served window cannot hold, as `CONTEXT_WINDOW_EXCEEDED`, so the existing recovery and fold take over (summary requests included).
- System design: route field `servedContextProbe: 'auto' | 'off'` (default `auto`) on declared routes with a `baseURL` and an OpenAI or Anthropic protocol; probe on every `resolveModel`, share in-flight probes, keep the last learned value per route and model in memory; report `min(configured, served)` from `resolveModel`, `prepareCall`, and the stream (pi-ai clamp and usage overflow); leave discovery alone; warn once per narrowed value; mock server must answer `/api/ps` outside its script.
- Chair's synthesis for iteration B: the probe as designed, plus the send-path guard using the learned window (no preloading of unloaded models; documented gap: the first request after a restart while the model is unloaded).

## Status log, continued

- 2026-10-19, iteration A committed (`fix(compaction): derive default headroom so small windows compact proactively`): derived default headroom and per-window summary cap in `compaction-basic`. Evidence: 12 new config/behavior tests and 2 real-loop tests fail on the previous source and pass now; 272 compaction tests pass; `compaction-basic/src` 100% statements/branches/functions/lines; oxlint clean on changed files; typecheck identical to baseline (only `exceljs`/`xlsx`); config catalog regenerated (`verify-config-catalog` was stale first); translation pairing 3 pairs consistent; Agent Note format 302 notes. Snapshot work (rework `compaction-summary-overflow`, add `compaction-small-window-defaults`) delegated and running.
- 2026-10-19, snapshots committed (`test(snapshots): record small-window compaction and the summary fold`): `compaction-small-window-defaults` (32,768 window, one summary at cap 6,554, no rejection) and the reworked `compaction-summary-overflow` (declares 262,144, scripted endpoint serves 8,192; rejected caps 65,536 and 1,788, three folds at 894). Agent's plants: altering the recorded cap fails each scenario, restoring passes. Chair re-ran `pnpm run test:snapshot -t compaction`: 6 passed; parsed both JSONLs (caps `[6554]`; `[894, 894, 894]` with 2 failed brackets); scanned for leaked paths or keys (none).
- 2026-10-19, iteration B implemented in `llm-pi-ai` (uncommitted at the time of this entry): `src/served-context.ts` (probe, Ollama name matching, learned windows, shared in-flight probes), `src/endpoint.ts` (root, headers, bounded reads shared with discovery), adapter reports `min(configured, learned)`, gives pi-ai that window (clamp and usage overflow), and refuses a request whose pi-ai estimate exceeds the learned window with `CONTEXT_WINDOW_EXCEEDED` before network I/O; config `servedContextProbe` (`auto`/`off`) and `servedContextProbeTimeoutMs` (5,000).
  - Evidence: `served-context.spec.ts` 45 tests; Loader composition test (blank capacity fields learn 32,768 and clamp to 28,672) and proxy egress test both fail with the tracker unwired; mutations caught: tracker unwired, pi-ai given the configured descriptor, pre-send check removed. pi-ai suite 435 passed; `llm-pi-ai/src` 100% statements/branches/functions/lines; oxlint clean (a planted `no-unsafe-assignment` was reported first); `jscpd` 0 clones; `verify-export-jsdoc` passes; README en/zh pairing and config catalog regenerated; Agent Note `implemented/architecture/2026-10-19-ollama-served-context-window` (303 notes conform).
  - Not done: preloading an unloaded model (first request after a restart can still be truncated); probing LM Studio, llama.cpp, or vLLM windows; a user-visible notice beyond the log warning and the context meter.

## Decisions waiting on Andrew (third round, carried into the pause block)

- Push: the pre-push hook (`pnpm run typecheck`) still fails only on `exceljs`/`xlsx`, because `cdn.sheetjs.com` is still blocked (proxy 403). The earlier hook skip covered one push. Either agree to skip it again, or add `cdn.sheetjs.com` under Allowed domains in the environment's Network access settings.
- 8K: the shipped web profile's fixed prompt is about 7.8k tokens, so `OLLAMA_CONTEXT_LENGTH=8192` cannot run this harness; 32K works but compacts every 7-13k tokens. Larger `num_ctx` trades VRAM (finding 103) for fewer summary hops.
- Probe default: `auto` probes every declared route once per configuration change (Ollama routes on every model-info lookup); `off` per route restores the old behavior.

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
- 2026-10-19, commits: `fix(compaction): fold summaries a provider rejects as too large` (iteration 1); `fix(llm): classify self-hosted servers' context-overflow wordings` (iteration 4) — vLLM 0.32 engine, llama.cpp "Context size has been exceeded." / "context shift is disabled", TGI, LiteLLM class name; 6 positives fail on the original classifier, an overflow-worded HTTP 500 now maps to `CONTEXT_WINDOW_EXCEEDED` instead of `SERVER` on the pi-ai route. LM Studio's newer wording was left out: only recalled from memory, not grounded in a source.

## Decisions waiting on Andrew (first round, answered)

- Answered 2026-10-19: Ollama, 32k, fields blank, long `/goal` chat; one hook skip for the first push. The exact error text was never captured. Open decisions now live in the pause block below.

## Pause block (2026-10-19, Andrew: "record plan and stop and standby")

- Stopped: no agents running (`ListAgents`: none); no build or test processes (only an unrelated plugin MCP server); the one-shot PR #1 check-in already fired and is disabled, not re-armed; the PR #1 activity subscription stays on, so a PR event can still wake the session.
- Branch `claude/deepskee-context-limit-a7gjrz`: 6 commits ahead of `origin` once this block is committed (plan round 2, iteration A, snapshots, iteration B, plan round 3, this block). Pushed and in draft PR andrewd780/deepseek-harness#1: iteration 1 (fold), iteration 4 (classifier), and the first plan commit.
- At risk: the 6 local commits exist only in this container. Push is blocked by the pre-push hook (`pnpm run typecheck`), which fails only on `exceljs`/`xlsx` because the proxy refuses `cdn.sheetjs.com` (403). Unblock with Andrew's "push" (skip the hook once more) or by allowing `cdn.sheetjs.com` under the environment's Network access settings.
- Wake-up: Andrew's next message. Nothing is scheduled.
- Resume steps, in order:
  1. Push the branch (hook skip on Andrew's word, or normally once the host is allowed).
  2. Update PR #1's description for iterations A and B: scope, `servedContextProbe` setting, tests and plants, the snapshot pair, and the 8K limit.
  3. Re-arm the PR safety-net check-in per the check-in rules.
  4. Next iteration, Andrew to choose: (a) load an unloaded Ollama model in the send path so the first request after a restart is checked; (b) iteration 2, pi-ai's 32,768-token output reservation on servers that count requested output (vLLM, gateways); (c) a user-visible notice when a served window narrows the configured one (Web UI, locale dictionaries); (d) served windows for LM Studio, llama.cpp, and vLLM.
- Open decisions for Andrew:
  - Push route: hook skip or allow `cdn.sheetjs.com`.
  - Ollama context size: 8K cannot run the shipped web profile (fixed prompt about 7.8k tokens); 32K compacts every 7-13k tokens; a larger `num_ctx` costs VRAM (j-research finding 103) but means fewer summary hops.
  - Probe default: keep `auto` (one GET per configuration change on every declared route, one per lookup on Ollama routes) or make it opt-in.
