# Plan: tune deepseek-harness with RRSI

Working planning document. It shares branch `claude/deepskee-context-limit-a7gjrz` with the context-limit work; any adapter code belongs on its own branch (Decision D6). Remove it before proposing any of this work upstream.

## Request (Andrew, 2026-10-20)

- "Yo can you find this and add it to the deepseek harness", with a screenshot of the first page of arXiv 2609.24972, "RRSI: Regularized Recursive Self-Improvement of Agent Harnesses" (Google Cloud AI Research, UNC-Chapel Hill, Stanford, Washington University in St. Louis).
- Asked what "add" should mean: "Record it and tune harness with rrsi". Asked where: "This session".
- The record half is j-research ticket T-0031 (folder 15 of `references/math/` and `workspace/notes/lit-rrsi-harness-2026-10-20.md`). This file is the tuning half.

## What RRSI is (SOURCE + README depth)

Read in the authors' repository, `google-research/rrsi`, cloned read-only at `/home/user/google-research/rrsi` (the pinned commit is recorded in T-0031). The paper text is unread: the proxy refuses arxiv.org (403) and Andrew's Drive holds no RRSI PDF.

- An offline search over a harness — the prompts, control flow, configuration, tools, skills, memory, and sub-agents around a frozen policy model — scored on a fixed evolve set of benchmark tasks (README §Overview).
- Each round drafts `m` candidates in their own git worktrees, screens them with a critic, evaluates each on the whole evolve set with `k` trials per task, and fast-forwards `evolve/<domain>` to the winner, so the incumbent is always a commit (README §Run an instance).
- Regularizers (README §Method to code): an annealed cap on edits bundled per candidate (`rrsi/schedule.py`), proposals conditioned on the full edit history with exploration of untried components (`rrsi/history.py`, `rrsi/propose.py`), a critic that screens suite-specific logic before evaluation (`rrsi/critic.py`), a noise-adjusted acceptance floor, a cost rule that makes added inference tokens pay for themselves, and pruning of components that stop helping (`rrsi/selection.py`).
- A domain is one adapter, `domains/<name>/adapter.py`, implementing `rrsi.domain.Domain`: task splits, `run` and `score` for a checked-out harness, trace rendering for the analyst, a smoke check, the critic's denylist, role prompts, and acceptance guards, plus the evolvable `harness_path`, `SKILL.md`, `PATTERNS.md`, and `rrsi.json` (README §Adding a domain; `rrsi/domain.py`).
- Coding instance defaults (`domains/coding/rrsi.json`): Terminal-Bench 2.1, 89 tasks, evolve set = whole suite; `k` 2, `T` 20 rounds, `m` 2 candidates, concurrency 10; noise band δ 0.017 (3 passes of 178 trials); policy, proposer, analyst, and critic all Claude Opus 4.8 on Vertex AI; any LiteLLM model string works. The harness evolved is the Terminus-2 Python agent run through harbor in each task's Docker container (`domains/coding/adapter.py`).
- README results, the authors' statement: Terminal-Bench 2.1 74.2 → 80.2 with Claude Opus 4.8 as the policy; 64.6 → 78.7 with Gemini 3.5 Flash. The "up to 14.1 points" in the abstract is the Gemini figure, the "+6.0" the Opus figure.

## What tuning deepseek-harness with RRSI requires

1. A new RRSI domain, `domains/dsh/`, whose `run` executes the dsh CLI as the agent on each task. On Terminal-Bench that means dsh inside every task container: Node at the engines range, the built CLI, and a credential. INFERENCE to verify in harbor's documentation: harbor runs installed agents (CLI agents set up inside the task container) as well as Python agents like Terminus-2.
2. An evolvable `harness_path`, one of:
   - **Runtime surfaces only**: a scenario overlay (`cordis.yml` patch), agent instructions, and skills that dsh loads at startup. No build per candidate; edits are limited to what configuration and prompt files expose.
   - **TypeScript sources** of chosen packages (system prompt text, tool descriptions, compaction defaults): a full build and the repository's gates per candidate, minutes each, and every accepted edit must still pass review, snapshots, and the 100% coverage gate before it can ship.
