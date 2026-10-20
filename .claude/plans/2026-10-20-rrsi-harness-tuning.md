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

- Trials = |evolve| × k × (1 + m × T) = 89 × 2 × (1 + 2 × 20) = **7,298** task runs, plus the out-of-distribution pass (SWE-bench Verified, 500 tasks × k).
- Policy cost = trials × tokens per trial × price. Tokens per trial for dsh on Terminal-Bench is unmeasured; kill test K1 measures it. Illustration only: at 200k tokens per trial, 7,298 trials are about 1.46 billion policy tokens.
- Wall time ≈ trials ÷ concurrency × minutes per trial (at 10 concurrent and 10 minutes per trial, about 122 hours).

## Kill tests, cheapest first

- **K1 smoke**: dsh as the agent on the coding instance's two smoke tasks (`extract-elf`, `fix-git`), k = 1. Kill if dsh cannot run inside the task container, or if tokens and minutes per trial extrapolate past the budget ceiling.
- **K2 baseline**: H_0 on the full evolve set (178 trials) and the noise band from `calibrate`. Kill if H_0 is near 0 or near 1, or if δ is wider than any gain worth paying for.
- **K3 short run**: T = 3 to 5. Kill if no candidate clears the noise floor.

## Standard versus new

- Standard: the RRSI loop, Terminal-Bench 2.1 through harbor, the noise floor and cost rule, the paper's hyperparameters.
- New: dsh as the agent (a new Domain adapter and container setup), DeepSeek as the frozen policy (the paper used Opus 4.8 and Gemini 3.5 Flash), and the choice of evolvable surface.

## Decisions for Andrew

- D1 budget ceiling, in dollars and wall time, for K1, K2, K3, and a full run.
- D2 credentials: the policy key (DeepSeek), and the proposer route (Vertex AI for Opus 4.8, the Anthropic API, or DeepSeek as proposer as well).
- D3 where it runs: a cloud machine with Docker. Not the work Mac (standing rule); the 8 GB Air cannot host Terminal-Bench containers at useful concurrency.
- D4 evolvable surface: runtime surfaces (cheaper, narrower) or TypeScript sources (broader, a build per candidate).
- D5 evolve set: Terminal-Bench 2.1 as in the paper, or a smaller set first.
- D6 branch: adapter code on a new branch, which needs Andrew's permission to push.

## Status log

- 2026-10-20: paper located (arXiv 2609.24972, 2026-09-23); arXiv text unreachable (proxy 403), no PDF in Drive; repository cloned and read at SOURCE depth; ticket T-0031 opened in j-research for the record; council round on this plan seated.
