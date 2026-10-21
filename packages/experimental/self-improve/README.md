---
description: "Improve a harness configuration by measured search: regularized recursive self-improvement over a task suite, with accepted candidates committed to an evolve branch."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-self-improve

English | [中文](README.zh.md)

## Summary

Run regularized recursive self-improvement (RRSI) on a directory of harness configuration: a profile overlay, user-global instructions, and skills. Each round, a model analyzes the incumbent's trajectories on a task suite you supply and drafts candidate edits, a reviewer rejects edits that fit the suite instead of improving the harness, and fresh dsh runtimes measure every remaining candidate. A candidate replaces the incumbent only when its score clears the noise floor and measured gain pays for any added tokens. Accepted candidates are commits on an evolve branch in your repository; you decide whether to apply one.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### Mount the command

Mount the plugin in a composition that already provides `llm`, `subprocess`, `workingDirectory`, and `commands`, together with background jobs and their controller:

```yaml
- name: '@deepseek-ai/dsh-jobs-local'
- name: '@deepseek-ai/dsh-tool-jobs'
- name: '@deepseek-ai/dsh-experimental-self-improve'
```

The runs directory, the trial scratch directory, and process limits are in the [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-self-improve).

### Prepare a run

A run uses four kinds of files in a git repository:

1. **Evolved directory** — a tracked directory, outside the runs directory, holding any of `overlay.patch.yml` (a profile patch every trial applies before the policy patches), `AGENTS.md` (copied into each trial's Harness home as user-global instructions), and `skills/` (copied there as user skills). The overlay may only set the compaction, tool-result pruning, output spilling, system prompt, and repeated-tool reminder settings that [`DSH_OVERLAY_RULES`](src/evolved-directory.ts) lists, and turn tools off; a measurement whose overlay breaks these rules fails before any trial starts, and each trial loads a JSON copy of the checked entries.
2. **Policy patches** — frozen profile patches applied after the overlay: the trial's model rows, permissions, sandbox mode, and every row a candidate must not change. Trials run without a person, so the patches must grant the permissions the tasks need.
3. **Task suite** — a JSON file of tasks, each with a prompt, an optional starting workspace, a split (`evolve` or `heldout`), and checks: an `answer` pattern for the final response, a `file` pattern for a file the trial leaves, or a `command` that must exit 0 in the workspace. A trial's reward is the fraction of its checks that pass. [`src/suite.ts`](src/suite.ts) defines the format.
4. **Run spec** — a JSON file naming the suite, the evolved directory, the trial route, the operator variables trials receive, the route of the search roles, and `delta`, the noise band, as a number or `"calibrate"`. A spec that calibrates names `calibration.method`: `spread`, the largest difference between the baseline's repeated scores (the paper's definition), or `z`, `calibration.z` (default 2) deviations of the difference of two evaluations (the reference implementation's estimator, twice the spread on two evaluations). Omitted constants take the reference coding instance's values: 20 rounds, 2 candidates per round, 2 trials per task, and an edit budget annealed from 4 to 1. The cost rule allows 25% more tokens per additional passing trial (`selection.costPerPass`), the reference's rate whatever the suite's size; on its 178 trials that is β₁ = 44.5. [`src/spec.ts`](src/spec.ts) defines the format.

```json
{
  "name": "small-window",
  "suite": "suite.json",
  "evolvedDirectory": "harness/evolved",
  "trial": { "policyPatches": ["policy.patch.yml"], "provider": "deepseek", "model": "deepseek-v4-flash", "forwardEnv": ["DEEPSEEK_API_KEY"] },
  "roles": { "provider": "deepseek", "model": "deepseek-v4-pro" },
  "delta": "calibrate",
  "calibration": { "method": "spread" }
}
```

### Run it

```text
/self-improve baseline run.json
/self-improve calibrate run.json [repeats=2]
/self-improve round run.json [count=1]
/self-improve run run.json
/self-improve heldout run.json [trajectory index]
/self-improve status run.json
```

Every action except `status` starts a background job owned by the invoking agent; its output narrates each stage and its result reports the outcome. `baseline` measures the evolve branch's starting commit. `calibrate` measures that baseline again and stores the noise band a spec with `"delta": "calibrate"` uses, by the spec's `calibration.method`; each repeat costs one baseline measurement. `spread` needs at least one repeat; `z` with none bootstraps over the baseline's trials, a weaker estimate. `round` runs the next rounds, `run` runs every remaining round, and `heldout` measures the latest incumbent, or the given trajectory entry, on the held-out tasks.

Accepted candidates move the evolve branch, `self-improve/<name>` unless the spec names another. Compare a winner with `git diff <start> self-improve/<name> -- <evolved directory>`, and apply it yourself, for example by passing its overlay with `--patch`. The evolve branch must not be checked out anywhere.

### What a round does

1. The analyst reads the worst trial of the weakest tasks and the best trial of the strongest, and writes one report for the round.
2. Each candidate gets its own checkout of the incumbent. The proposer edits the evolved directory there and declares each edit's component and hypothesis. The edit budget, the overlay rules, the reviewer, and a reserved exploration slot screen the change, and rejections return to the proposer for a bounded number of repairs.
3. Each declared component is checked against the diff, the candidate is committed, and a smoke check confirms that it runs.
4. Fresh runtimes measure every screened candidate on the evolve tasks; a trial that produces no result scores 0 and counts in the denominator.
5. A candidate is admissible when its score is at least the best score so far minus the noise band, it passes the domain guards, and it meets the cost rule. A gain above the band may add tokens in proportion to the gain; within the band, only a token saving or a new structural component admits it. The highest admissible score wins.

The edit history, the prune set of components whose recent edits gained nothing, and a stall flag that reserves exploration slots for components the run never changed regularize the proposer's next drafts.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`/self-improve` composes a run from its spec and starts it as a background job. The run holds a lock on its directory, so two jobs never advance one run. Each stage stores its result before the next starts: an interrupted round resumes from its stored drafts and evaluations, and the history and trajectory are written together as the round's commit point before the evolve branch moves.

| Source | Responsibility |
|---|---|
| [`src/index.ts`](src/index.ts), [`src/command.ts`](src/command.ts) | The plugin entry, the command, run composition, and background jobs |
| [`src/loop.ts`](src/loop.ts) | Baseline, calibration, rounds, and held-out measurement |
| [`src/schedule.ts`](src/schedule.ts), [`src/history.ts`](src/history.ts), [`src/selection.ts`](src/selection.ts), [`src/calibrate.ts`](src/calibrate.ts) | Edit budget, history and directives, admissibility, noise band |
| [`src/critic.ts`](src/critic.ts), [`src/roles.ts`](src/roles.ts), [`src/model.ts`](src/model.ts) | Reviewer, analyst, proposer, and their model requests |
| [`src/domain.ts`](src/domain.ts), [`src/trial.ts`](src/trial.ts), [`src/suite.ts`](src/suite.ts) | Trials in fresh runtimes, checks, and token accounting |
| [`src/git.ts`](src/git.ts), [`src/directory.ts`](src/directory.ts) | Evolve branch, candidate checkouts, and run files |
| [`src/evolved-directory.ts`](src/evolved-directory.ts) | Component set, leakage patterns, and overlay rules of a dsh evolved directory |
| [`src/overlay.ts`](src/overlay.ts) | Overlay check and the proposer's statement of the rules |

Trials start through the SDK client, which spawns the runtime itself, the subprocess seam's documented exception for SDK-managed transports; git and check commands run through `ctx.subprocess` with inherited repository selectors cleared. Each trial gets a fresh workspace, Harness home, and agents home outside any repository.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [RRSI reference implementation](https://github.com/google-research/rrsi) — the algorithm this package reimplements, from "RRSI: Regularized Recursive Self-Improvement of Agent Harnesses" (arXiv 2609.24972).
- [Decision record](../../../.agents/notes/implemented/architecture/2026-10-20-self-improvement-of-harness-configuration.md) — why candidates evolve configuration, run in fresh runtimes, and start from a command.
- [SDK client](../../sdk/client/README.md) — the runtime each trial drives.
- [Background jobs](../../jobs/jobs/README.md) — job ownership, output, and cancellation.

-----

<a id="model-experience"></a>
## Model Experience

### Analyst request

#### What the model sees

One request per round outside any Session, with the system text below and one user message: the round, the incumbent's score and task count, the previous round's report or a note that none exists, and each evidence trial's trajectory. A trajectory lists user messages, assistant text, tool calls, tool results, and turn ends, each clipped to `trial.maxTraceCharacters` characters, then the outcome of each check.

##### Analyst system text

```markdown
You analyze how an agent harness performs on a task suite, so that another engineer can change the harness. The model that runs the harness is fixed; only the harness can change.

<the suite's analyst brief>

From the trajectories, report three things in plain text:

1. Failure modes: recurring ways the weak trajectories go wrong, ranked by how many tasks they affect, each with the tasks that show it and the moment in the trajectory where it starts.

2. Capability gaps: what the harness never gives the model (a tool, a piece of context, a check) that the failures needed.

3. Success habits: behaviors in the strong trajectories that a change must not break.

Name general mechanisms, never task-specific answers. When a previous report is given, keep its names for findings that recur.
```

#### Token effect

One request per round, with output bounded by `roles.maxOutputTokens`; the prompt grows with up to `failureTraces + successTraces` rendered trajectories.

#### KV Cache effect

An independent request; only the fixed system text can repeat across rounds.

### Proposer requests

#### What the model sees

One request per turn, including turns whose answer was not one JSON action. Each sends the system text below and one user message: the candidate's label and round, the edit budget, the exploration directive and any reserved slot, the prune set, the edit history, the analysis, the incumbent's mean reward per task, the evidence trials, the evolved directory's files, a rejected draft's reasons when repairing, and the interaction log of earlier actions and results, ending with `Reply with exactly one JSON action object.` One read returns at most `roles.maxReadCharacters` characters.

##### Proposer system text

```markdown
You improve an agent harness by editing its configuration files in your working directory. The model that runs the harness is fixed and differs from you: improve the harness for that model, using its trajectories as evidence of how it behaves. Only the files in your working directory can change; the tasks, the grader, and the model cannot.

<the overlay rules paragraph>

<the suite's proposer brief>

Reply with exactly one JSON object per turn and nothing else. Actions:
{"action": "list_files"}
{"action": "read_file", "path": "relative/path"}
{"action": "read_trace", "task": "<task id from the evidence list>"}
{"action": "edit_file", "path": "relative/path", "old": "exact text that occurs once", "new": "replacement"}
{"action": "write_file", "path": "relative/path", "content": "complete content of a new file"}
{"action": "done", "summary": "one line", "edits": [{"id": "E1", "component": "one of: prompt, control_flow, config, output_plumbing, context_mgmt, client_tool, skill, memory, subagent", "hypothesis": "one sentence: the mechanism and why it should raise the score"}]}

An edit is one independent change whose effect can be measured on its own; parts that only work together are one edit. Declare at most the edit budget the context gives. Name each edit's component from the list; it is checked against your changes. A candidate holding a reserved exploration slot must change at least one of the untried components it lists. Removing machinery listed under the prune set is a legitimate edit.

Never encode task names, task-specific values, or expected answers: the harness is scored on these tasks, and a reviewer rejects such changes before they are measured. There is no abort action: make the best change you can, then call done.
```

##### Overlay rules paragraph

```markdown
`overlay.patch.yml` is a YAML list of entries that change the harness configuration. An entry may set `config` for one of these entries, using only the listed keys: compaction-basic (thresholdRatio, headroomTokens, retainRatio, retainTokens, maxTokens, compactionRetries, maxOverflowRetries); tool-result-pruner (thresholdChars, headChars, tailChars); spill-policy (maxInlineTokens); system-prompt (includeHarnessIdentity, includeRuntimeContext, personaPrefix, personaSuffix, toolOrder); repeat-tool-reminder (thresholds, include, exclude, argumentsPreviewChars). An entry may also turn off a tool, an entry whose id starts with "tool-", with `disabled: true`. A `config` replaces that entry's whole configuration. Nothing else may appear in the file, and YAML tags, anchors, and aliases are not allowed.
```

#### Token effect

Up to `roles.proposerTurns` requests per draft, each repeating the context and the growing interaction log; each critic rejection starts a repair draft with the same limit.

#### KV Cache effect

Within one draft, each request repeats the previous request's text, without its final instruction line, as a prefix; drafts of different candidates share only the system text and the round's context.

### Critic request

#### What the model sees

For a diff that passes the deterministic patterns, the system text below and one user message with the candidate's summary, its declared edits as JSON, and the diff. A diff longer than `roles.maxDiffCharacters` is rejected without a request.

##### Critic system text

```markdown
You review one proposed change to an agent harness before the change is measured. The harness is improved against the same tasks it is scored on, so a change can raise the score by fitting those tasks instead of improving the harness. Your verdict decides whether the change is measured at all.

<the suite's critic brief>

Reject the change when any of these holds:

1. Task fitting: the change encodes knowledge of particular tasks in the suite, such as task names or ids, entity names, file names a task uses, expected outputs or answers, constants that only make sense for one task, or branches on features that identify a task. General working practice is acceptable. Ask whether the change would still make sense, and still help, on an unfamiliar task of the same kind from a different suite.

2. No effect or lost safety: the change has no effect while claiming a mechanism (dead code, an unused setting, comments only), or it removes or disables an existing safety mechanism (context compaction, output limits, error handling, termination guards) without a working replacement.

3. Grader gaming: the change reads, detects, reconstructs, or influences the grader at run time, encodes a threshold or reference value that could only come from a grader, or shapes the final output for the grader rather than for the task.

4. Undeclared changes: the diff contains a change that no declared edit covers, or one declared edit hides several independent mechanisms. Several declared edits in one change are allowed.

5. Run-time memorization: a memory, state, or skill mechanism persists or injects task-specific run-time data across trials, such as captured file contents, tool output, computed answers, task or entity names, or solutions keyed by task. Persisting general procedures without task entities is acceptable.

6. Unbounded work: an added check, retry, or improvement loop has no exit, or finishing waits for a confirmation that may never arrive. A bounded pass with an explicit exit is acceptable.

Otherwise accept. Judge intent and content, not style. Do not judge run-time correctness: you see only the diff, and later checks run the changed harness.

Reply with one JSON object and nothing else: {"verdict": "accept" or "reject", "reasons": ["..."], "riskNotes": ["..."]}
```

#### Token effect

One request per screened draft, and up to `roles.criticAttempts` when answers do not parse.

#### KV Cache effect

An independent request; the system text repeats for every candidate of a suite.

### Trial runtimes

#### What the model sees

The policy model sees an ordinary dsh Session in a fresh runtime of the spec's profile, `sdk` by default, with the checked entries of the candidate's overlay applied before the policy patches, its `AGENTS.md` as user-global instructions, its skills as user skills, and the task prompt as the first user message, in a fresh copy of the task's workspace. Instructions and skills of the operator's homes and repositories are absent.

#### Token effect

Each evaluation runs one Session tree per task and trial: a full reference run measures each task about 82 times (2 trials, once for the baseline and once for each of 40 candidates) plus smoke trials. A trial's cost is the exact turn totals of every Session in its runtime.

#### KV Cache effect

Every trial is an independent runtime; nothing carries between trials or into the operator's Sessions.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Only configuration evolves** — candidates change the overlay's listed settings, instructions, and skills; plugin code, other configuration, tool descriptions, and the agent loop stay out of reach.
- **Unattended trials** — the trial profile and the policy patches alone decide what a trial may do, and check commands run on the host through the subprocess provider. The dsh sandbox confines a trial's file writes, not its reads or network access.
- **Cost needs exact usage** — a trial whose turns cannot prove their token usage reports none; when no trial of an evaluation reports tokens, the cost change is 0 and the cost rule admits any gain above the band.
- **The incumbent is measured once** — candidates are compared with its stored evaluation, and the floor follows the best score so far, so an equally good harness clears it less often as a run proceeds.
- **One-measurement calibration** — a bootstrap over few trials per task misses run-to-run variance and underestimates the band; calibrate with repeats.
- **Few-repeat spread** — the `spread` of two or three evaluations is itself one noisy draw, and identical scores give a band of 0, which counts every gain as real.
- **Sequential candidates** — a round drafts and measures its candidates one after another; `trial.concurrency` parallelizes trials within one measurement.
- **Deferred reference parts** — per-task digests, the prediction scoreboard, and re-adjudication of stored rounds are not implemented.
- **Command only** — runs start from `/self-improve` in compositions with background jobs; there is no model tool.
- **No recorded-session snapshot** — the command's transcript, its `command/run` and `command/done` pair, has no recorded-session snapshot; the Web snapshot lane can record one. `tests/loader-composition.spec.ts` covers the command through a real composition, and `tests/real-runtime.e2e.ts` measures each trial in a fresh `dsh` runtime against a local stand-in model endpoint.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The selection rules, edit budget, history summaries, exploration, critic screen, and missing-trial accounting follow the reference implementation's rules, with original prompt text. The cosine budget reaches its minimum only at `round = rounds`, so the last round of a run can still bundle two edits, as in the reference.

</details>