3. A frozen policy: DeepSeek V4 through the API, the harness's home route; the Ollama model is too slow for thousands of trials at 32k.
4. A proposer, analyst, and critic model (default Opus 4.8 on Vertex AI; any LiteLLM model).
5. A Docker host running harbor. This container has the docker CLI but no daemon, and no API keys, so no trial can run here.

## Arithmetic (derived from the coding defaults)

- Trials = |evolve| × k × (1 + m × T) = 89 × 2 × (1 + 2 × 20) = **7,298** task runs, plus up to 80 smoke trials (2 per candidate) and the out-of-distribution pass (2 arms × 500 tasks × 1 trial = 1,000).
- Edit budget: b_t = ceil(1 + 3·½(1 + cos(πt/20))) runs 4 → 2 over rounds 0 to 19 and never reaches 1, so a full run is at most 20 accepted commits carrying at most 61 edits.
- Policy cost = trials × tokens per trial × price. Tokens per trial for dsh on Terminal-Bench is unmeasured; kill test K1 measures it. Illustration only: at 200k tokens per trial, 7,298 trials are about 1.46 billion policy tokens.
- Wall time ≈ trials ÷ concurrency × minutes per trial (at 10 concurrent and 10 minutes per trial, about 122 hours).

## Kill tests, cheapest first

- **K1 smoke**: dsh as the agent on the coding instance's two smoke tasks (`extract-elf`, `fix-git`), k = 1. Kill if dsh cannot run inside the task container, or if tokens and minutes per trial extrapolate past the budget ceiling.
- **K2 baseline**: H_0 on the full evolve set (178 trials) and the noise band from `calibrate`. Kill if H_0 is near 0 or near 1, or if δ is wider than any gain worth paying for.
- **K3 short run**: T = 3 to 5. Kill if no candidate clears the noise floor.

## Standard versus new

- Standard: the RRSI loop, Terminal-Bench 2.1 through harbor, the noise floor and cost rule, the paper's hyperparameters.
- New: dsh as the agent (a new Domain adapter and container setup), DeepSeek as the frozen policy (the paper used Opus 4.8 and Gemini 3.5 Flash), and the choice of evolvable surface.

## Council round 1 (2026-10-20)

- Challenger: the evolve regime is wrong for Andrew. Terminal-Bench tasks are single episodes on a 1M window; his recorded failure is a long `/goal` chat on Ollama at 32k. At δ = 0.017 a gain needs 4 net passes of 178 trials, and with about 20 coin-flip tasks an unchanged harness clears that about 1 time in 5 (inference). A 4-pass gain buys up to +110% tokens per trial; with w_s = 0 and w_n = 0.5 a new structural component is admitted at zero gain below +3.3% cost. Cheapest test: tag 10 of his real `/goal` failures by component. Lever: evolve in his regime (a 32k context-window override), veto fixed-prompt growth with a domain guard, and evolve runtime surfaces only so a winner ships as an overlay.
- System design: the evolvable surface should be (a) runtime surfaces: an overlay patch (system-prompt suffix and tool order, compaction ratios, pruner, spill, reminders, timeouts, PTC mode, tool `disabled` flags), `AGENTS.md`, and skills, with a frozen overlay pinning the model rows; (b) TypeScript sources cost a build per candidate (15 to 40 minutes, inference). Evaluate with `dsh --profile headless --patch <surface> --patch <frozen> --json`; the later patch wins. Blockers: `--json` meters only the parent session, so child agents and auxiliary calls escape the cost rule (meter all sessions, or proxy `DEEPSEEK_BASE_URL`); headless approvals fail closed, so trials need an explicit permission mode; the RRSI proposer, analyst, and critic are Vertex-only; Terminal-Bench containers need model egress. Smoke: `--dump-config` (unmatched patch targets are fatal) before the smoke tasks.
- Consequence for the goal: the in-harness implementation measures candidate overlays on a task suite Andrew supplies, in any model configuration (including a 32k window), with costs read from every session a trial writes.

## Decisions for Andrew

