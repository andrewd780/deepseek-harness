---
description: "Improve a harness configuration by measured search: regularized recursive self-improvement over a task suite, with accepted candidates committed to an evolve branch, and an automatic mode that runs, applies, and schedules it."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-self-improve

English | [中文](README.zh.md)

## Summary

Run regularized recursive self-improvement (RRSI) on a directory of harness configuration: a profile overlay, user-global instructions, and skills. Each round, a model drafts edits from the incumbent's trajectories on a task suite, a reviewer rejects edits that fit the suite, and fresh dsh runtimes measure the rest. A candidate replaces the incumbent only when its score clears the noise floor and its gain pays for added tokens. `/self-improve` alone creates a starter run, runs every stage as one resumable background job, applies an accepted result to your configuration with a backup, and can repeat daily.

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

The runs directory, the trial scratch directory, process limits, and the automatic mode's settings are in the [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-self-improve).

### Run it automatically

`/self-improve` with no arguments, or `/self-improve auto`, does the whole job as one background job owned by the invoking session:

1. **Create the run.** On first use it creates the automatic run, a git repository at `<home>/self-improve/auto` (`auto.directory`), from a starter run bundled in the package, and commits it; an existing directory is never overwritten. The starter run holds `run.json`, `suite.json` with six practice (`evolve`) and two held-out Node.js coding tasks (fix a bug, add a test, refactor without changing behavior, follow a project's written rules), the seed `evolved/AGENTS.md`, and `policy.patch.yml`, which routes every trial to `auto.model` of `auto.provider` at `auto.baseUrl` with an `auto.contextWindow` window and keeps the sandbox at `workspace-write`. Each check is an inline `node` script, so a trial cannot edit its grader. The search roles call the same provider and model through your dsh configuration, which must list the model. The route, `auto.rounds`, and small-window limits (an edit history of 8, history diffs of 4,000 characters, 4,096 output tokens, trace payloads of 400 characters) are written into a new run; edit `run.json` to change an existing one.
2. **Run every stage the run has not finished.** The baseline; the noise band, by the spec's `calibration.method` with `auto.calibrationRepeats` more baseline measurements; every remaining round; the held-out tasks at both ends of the trajectory; the apply; and a summary. Each stage reads the run's stored state first, so a job stopped by a crash or a restart resumes where it stopped. The job's output narrates each stage, and its result is the summary: the scores before and after, each accepted candidate's own summary, the files of the evolved directory that changed, and whether and where the result was applied.
3. **Continue with a new generation.** Once a generation finished, the next `/self-improve` writes `run-<n>.json`, a copy of `run.json` named `<name>-<n>` whose evolve branch starts from the previous generation's result, and runs it the same way.

`/self-improve` while the automatic job runs says so and where to look; `/self-improve status` shows the generation, its stages and trajectory, the last summary, and the schedule; `/self-improve help` lists every form. Before starting a job, the command checks that the model runtime lists the run's search-role model, so an unlisted model fails at once instead of after the baseline.

### Apply a result and undo it

When a generation ends on an accepted candidate rather than its baseline and `autoApply` is on, the pipeline writes that candidate's evolved directory where dsh reads it. `/self-improve apply` does the same by hand for the newest generation with an accepted candidate, and `/self-improve apply <spec.json>` for the newest accepted candidate of any run.

| Part | Written to | How |
|---|---|---|
| `overlay.patch.yml` | `<home>/cordis.patch.yml`, or `overlayPatch` | The checked entries, between `# >>> dsh self-improve` and `# <<< dsh self-improve` lines |
| `AGENTS.md` | `<home>/AGENTS.md` | Between `<!-- >>> dsh self-improve` and `<!-- <<< dsh self-improve -->` lines, after your own text |
| `skills/<name>` | `<home>/skills/<name>` | Whole entries; entries an earlier apply wrote that the result lacks are removed |

`<home>` is the running profile's Harness home, `~/.dsh` by default, or `home`. The home patch layer applies after every profile's own `cordis.patch.yml`, the file dsh's plugin manager and settings pages write, so applied entries win and those editors never write into the managed section; the settings pages refuse to change an entry the home layer overrides. The apply checks the overlay against the overlay rules again and copies only regular files with the evolved directory's extensions. Before anything changes, it refuses when a managed section differs from what the newest apply wrote, or when a skill of the same name exists that no apply wrote. It copies each path it changes to `<home>/self-improve/backups/<time>/` with a `manifest.json` first.

New sessions use the applied configuration. dsh reloads its patch layers and watches skills while it runs, so an open session can pick up part of a change; start a new session to get all of it. `/self-improve undo` reverses the newest apply not yet undone: it restores the sections and skill directories that apply replaced, keeps what you wrote outside the sections since, and saves what it replaces to a `<time>-undo` backup first. The pipeline never applies an undone result again, and the next generation starts from the undone generation's baseline; `/self-improve apply` still applies it by hand. When an apply fails, the generation stays unfinished, and the next `/self-improve` retries the apply before anything else.

### Schedule the automatic mode

With the schedule on, a timer checks every `schedule.checkIntervalMinutes` minutes while dsh runs and starts the same pipeline when every check passes:

- **Time:** no run started since the most recent `schedule.time`, a local `HH:MM`, and at least `schedule.minIntervalHours` hours passed since the last start. A run missed at its time starts later, until the next start time or, with `schedule.windowHours` above 0, until that many hours after it.
- **No other job:** no self-improve job runs in this dsh process.
- **Memory room:** `vm_stat` reports at least `schedule.minFreeMemoryGiB` GiB of free, inactive, and speculative memory, the room macOS can give a model load without swapping.
- **Owner:** a background job belongs to a session, so scheduled jobs belong to the session that ran `/self-improve schedule on`; when the plugin settings turned the schedule on, the first session that runs any `/self-improve` command claims it. That session must be open when a run is due.

A due check that cannot start records why in `<home>/self-improve/schedule.json` and tries again on the next tick. `/self-improve schedule on [HH:MM]`, `/self-improve schedule off`, and `/self-improve schedule status` change and show the schedule; the command's choice overrides `schedule.enabled` and `schedule.time`. The automatic mode's settings at their defaults:

```yaml
- id: self-improve
  name: '@deepseek-ai/dsh-experimental-self-improve'
  config:
    sandboxChecks: true
    autoApply: true
    auto:
      provider: ollama
      model: qwen38-27b-abliterated-mlx-q4:latest
      baseUrl: http://localhost:11434/v1
      contextWindow: 32768
      rounds: 3
      calibrationRepeats: 1
    schedule:
      enabled: false
      time: '03:00'
      minIntervalHours: 20
      minFreeMemoryGiB: 22
      windowHours: 0
      checkIntervalMinutes: 5
```

### Prepare a run

A run uses four kinds of files in a git repository:

1. **Evolved directory** — a tracked directory, outside the runs directory, holding any of `overlay.patch.yml` (a profile patch every trial applies before the policy patches), `AGENTS.md` (copied into each trial's Harness home as user-global instructions), and `skills/` (copied there as user skills). The overlay may only set the compaction, tool-result pruning, output spilling, system prompt, and repeated-tool reminder settings that [`DSH_OVERLAY_RULES`](src/evolved-directory.ts) lists, and turn tools off; a measurement whose overlay breaks these rules fails before any trial starts, and each trial loads a JSON copy of the checked entries.
2. **Policy patches** — frozen profile patches applied after the overlay: the trial's model rows, permissions, sandbox mode, and every row a candidate must not change. Trials run without a person, so the patches must grant the permissions the tasks need.
3. **Task suite** — a JSON file of tasks, each with a prompt, an optional starting workspace, a split (`evolve` or `heldout`), and checks: an `answer` pattern for the final response, a `file` pattern for a file the trial leaves, or a `command` that must exit 0 in the workspace. A trial's reward is the fraction of its checks that pass. [`src/suite.ts`](src/suite.ts) defines the format. With `sandboxChecks` on, the default, every `command` runs under macOS `sandbox-exec`: it may write only inside the trial's workspace and the trial's own temporary directory, which is its `TMPDIR`, and it has no network; reads and starting processes work as usual. When `sandbox-exec` is missing or reports a failure of its own, the trial is marked errored with the reason and the measurement stops, instead of running the check unconfined. A failed `command` check keeps one line of its standard error in the trial's `result.json`.
4. **Run spec** — a JSON file naming the suite, the evolved directory, the trial route, the operator variables trials receive, the route of the search roles, and `delta`, the noise band, as a number or `"calibrate"`. A spec that calibrates names `calibration.method`: `spread`, the largest difference between the baseline's repeated scores (the paper's definition), or `z`, `calibration.z` (default 2) deviations of the difference of two evaluations (the reference implementation's estimator, twice the spread on two evaluations). Omitted constants take the reference coding instance's values: 20 rounds, 2 candidates per round, 2 trials per task, and an edit budget annealed from 4 in the first round to 1 in the last. The cost rule allows 25% more tokens per additional passing trial (`selection.costPerPass`), the reference's rate whatever the suite's size; on its 178 trials that is β₁ = 44.5. [`src/spec.ts`](src/spec.ts) defines the format.

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
/self-improve apply run.json
```

`baseline`, `calibrate`, `round`, `run`, and `heldout` start a background job owned by the invoking agent; its output narrates each stage and its result reports the outcome. `baseline` measures the evolve branch's starting commit. `calibrate` measures that baseline again and stores the noise band a spec with `"delta": "calibrate"` uses, by the spec's `calibration.method`; each repeat costs one baseline measurement. `spread` needs at least one repeat; `z` with none bootstraps over the baseline's trials, a weaker estimate. `round` runs the next rounds, `run` runs every remaining round, and `heldout` measures the latest incumbent, or the given trajectory entry, on the held-out tasks.

Accepted candidates move the evolve branch, `self-improve/<name>` unless the spec names another. Compare a winner with `git diff <start> self-improve/<name> -- <evolved directory>`, and apply it with `/self-improve apply run.json`, which works as the automatic apply does. The evolve branch must not be checked out anywhere.

### What a round does

1. The analyst reads the worst trial of the weakest tasks and the best trial of the strongest, and writes one report for the round.
2. Each candidate gets its own checkout of the incumbent. The proposer edits the evolved directory there and declares each edit's component and hypothesis. The edit budget, the overlay rules, the reviewer, and a reserved exploration slot screen the change, and rejections return to the proposer for a bounded number of repairs.
3. Each declared component is checked against the diff, the candidate is committed, and a smoke check confirms that it runs.
4. Fresh runtimes measure every screened candidate on the evolve tasks; a trial that produces no result scores 0 and counts in the denominator.
5. A candidate is admissible when its score is at least the best score so far minus the noise band, it passes the domain guards, and it meets the cost rule. A gain above the band may add tokens in proportion to the gain; within the band, only a token saving or a new structural component admits it. The highest admissible score wins.

The edit history, the prune set of components whose recent edits gained nothing, and a stall flag that reserves exploration slots for components the run never changed regularize the proposer's next drafts. The history the proposer sees holds every measured candidate: each edit's component and hypothesis, the candidate's source diff, its score and cost changes, and whether it was accepted; a candidate stopped before measurement stays out of it. The prune set lists each component's accepted candidates with their diffs.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`/self-improve` composes a run from its spec and starts it as a background job. The run holds a lock on its directory, so two jobs never advance one run. Each stage stores its result before the next starts: an interrupted round resumes from its stored drafts and evaluations, and the history and trajectory are written together as the round's commit point before the evolve branch moves. The automatic pipeline adds a generation's record, `auto.json` in its run directory, once the apply settled; a generation without one is unfinished.

| Source | Responsibility |
|---|---|
| [`src/index.ts`](src/index.ts), [`src/command.ts`](src/command.ts) | The plugin entry, the command, run composition, and background jobs |
| [`src/auto.ts`](src/auto.ts), [`src/bootstrap.ts`](src/bootstrap.ts), [`src/template.ts`](src/template.ts) | The automatic pipeline, its generations and summary, and the starter run it creates |
| [`src/apply.ts`](src/apply.ts) | Apply, backups, and undo against the live configuration |
| [`src/auto-schedule.ts`](src/auto-schedule.ts) | The daily schedule, its checks, and its state file |
| [`src/loop.ts`](src/loop.ts) | Baseline, calibration, rounds, and held-out measurement |
| [`src/schedule.ts`](src/schedule.ts), [`src/history.ts`](src/history.ts), [`src/selection.ts`](src/selection.ts), [`src/calibrate.ts`](src/calibrate.ts) | Edit budget, history and directives, admissibility, noise band |
| [`src/critic.ts`](src/critic.ts), [`src/roles.ts`](src/roles.ts), [`src/model.ts`](src/model.ts) | Reviewer, analyst, proposer, and their model requests |
| [`src/domain.ts`](src/domain.ts), [`src/trial.ts`](src/trial.ts), [`src/suite.ts`](src/suite.ts) | Trials in fresh runtimes, checks, and token accounting |
| [`src/check-sandbox.ts`](src/check-sandbox.ts) | The `sandbox-exec` policy of check commands, and the refusal to grade without it |
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

One request per turn, including turns whose answer was not one JSON action. Each sends the system text below and one user message: the candidate's label and round, the edit budget, the exploration directive and any reserved slot, the prune set with each accepted candidate's source diff, the edit history of measured candidates with their source diffs, the analysis, the incumbent's mean reward per task, the evidence trials, the evolved directory's files, a rejected draft's reasons when repairing, and the interaction log of earlier actions and results, ending with `Reply with exactly one JSON action object.` One read returns at most `roles.maxReadCharacters` characters. Each source diff shows at most `roles.maxHistoryDiffCharacters` characters, by default `roles.maxDiffCharacters`, the longest diff the critic reviews, so every measured candidate's diff shows whole.

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

Up to `roles.proposerTurns` requests per draft, each repeating the context and the growing interaction log; each critic rejection starts a repair draft with the same limit. The context grows over a run: the history repeats up to `historyLimit` edit records with their candidates' source diffs, and the prune set repeats its accepted candidates' diffs, each diff up to `roles.maxHistoryDiffCharacters` characters; lower both for a small context window.

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

2. Inert machinery: the change adds machinery that has no effect while claiming a mechanism, such as dead code, an unused setting, or comments only.

3. Grader gaming: the change reads, detects, reconstructs, or influences the grader at run time, encodes a threshold or reference value that could only come from a grader, or shapes the final output for the grader rather than for the task.

4. Undeclared changes: the diff contains a change that no declared edit covers, or one declared edit hides several independent mechanisms. Several declared edits in one change are allowed.

5. Run-time memorization: a memory, state, or skill mechanism persists or injects task-specific run-time data across trials, such as captured file contents, tool output, computed answers, task or entity names, or solutions keyed by task. Persisting general procedures without task entities is acceptable.

Otherwise accept. The review targets suite-specific content, not particular harness components: a generic improvement to a prompt or a tool description is a valid change. Judge intent and content, not style. Do not judge run-time correctness: you see only the diff, and later checks run the changed harness.

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

### Applied configuration

#### What the model sees

After an apply, the operator's own Sessions see the result as ordinary configuration: the managed section of the user-global `AGENTS.md`, its two HTML comment marker lines included, among the user-global instructions; the applied skills in the user skill catalog; and the settings the overlay's entries change. Nothing else the plugin writes reaches a model.

#### Token effect

The applied instructions and skill descriptions add their text to every Session's instructions and skill catalog, plus about 40 tokens of section markers; overlay settings change what they govern, such as when compaction runs.

#### KV Cache effect

A changed instructions section or skill catalog changes the system-level prefix of Sessions that load it, so a Session started after an apply builds a new prefix cache; an open Session that reloads the change does so on its next request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Only configuration evolves** — candidates change the overlay's listed settings, instructions, and skills; plugin code, other configuration, tool descriptions, and the agent loop stay out of reach.
- **Unattended trials** — the trial profile and the policy patches alone decide what a trial may do. The dsh sandbox confines a trial's file writes, not its reads or network access, and `sandbox-exec` confines a check's writes and network, not its reads. `sandbox-exec` exists only on macOS, so elsewhere grading is refused unless `sandboxChecks` is off, which runs checks, and the trial-written code they import and test, unconfined on the host.
- **Applied overlays are measured elsewhere** — trials measure an overlay on the trial profile, `sdk` by default, while an apply writes it into the home patch layer of every profile. An entry a profile composes per agent preset, such as compaction or a tool in the Web and desktop profiles, may meet only a disabled host row and change nothing, and a `config` replaces the whole configuration a profile's bundles give that entry, such as the system prompt's persona prefix. The summary names every overlay entry an apply writes.
- **Auto-apply follows the run's rule** — the pipeline applies any final incumbent that is an accepted candidate, including one accepted within the noise band for a token saving or a new structural component; the held-out scores are reported, not used to decide.
- **Generations start fresh** — each generation measures its baseline again and starts with an empty edit history and prune set.
- **Cost needs exact usage** — a trial whose turns cannot prove their token usage reports none; when no trial of an evaluation reports tokens, the cost change is 0 and the cost rule admits any gain above the band.
- **The incumbent is measured once** — candidates are compared with its stored evaluation, and the floor follows the best score so far, so an equally good harness clears it less often as a run proceeds.
- **One-measurement calibration** — a bootstrap over few trials per task misses run-to-run variance and underestimates the band; calibrate with repeats.
- **Few-repeat spread** — the `spread` of two or three evaluations is itself one noisy draw, and identical scores give a band of 0, which counts every gain as real.
- **Sequential candidates** — a round drafts and measures its candidates one after another; `trial.concurrency` parallelizes trials within one measurement.
- **Deferred reference parts** — per-task digests, the prediction scoreboard, and re-adjudication of stored rounds are not implemented.
- **Command only** — runs start from `/self-improve` or the schedule it turns on, in compositions with background jobs; there is no model tool.
- **Scheduled runs need their owner** — a scheduled job belongs to its owner session, so the schedule waits while that session has no live agent in the dsh process, and disposing that agent cancels a running job.
- **No recorded-session snapshot** — the command's transcript, its `command/run` and `command/done` pair, has no recorded-session snapshot; the Web snapshot lane can record one. `tests/loader-composition.spec.ts` covers the command through a real composition, including the automatic pipeline on the starter run, and `tests/real-runtime.e2e.ts` measures each trial in a fresh `dsh` runtime against a local stand-in model endpoint.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The selection rules, history summaries, exploration, and missing-trial accounting follow the reference implementation's rules, with original prompt text. Where the paper's text and the reference differ, the package follows the text: the proposer's history carries each measured candidate's source diff and leaves out candidates stopped before measurement (Eq. 10), the prune set carries the accepted candidates' diffs (D.2), the edit budget's cosine runs to the last round so that round gets the minimum (Eq. 4 as printed, with t/T over rounds 0 to T − 1, ends one above it), and the critic rejects only the paper's grounds: suite-specific content, including grader gaming and run-time memorization, inert machinery, and changes the declared edits do not cover.

</details>
