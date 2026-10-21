# Agent Note: Self-improvement evolves harness configuration measured in fresh runtimes

Status: implemented

English | [中文](2026-10-20-self-improvement-of-harness-configuration.zh.md)

## Problem

Regularized recursive self-improvement (RRSI, arXiv 2609.24972) improves an agent harness by search: a model proposes edits, and edits that measurably raise the score on a task suite are kept. Its [reference implementation](https://github.com/google-research/rrsi) evolves a Python agent scaffold kept in its own repository, measures it on Terminal-Bench through containers, and calls its search roles through one cloud provider. None of that runs in a dsh composition, and an accepted change to dsh would still need porting by hand into packages that carry full coverage, snapshot, and documentation obligations. The search also measures on the same tasks it optimizes, so without the reference's regularizers a run accepts noise, edits that fit the suite, and machinery that never pays for its tokens.

## Decision

`@deepseek-ai/dsh-experimental-self-improve` reimplements the reference loop in TypeScript and evolves a directory of dsh configuration: a profile overlay, user-global `AGENTS.md`, and skills, tracked in the operator's repository. Each candidate is a branch with its own git checkout; accepted candidates fast-forward an evolve branch and never change the operator's working tree or live configuration. A trial runs one task in a fresh `dsh` runtime started through the SDK client, with the candidate's overlay applied before frozen policy patches and a fresh workspace, Harness home, and agents home outside any repository; the task's checks score it, and its cost is the exact turn usage of every Session in the runtime. The analyst, proposer, and critic call `ctx.llm` outside any Session, and the run directory keeps every draft's model interaction and every verdict. Runs start only from the `/self-improve` command, as background jobs owned by the invoking agent. The [package README](../../../../packages/experimental/self-improve/README.md) owns the operational rules.

## Alternatives considered

**Run the reference implementation with a dsh adapter.** Rejected as the implementation: it keeps the single-provider search roles, the benchmark containers, and an evolved copy outside this repository, and its accepted diffs still need porting. An adapter remains the route for reproducing the paper's Terminal-Bench measurements.

**Evolve TypeScript sources.** Rejected for now: every candidate would need a build and the full gates before measurement, estimated at 15 to 40 minutes each, and an accepted change still carries every package obligation. Configuration changes ship as an overlay the operator applies.

**Measure candidates as in-process subagents.** Rejected: in-process children share the host process, its services, and the parent's preset, so a candidate's overlay cannot apply, and their results carry no token usage.

**Run the proposer and analyst as spawned subagents.** Deferred: subagents record their requests in Session logs and bring the harness's file tools, but a run would need a live parent agent for hours and an activation lifecycle for structured output. The JSON action protocol keeps the proposer inside the candidate's evolved directory with a bounded number of requests.

**Expose a model tool.** Rejected: a tool would let a model start runs costing thousands of trials and add schema tokens to every request; the command keeps starting a run an operator decision.

## Consequences

A run can tune dsh for the operator's own task suite, model route, and context window, including a small local window, because the spec supplies the trial route and patches. Improvements are limited to what configuration expresses. Every candidate costs a full measurement of the evolve tasks: at the reference constants, about 82 trials per task over a run. The search roles' requests are kept in the run directory, not a Session log, because they run outside any Session. Whether dsh reaches gains like the reference's is unmeasured: the reference reported them for other policies and harnesses.

## Testing

Unit specs cover the selection arithmetic, edit budget, history summaries, calibration, critic, the proposer's action protocol and its path checks, suite validation and checks, the git store against real repositories, run-directory validation, and the loop's gates and resume; trials run against the SDK client's scripted runtime. `loader-composition.spec.ts` boots the plugin through the Loader with commands, background jobs, a real subprocess provider, and a scripted model, measures a baseline, accepts a new skill in a round, and asserts the evolve branch, the history, the held-out score, and that disposing the plugin removes the command.
