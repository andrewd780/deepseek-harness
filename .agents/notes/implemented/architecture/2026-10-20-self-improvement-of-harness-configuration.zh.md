# Agent Note：自我改进在全新运行时中度量并演化 harness 配置

Status: implemented

[English](2026-10-20-self-improvement-of-harness-configuration.md) | 中文

## 问题

正则化递归自我改进（RRSI，arXiv 2609.24972）通过搜索改进 agent harness：由模型提出修改，只保留在任务集上可度量地提高分数的修改。它的[参考实现](https://github.com/google-research/rrsi)演化一个保存在其自身仓库中的 Python agent 脚手架，通过容器在 Terminal-Bench 上度量，并通过单一云服务商调用其搜索角色。这些都无法在 dsh composition 中运行，而且被接受的 dsh 修改仍需手工移植到承担完整覆盖率、快照与文档义务的包中。搜索还在其优化的同一组任务上度量，因此缺少参考实现的正则化手段时，一次运行会接受噪声、贴合任务集的修改，以及从不为其 token 付出回报的机制。

## 决策

`@deepseek-ai/dsh-experimental-self-improve` 用 TypeScript 重新实现参考实现的循环，两者不一致时遵循论文正文，并演化一个 dsh 配置目录：profile overlay、用户全局 `AGENTS.md` 和 skills，由操作者的仓库跟踪。每个候选是一个拥有独立 git 检出目录的分支；被接受的候选快进 evolve 分支，从不改变操作者的工作树。一次试验在通过 SDK client 启动的全新 `dsh` 运行时中执行一个任务：候选的 overlay 先于冻结的策略补丁应用，工作区、Harness home 和 agents home 都是全新的，且位于任何仓库之外；任务的检查为其打分，其成本是该运行时中每个 Session 的精确轮次用量。检查可能运行试验写下的代码，因此每个检查命令都在 macOS `sandbox-exec` 下运行，只能在试验的工作区和临时目录中写入，且没有网络；沙箱无法运行时，评分会停止，而不会在不受限制的情况下运行检查。每次试验都把 overlay 作为配置加载，而配置可能加载插件、启动进程或放宽沙箱，因此候选的 overlay 只能设置一份固定列表中的调优设置并关闭工具；插件在审查之前检查它，试验加载已检查条目的 JSON 副本。analyst、proposer 和 critic 在任何 Session 之外调用 `ctx.llm`，运行目录保存每份草稿的模型交互和每个判定。运行通过 `/self-improve` 命令启动，或由该命令或插件设置开启的每日定时计划启动，作为由某个会话拥有的后台任务。

不带参数时，`/self-improve` 运行自动模式：它依据包内自带的模板创建一个入门运行，把 baseline、校准、所有轮次、held-out 度量、应用和总结作为一个任务运行，该任务会从运行已保存的状态恢复；一次运行完成后，再以从其结果开始的新一代继续。应用会把被接受的结果写到 dsh 读取配置的位置：再次依据 overlay 规则检查过的 overlay 条目写入 Harness home 补丁层的受管段落，该补丁层由每个 profile 最后应用，且 dsh 自身的编辑器从不写入它；`AGENTS.md` 写入用户全局指令的受管段落；skills 写入用户 skills。它先连同一个 manifest 备份要改动的每个路径，拒绝替换不是由应用写入的内容，而撤销会逐段落还原最新一次应用；被撤销的结果绝不会再被应用。[包 README](../../../../packages/experimental/self-improve/README.zh.md) 负责操作规则。

## 考虑过的替代方案

**为参考实现编写 dsh 适配器并直接运行。** 作为实现方案被拒绝：它保留单一服务商的搜索角色、基准容器以及位于本仓库之外的演化副本，被接受的 diff 仍需移植。适配器仍是复现论文 Terminal-Bench 度量结果的途径。

**论文正文与参考实现不一致时遵循参考实现。** 被拒绝：论文规定了方法，参考实现只是它的一种实现。参考实现不向 proposer 展示源 diff，而论文的 proposer 以这些 diff 为条件；它的编辑预算结束时高于论文所说的最后一轮预算；它的 critic 还会按论文没有列出的理由拒绝修改。[包 README](../../../../packages/experimental/self-improve/README.zh.md#dev-note) 逐项列出了这些差异。

**演化 TypeScript 源码。** 暂时拒绝：每个候选在度量前都需要一次构建和全部门禁，估计每个需要 15 到 40 分钟，而被接受的修改仍承担全部包义务。配置修改以操作者自行应用的 overlay 形式交付。

**以进程内 subagent 度量候选。** 被拒绝：进程内子 agent 共享宿主进程、其服务和父级 preset，因此候选的 overlay 无法生效，而且其结果不带 token 用量。

**以派生 subagent 运行 proposer 和 analyst。** 推迟：subagent 会在 Session 日志中记录其请求并带有 harness 的文件工具，但一次运行需要一个存活数小时的父 agent，并需要用激活生命周期获取结构化输出。JSON 动作协议把 proposer 限制在候选的演化目录内，且请求数有界。

**提供模型工具。** 被拒绝：工具会让模型启动耗费数千次试验的运行，并为每个请求增加 schema token；命令以及只能由操作者开启的定时计划，让启动运行保持为操作者的决定。

**每次应用都交给操作者。** 对自动模式被拒绝：无人值守的每日运行只有在其结果到达操作者的 Session 时才有用，因此应用是自动的，并改由备份、拒绝和撤销使其可逆。显式运行仍只在 `/self-improve apply` 时应用。

**把 overlay 写进 profile 自己的补丁。** 被拒绝：dsh 的插件管理器和设置页面会写入该文件，并在其末尾添加行，这些行会落进受管段落，而下一次应用会替换该段落。home 补丁层没有这样的写入者，且在 profile 的补丁之后应用，正如试验的 overlay 在试验 profile 之后应用。

**只应用高于噪声带且得到 held-out 任务确认的增益。** 未采纳：应用遵循运行自身的接受规则，该规则在噪声带内会因节省 token 或新增结构性组件而接受候选；总结会在旁边报告 held-out 分数。

## 影响

一次运行可以针对操作者自己的任务集、模型路由和上下文窗口调优 dsh，包括较小的本地窗口，因为试验路由与补丁来自 spec。改进限于配置能表达的范围。每个候选都需要对 evolve 任务做一次完整度量：按参考常量，一次运行中每个任务约 82 次试验。搜索角色的请求保存在运行目录而非 Session 日志中，因为它们在任何 Session 之外运行。dsh 能否达到与参考实现相近的增益尚未度量：参考实现报告的增益来自其他策略和 harness。自动模式会在无人在场时改变操作者的在用配置；备份、拒绝和撤销限定了这一改变，而应用的 overlay 是在试验 profile 上度量的，因此在其他 composition 中，某个条目可能不产生任何改变，或替换该 profile 的 bundle 设置的配置。

## 测试

单元 spec 覆盖选择算术、编辑预算、历史摘要、校准、critic、overlay 规则及每种被拒形式和它们在审查之前与任何试验之前的执行、proposer 的动作协议及其路径检查、任务集校验与检查、针对真实仓库的 git store、运行目录校验，以及循环的各道门禁与恢复；试验针对 SDK client 的脚本化运行时执行。自动模式的 spec 用参考解答和起始文件检查每个入门任务，并覆盖运行的创建、流水线的恢复与各代、应用与撤销及其备份和每种拒绝，以及使用脚本化 `vm_stat` 的定时计划检查；`loader-composition.spec.ts` 还通过 Loader 在入门运行上单独执行 `/self-improve`。`loader-composition.spec.ts` 通过 Loader 启动本插件，配合 commands、后台任务、真实的 subprocess 提供方和脚本化模型，度量 baseline，在一轮中接受一个新 skill，并断言 evolve 分支、历史、held-out 分数，以及释放插件后命令被移除。`real-runtime.e2e.ts` 运行一次 baseline、一轮和一次 held-out 度量，每次试验都在通过 SDK client 启动的全新 `dsh` 运行时中进行；运行时的策略路由连接到一个本地 OpenAI 兼容替身，它只在请求带有输出约定时才按格式作答，因此只有当演化后的 `AGENTS.md` 进入运行时的模型请求时，该轮才会接受这项指令修改。
