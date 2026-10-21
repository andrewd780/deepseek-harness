# RRSI local run kit

Working files for running `/self-improve` against a local Ollama model on your own machine: a smoke of the self-improvement loop with 3 evolve tasks, 1 held-out task, 1 round, 1 candidate, and 1 trial per task (11 trials, 3 of them measuring the noise band). Every trial is a fresh `dsh` runtime routed to your Ollama server. Remove this directory before proposing the work upstream.

## Before you start

- Your rule: model loads happen only on the Air, under the watchdog. Ollama serving the model is a model load, so run this there, not on the work Mac. Build there too, with Ollama stopped: the build compiles the whole repository, and its memory use is unmeasured.
- Trials run a model's shell commands on the machine. The plugin rejects any candidate overlay that could load a plugin, start a process, or change the sandbox, and `policy.patch.yml` keeps the sandbox at `workspace-write`, so a trial can write only inside its own workspace and the temporary area. Reads and network access are not confined: keep files you would not show the model off that machine, or run the kit as a separate macOS user.
- Ollama running, with the model pulled and served at the 32k window you already use with dsh (`OLLAMA_CONTEXT_LENGTH=32768`, or `num_ctx` in a Modelfile). Note the model tag from `ollama list`.
- Node `^22.19 || >=24` and pnpm, as for any dsh checkout.

## 1. Get the code

PR #2 holds the plugin; PR #1 holds the small-window fixes a 32k Ollama window needs (the served-window probe and derived compaction headroom). They merge cleanly: the merged tree passed the 8 generated-file gates, 880 package tests, and the end-to-end test.

```sh
git fetch origin
git switch -c rrsi-local origin/claude/self-improve-a7gjrz
git merge origin/claude/deepskee-context-limit-a7gjrz
pnpm install
pnpm run verify-third-party-notices
pnpm run build
```

`verify-third-party-notices` is the check the cloud session could not run (it needs every dependency installed); it must pass before this work goes upstream. `pnpm dsh web` serves the built Web client, so the build comes first.

## 2. Make the run repository

```sh
cp -R .claude/plans/2026-10-21-rrsi-local-kit/run-repo ~/rrsi-local
cd ~/rrsi-local
```

Edit before the first commit:

- `policy.patch.yml` and `run.json`: replace `YOUR_OLLAMA_MODEL` with your model tag. This route is the only one a trial sees: each trial starts with a fresh Harness home.
- `run.json` `roles`: replace `YOUR_ROLE_PROVIDER` and `YOUR_ROLE_MODEL` with the provider key and model id of a route you already use in dsh. The analyst, proposer, and critic run in your dsh host, which reads your saved routes; they sit in a `- id: llm-pi-ai` row of `~/.dsh/profiles/web/cordis.patch.yml` or `~/.dsh/cordis.patch.yml`, under `providers`. Do not add that route to the mount patch: a later layer's `config` replaces an earlier one, so it would hide your saved routes for the session.

```sh
git init -q && git add . && git commit -qm "self-improve local smoke"
```

## 3. Start dsh with the plugin mounted

From the dsh checkout, launch from source; the mount names the plugin's TypeScript entry, which a built `dsh` cannot load. `--patch` must come right after `web`, before any web option such as `--no-open`.

```sh
pnpm dsh web --patch .claude/plans/2026-10-21-rrsi-local-kit/mount.patch.yml
```

## 4. Run it

In the Web UI, open `~/rrsi-local` as the workspace, then type in a session:

```text
/self-improve status run.json
/self-improve baseline run.json
/self-improve calibrate run.json 1
/self-improve round run.json
/self-improve heldout run.json
/self-improve status run.json
```

Every action except `status` runs as a background job; its result appears when the job finishes. Start the next action after the previous one finishes.

## 5. Read the results

- `status` lists each incumbent with its score, measured token cost, and commit.
- An accepted candidate moves `self-improve/local-smoke`: `git diff main self-improve/local-smoke -- evolved` shows the edit. Your `main` and working tree never change.
- `.agents/self-improve/local-smoke/` keeps `history.jsonl`, each trial's `record.json` and `result.json`, each draft's model interaction, and each critic verdict.

## What to expect

- Each task moves the score by 0.33. The noise band δ is measured, not chosen, as the paper's E.1 requires: `calibrate run.json 1` repeats the baseline once, and δ is how far apart the two scores land (0 when they match). Above δ a gain must pay for its extra tokens, 25% per additional passing trial; within δ only a token saving or a new structural component admits a candidate. A smoke that ends with "no admissible candidate" is still a complete run.
- `historyLimit` 8 and `roles.maxHistoryDiffCharacters` 4000 keep the proposer's history of past candidates and their diffs inside a 32k window once `rounds` is above 1. They shorten what the paper's proposer sees, so raise them on a larger window.
- Wall time depends on the model: 11 trials plus the role requests.
- Locally, tokens cost time, not money; the 1M-token ceiling was set for the DeepSeek route.
- What was verified without a real model: the run files parse with the plugin's own loaders, both patches compose (`--dump-config`), the mount imports the plugin from source (a planted wrong path fails to import), the policy patch holds the sandbox at `workspace-write` even under an overlay that sets `danger-full-access`, and the loop measures real `dsh` runtimes end to end against a stand-in model (`tests/real-runtime.e2e.ts`). This kit's run on your model is the first real-model run.
