---
description: "通过度量搜索改进 harness 配置：在任务集上进行正则化递归自我改进，被接受的候选提交到 evolve 分支。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-self-improve

[English](README.md) | 中文

## 概述

对一个 harness 配置目录运行正则化递归自我改进（RRSI）：profile overlay、用户全局指令和 skills。每一轮中，模型分析当前最优版本（incumbent）在你提供的任务集上的轨迹并起草候选修改，审查者拒绝那些贴合任务集而非改进 harness 的修改，全新的 dsh 运行时度量其余每个候选。只有当候选的分数越过噪声下限、且度量到的增益足以支付新增的 token 时，它才会取代 incumbent。被接受的候选是你仓库中 evolve 分支上的提交；是否应用由你决定。

## 目录

- [使用本包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [深入探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 挂载命令

在已提供 `llm`、`subprocess`、`workingDirectory` 和 `commands` 的 composition 中挂载本插件，并同时挂载后台任务及其控制器：

```yaml
- name: '@deepseek-ai/dsh-jobs-local'
- name: '@deepseek-ai/dsh-tool-jobs'
- name: '@deepseek-ai/dsh-experimental-self-improve'
```

运行目录、试验临时目录和进程限制见[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-experimental-self-improve)。

### 准备一次运行

一次运行使用 git 仓库中的四类文件：

1. **演化目录** — 一个受跟踪、位于运行目录之外的目录，可包含 `overlay.patch.yml`（每次试验在策略补丁之前应用的 profile 补丁）、`AGENTS.md`（复制到每次试验的 Harness home，作为用户全局指令）和 `skills/`（复制到同一位置作为用户 skills）。overlay 只能设置 [`DSH_OVERLAY_RULES`](src/evolved-directory.ts) 列出的压缩、工具结果修剪、输出溢出、系统提示词和重复工具提醒设置，以及关闭工具；overlay 违反这些规则的度量会在任何试验启动之前失败，每次试验加载的是已检查条目的 JSON 副本。
2. **策略补丁** — 在 overlay 之后应用的冻结 profile 补丁：试验的模型配置行、权限、沙箱模式，以及候选不得修改的每一行。试验在无人值守下运行，因此补丁必须授予任务所需的权限。
3. **任务集** — 一个 JSON 任务文件，每个任务包含提示词、可选的起始工作区、划分（`evolve` 或 `heldout`）和检查：对最终回复的 `answer` 模式、对试验留下的文件的 `file` 模式，或必须在工作区中以 0 退出的 `command`。试验的奖励是其通过的检查所占比例。格式由 [`src/suite.ts`](src/suite.ts) 定义。
4. **运行 spec** — 一个 JSON 文件，指明任务集、演化目录、试验路由、试验接收的操作者环境变量、搜索角色的路由，以及噪声带 `delta`：一个数值或 `"calibrate"`。需要校准的 spec 须指明 `calibration.method`：`spread` 取 baseline 重复度量分数之间的最大差值（论文的定义），`z` 取两次度量之差的 `calibration.z`（默认 2）个偏差（参考实现的估计量，在两次度量上等于差值的两倍）。省略的常量取参考编码实例的值：20 轮、每轮 2 个候选、每个任务 2 次试验，编辑预算从第一轮的 4 退火到最后一轮的 1。成本规则对每多通过一次试验允许增加 25% 的 token（`selection.costPerPass`），无论任务集大小都沿用参考实现的这一比率；在参考实现的 178 次试验上即 β₁ = 44.5。格式由 [`src/spec.ts`](src/spec.ts) 定义。

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

### 运行

```text
/self-improve baseline run.json
/self-improve calibrate run.json [repeats=2]
/self-improve round run.json [count=1]
/self-improve run run.json
/self-improve heldout run.json [trajectory index]
/self-improve status run.json
```

除 `status` 外，每个动作都会启动一个由调用 agent 拥有的后台任务；任务输出逐阶段说明进展，其结果报告结论。`baseline` 度量 evolve 分支的起始提交。`calibrate` 再次度量该 baseline，并按 spec 的 `calibration.method` 保存 `"delta": "calibrate"` 的 spec 所使用的噪声带；每次重复花费一次 baseline 度量。`spread` 至少需要一次重复；`z` 在没有重复时基于 baseline 的试验做 bootstrap，估计较弱。`round` 运行接下来的若干轮，`run` 运行所有剩余轮次，`heldout` 在 held-out 任务上度量最新的 incumbent 或指定的轨迹条目。

被接受的候选会移动 evolve 分支，除非 spec 另行命名，否则为 `self-improve/<name>`。用 `git diff <start> self-improve/<name> -- <evolved directory>` 比较胜出者，并自行应用它，例如用 `--patch` 传入其 overlay。evolve 分支不得在任何地方被检出。

### 一轮做什么

1. analyst 阅读最弱任务中最差的试验和最强任务中最好的试验，为本轮写一份报告。
2. 每个候选获得 incumbent 的独立检出目录。proposer 在其中编辑演化目录，并声明每项修改的组件和假设。编辑预算、overlay 规则、审查者和保留的探索名额会筛查该修改，被拒绝的修改退回 proposer 进行有限次数的修复。
3. 每个声明的组件都会依据 diff 核对，然后提交候选，并由冒烟检查确认它能运行。
4. 全新运行时在 evolve 任务上度量每个通过筛查的候选；没有产出结果的试验记为 0 分并计入分母。
5. 当候选分数不低于迄今最佳分数减去噪声带、通过领域守卫并满足成本规则时，它才是可接受的。高于噪声带的增益可按增益比例增加 token；在噪声带内，只有节省 token 或新增结构性组件才能使其被接受。可接受候选中分数最高者胜出。

编辑历史、剪枝集（近期修改没有带来增益的组件），以及在停滞时为本次运行从未修改过的组件保留探索名额的停滞标志，会正则化 proposer 之后的草稿。proposer 看到的历史包含每个已度量的候选：每项修改的组件和假设、候选的源 diff、分数与成本变化，以及是否被接受；在度量前即被拦下的候选不进入历史。剪枝集列出每个组件被接受的候选及其 diff。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节 — 点击展开</summary>

`/self-improve` 依据 spec 组装一次运行，并作为后台任务启动它。运行会锁定其目录，因此两个任务永远不会同时推进同一次运行。每个阶段在下一阶段开始前保存其结果：被中断的一轮会从已保存的草稿和度量结果恢复，历史与轨迹作为本轮的提交点一起写入，然后 evolve 分支才会移动。

| 源文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts)、[`src/command.ts`](src/command.ts) | 插件入口、命令、运行组装与后台任务 |
| [`src/loop.ts`](src/loop.ts) | baseline、校准、轮次与 held-out 度量 |
| [`src/schedule.ts`](src/schedule.ts)、[`src/history.ts`](src/history.ts)、[`src/selection.ts`](src/selection.ts)、[`src/calibrate.ts`](src/calibrate.ts) | 编辑预算、历史与指令、可接受性、噪声带 |
| [`src/critic.ts`](src/critic.ts)、[`src/roles.ts`](src/roles.ts)、[`src/model.ts`](src/model.ts) | 审查者、analyst、proposer 及其模型请求 |
| [`src/domain.ts`](src/domain.ts)、[`src/trial.ts`](src/trial.ts)、[`src/suite.ts`](src/suite.ts) | 全新运行时中的试验、检查与 token 统计 |
| [`src/git.ts`](src/git.ts)、[`src/directory.ts`](src/directory.ts) | evolve 分支、候选检出目录与运行文件 |
| [`src/evolved-directory.ts`](src/evolved-directory.ts) | dsh 演化目录的组件集合、泄漏模式与 overlay 规则 |
| [`src/overlay.ts`](src/overlay.ts) | overlay 检查，以及向 proposer 陈述的规则 |

试验通过 SDK client 启动，由它自行派生运行时，这是 subprocess seam 为 SDK 管理的传输所记录的例外；git 和检查命令通过 `ctx.subprocess` 运行，并清除继承的仓库选择变量。每次试验都获得位于任何仓库之外的全新工作区、Harness home 和 agents home。

</details>

-----

<a id="further-exploration"></a>
## 深入探索

- [RRSI 参考实现](https://github.com/google-research/rrsi) — 本包重新实现的算法，出自 “RRSI: Regularized Recursive Self-Improvement of Agent Harnesses”（arXiv 2609.24972）。
- [决策记录](../../../.agents/notes/implemented/architecture/2026-10-20-self-improvement-of-harness-configuration.zh.md) — 为什么候选演化配置、在全新运行时中运行，并从命令启动。
- [SDK client](../../sdk/client/README.zh.md) — 每次试验驱动的运行时。
- [后台任务](../../jobs/jobs/README.zh.md) — 任务归属、输出与取消。

-----

<a id="model-experience"></a>
## 模型体验

### Analyst 请求

#### 模型看到什么

每轮在任何 Session 之外发出一个请求，带有下方的系统文本和一条用户消息：轮次、incumbent 的分数与任务数、上一轮的报告或不存在报告的说明，以及每个证据试验的轨迹。轨迹列出用户消息、助手文本、工具调用、工具结果和轮次结束，每项截断为 `trial.maxTraceCharacters` 个字符，随后是每项检查的结果。

##### Analyst 系统文本

```markdown
You analyze how an agent harness performs on a task suite, so that another engineer can change the harness. The model that runs the harness is fixed; only the harness can change.

<the suite's analyst brief>

From the trajectories, report three things in plain text:

1. Failure modes: recurring ways the weak trajectories go wrong, ranked by how many tasks they affect, each with the tasks that show it and the moment in the trajectory where it starts.

2. Capability gaps: what the harness never gives the model (a tool, a piece of context, a check) that the failures needed.

3. Success habits: behaviors in the strong trajectories that a change must not break.

Name general mechanisms, never task-specific answers. When a previous report is given, keep its names for findings that recur.
```

#### Token 影响

每轮一个请求，输出受 `roles.maxOutputTokens` 限制；提示词随至多 `failureTraces + successTraces` 条渲染后的轨迹增长。

#### KV Cache 影响

独立请求；只有固定的系统文本可能在各轮之间重复。

### Proposer 请求

#### 模型看到什么

每回合一个请求，包括回答不是单个 JSON 动作的回合。每个请求发送下方的系统文本和一条用户消息：候选的标签与轮次、编辑预算、探索指令及任何保留名额、附带每个被接受候选源 diff 的剪枝集、附带源 diff 的已度量候选编辑历史、分析报告、incumbent 各任务的平均奖励、证据试验、演化目录中的文件、修复时被拒草稿的原因，以及之前动作和结果的交互日志，并以 `Reply with exactly one JSON action object.` 结尾。一次读取最多返回 `roles.maxReadCharacters` 个字符。每个源 diff 最多显示 `roles.maxHistoryDiffCharacters` 个字符，默认等于 critic 审阅的最长 diff `roles.maxDiffCharacters`，因此每个已度量候选的 diff 都会完整显示。

##### Proposer 系统文本

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

##### overlay 规则段落

```markdown
`overlay.patch.yml` is a YAML list of entries that change the harness configuration. An entry may set `config` for one of these entries, using only the listed keys: compaction-basic (thresholdRatio, headroomTokens, retainRatio, retainTokens, maxTokens, compactionRetries, maxOverflowRetries); tool-result-pruner (thresholdChars, headChars, tailChars); spill-policy (maxInlineTokens); system-prompt (includeHarnessIdentity, includeRuntimeContext, personaPrefix, personaSuffix, toolOrder); repeat-tool-reminder (thresholds, include, exclude, argumentsPreviewChars). An entry may also turn off a tool, an entry whose id starts with "tool-", with `disabled: true`. A `config` replaces that entry's whole configuration. Nothing else may appear in the file, and YAML tags, anchors, and aliases are not allowed.
```

#### Token 影响

每份草稿至多 `roles.proposerTurns` 个请求，每个请求重复上下文和不断增长的交互日志；每次 critic 拒绝都会启动一份具有相同上限的修复草稿。上下文随运行增长：历史重复至多 `historyLimit` 条修改记录及其候选的源 diff，剪枝集重复其被接受候选的 diff，每个 diff 至多 `roles.maxHistoryDiffCharacters` 个字符；上下文窗口较小时应调低这两项。

#### KV Cache 影响

在同一份草稿内，每个请求把上一个请求的文本（去掉最后的指令行）作为前缀重复；不同候选的草稿只共享系统文本和本轮上下文。

### Critic 请求

#### 模型看到什么

对于通过确定性模式检查的 diff，发送下方的系统文本和一条用户消息，内容为候选的摘要、以 JSON 表示的已声明修改，以及该 diff。长于 `roles.maxDiffCharacters` 的 diff 不发请求即被拒绝。

##### Critic 系统文本

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

#### Token 影响

每份通过筛查的草稿一个请求；回答无法解析时最多 `roles.criticAttempts` 个。

#### KV Cache 影响

独立请求；系统文本在同一任务集的每个候选之间重复。

### 试验运行时

#### 模型看到什么

策略模型看到的是 spec 所选 profile（默认 `sdk`）的全新运行时中的普通 dsh Session：候选 overlay 中已检查的条目先于策略补丁应用，其 `AGENTS.md` 作为用户全局指令，其 skills 作为用户 skills，任务提示词作为第一条用户消息，工作目录是任务工作区的全新副本。操作者 home 与仓库中的指令和 skills 都不存在。

#### Token 影响

每次度量为每个任务和试验运行一棵 Session 树：一次完整的参考运行对每个任务度量约 82 次（2 次试验，baseline 一次，40 个候选各一次），另加冒烟试验。试验的成本是其运行时中每个 Session 的精确轮次总量。

#### KV Cache 影响

每次试验都是独立的运行时；试验之间或与操作者的 Session 之间不传递任何内容。

## 已知限制与待办工作

<a id="known-limitations-and-deferred-work"></a>

- **只演化配置** — 候选修改 overlay 中列出的设置、指令和 skills；插件代码、其他配置、工具描述和 agent 循环不在可修改范围内。
- **无人值守的试验** — 只有试验 profile 和策略补丁决定试验可以做什么，检查命令通过 subprocess 提供方在宿主机上运行。dsh 沙箱限制试验的文件写入，不限制读取或网络访问。
- **成本依赖精确用量** — 轮次无法证明其 token 用量的试验不报告用量；当一次度量的所有试验都不报告 token 时，成本变化为 0，成本规则会接受任何高于噪声带的增益。
- **incumbent 只度量一次** — 候选与其已保存的度量结果比较，下限跟随迄今最佳分数，因此随着运行推进，同等好的 harness 越过下限的概率降低。
- **单次度量的校准** — 基于每个任务少量试验的 bootstrap 遗漏运行间方差并低估噪声带；请使用重复度量进行校准。
- **少量重复的 spread** — 两三次度量的 `spread` 本身只是一次带噪声的抽样，分数完全相同时噪声带为 0，任何增益都会被当作真实增益。
- **候选按顺序处理** — 一轮依次起草并度量其候选；`trial.concurrency` 只并行同一次度量中的试验。
- **推迟的参考实现部分** — 逐任务摘要、预测记分板和对已保存轮次的重新裁决尚未实现。
- **仅限命令** — 运行只能在带有后台任务的 composition 中从 `/self-improve` 启动；没有模型工具。
- **没有录制会话快照** — 该命令的会话记录，即 `command/run` 与 `command/done` 这一对事件，没有录制会话快照；Web 快照通道可以录制它。`tests/loader-composition.spec.ts` 通过真实 composition 覆盖该命令，`tests/real-runtime.e2e.ts` 让每次试验都在全新的 `dsh` 运行时中针对本地替身模型端点进行度量。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文 — 点击展开</summary>

选择规则、历史摘要、探索和缺失试验的计分遵循参考实现的规则，提示词为原创文本。论文正文与参考实现不一致时，本包遵循论文正文：proposer 的历史附带每个已度量候选的源 diff，并排除度量前即被拦下的候选（Eq. 10）；剪枝集附带被接受候选的 diff（D.2）；编辑预算的余弦一直延伸到最后一轮，使该轮取得最小值（按原文印出的 Eq. 4 以 t/T 计算第 0 至 T − 1 轮，结束时比最小值多 1）；critic 只按论文的理由拒绝：任务集特有的内容（包括评分器博弈和运行时记忆）、无效机制，以及已声明修改未涵盖的变更。

</details>