- D1 budget ceiling, in dollars and wall time, for K1, K2, K3, and a full run.
- D2 credentials: the policy key (DeepSeek), and the proposer route (Vertex AI for Opus 4.8, the Anthropic API, or DeepSeek as proposer as well).
- D3 where it runs: a cloud machine with Docker. Not the work Mac (standing rule); the 8 GB Air cannot host Terminal-Bench containers at useful concurrency.
- D4 evolvable surface: runtime surfaces (cheaper, narrower) or TypeScript sources (broader, a build per candidate).
- D5 evolve set: Terminal-Bench 2.1 as in the paper, or a smaller set first.
- D6 branch: adapter code on a new branch, which needs Andrew's permission to push.
- D7 commit: the pre-commit third-party-notices job cannot run in this container (it needs the `xlsx` tarball that cdn.sheetjs.com serves, and the proxy blocks that host); committing the package needs Andrew's agreement to skip that one job once.
- D8 push: the pre-push typecheck fails on the same uninstallable client package; pushing needs Andrew's agreement to skip it once.
- D9 snapshot: a session snapshot of `/self-improve` needs new snapshot-harness support for driving a command through the public protocol; build it now or defer it.

## Status log

- 2026-10-20: paper located (arXiv 2609.24972, 2026-09-23); arXiv text unreachable (proxy 403), no PDF in Drive; repository cloned and read at SOURCE depth; ticket T-0031 opened in j-research for the record; council round on this plan seated.
- 2026-10-20: `/goal` set: implement the recursive self-improvement in the harness. Building `@deepseek-ai/dsh-experimental-self-improve`: a native port of the RRSI loop (annealed budget, edit history, prune set, stall-triggered exploration, critic with bounded repair, noise floor and cost rule) over injected domain, revision-store, analyst, proposer, and critic roles; accepted candidates fast-forward an evolve branch and never touch the live configuration. Council round 1 recorded above.
- 2026-10-20: `@deepseek-ai/dsh-experimental-self-improve` implemented. `/self-improve baseline|calibrate|round|run|heldout|status <spec.json>` runs as a background job. Candidates evolve a tracked directory (overlay patch, `AGENTS.md`, `skills/`) on candidate branches, and trials run in fresh `dsh --profile sdk` runtimes through the SDK client, scored by suite checks. Accepted candidates fast-forward `self-improve/<name>`. Evidence: 144 tests in 21 spec files at 100% per-file coverage, including a real Loader composition that accepts a skill end to end; package typecheck, tests typecheck, and lint clean. Not done: a keyless recorded-session snapshot (recording needs `DEEPSEEK_API_KEY`); any real run (no key, and Andrew's D1–D6 decisions stand).
- 2026-10-20: repository gates. First doc-sync: 35 of 43 passed. Fixed: 10 export-JSDoc gaps; renamed the package's `Domain` to `SelfImproveDomain`, because the Cordis API catalog drops a type name two packages declare and the clash removed storage's `Domain` and three dependent types from the model-visible catalog (the regenerated catalog now equals HEAD); recorded `docs/persistence-changes/2026-10-20-self-improve-attribution` (same-version: the role-request source kind widens `MessageSource` in 4 event roots, and role requests never enter a Session log because both production `llm/stream` listeners return early without `sessionId`); regenerated the skill plugin package list and the historical-format facts (597 → 605 types); added the lockfile importer, generated by pnpm with the CDN-hosted `xlsx` excluded and spliced as +82/−0 (the frozen-lockfile check failed before and passes after). Second doc-sync: 40 of 43, then 41 after the format-facts fix; the 2 left fail in `ui-sidebar-documentpreview`, whose dependencies never installed because the proxy blocks cdn.sheetjs.com, and neither covers this host-only package. Also: 144 tests at 100% coverage after the rename, oxlint clean, package and tests typecheck clean (a planted error is caught), publint-all passes, 7 source hygiene gates pass, a one-package NodeNext consumer check passes. The correction to the entry above: authored snapshots need no key; the gap is command-driving support in the snapshot harness (D9). Not committed: D7. Not pushed: D8.
