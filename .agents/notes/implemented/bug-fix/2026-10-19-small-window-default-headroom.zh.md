# Agent Note：未设置的压缩余量适配小上下文窗口

Status: implemented

[English](2026-10-19-small-window-default-headroom.md) | 中文

## 问题

除非另行配置，`dsh-compaction-basic` 固定预留 65,536 tokens 的压力余量，摘要上限也跟随这个值。当窗口 `W` 减去预留输出 `O` 不超过 65,536 tokens 时，触发阈值 `floor(min(W × 0.8, W − O − 65,536))` 没有正的压力预算，因此正确声明的 32,768-token 窗口会在 `resolveCompactSpec` 中以 `TargetPressureConfigError` 失败；pre-step listener 只警告一次，此后该路由永远不会主动压缩。消息预算不超过 78,019 tokens 时，保留尾部会达到触发阈值，同样失败；略高于此值时触发又过早（81,920-token 窗口在 16,384 tokens 时压缩）。对 32k 窗口，把请求输出计入窗口的服务端还会直接拒绝预留 65,536 输出 tokens 的摘要请求。Ollama 等本地服务端常见的窗口为 4k 到 32k，因此即使声明了真实窗口，这类路由也得不到可用的压缩。

## 决策

未设置的 `headroomTokens` 按每个路由目标的消息预算 `M = W − O` 推导：`min(65,536, M − floor(thresholdRatio × min(M, 65,536)))`。预算不超过 65,536 tokens 时，触发阈值变为 `floor(thresholdRatio × M)`，余量为预算的其余部分。在默认比例下，预算不小于 117,964 tokens 时保持固定的 65,536，因此 DeepSeek 路由（1,000,000 窗口、256,000 输出）和 pi-ai 空白窗口默认值（262,144）的触发阈值与摘要上限都不变。未设置的 `maxTokens` 在压力压缩、`compactRegion()`、溢出恢复和 `compactNow()` 中都跟随推导出的余量；路由窗口未知、查询失败，或 `thresholdRatio: 1` 使推导余量为零时，上限为 65,536。已配置的 `headroomTokens` 与 `maxTokens` 保持原值和原有检查。`ResolvedConfig` 与 `ResolvedTargetPolicy` 省略未设置的字段，由 `resolveCompactSpec` 与 `resolveSummaryCap` 这两个 resolve 步骤推导。运行规则以[包 README](../../../../packages/compaction/compaction-basic/README.zh.md) 为准。

## 考虑过的替代方案

**`min(65,536, floor(M × (1 − thresholdRatio)))`。** 未采用：它还会改变 117,964 到 327,680 tokens 之间的预算，包括 pi-ai 空白窗口默认值（触发阈值从 196,608 变为 209,715），在没有修复任何失败的情况下改变已录制的会话。

**保留固定余量，并为小窗口编写配置说明。** 未采用：这个失败只表现为一条日志警告，补救方法要求了解触发公式；报告问题的部署把窗口字段留空。

**在插件加载时拒绝放不下余量的窗口。** 未采用：容量在每个路由目标首次使用时解析，而不是在加载时解析；拒绝压缩对任何部署都没有帮助。

## 影响

适配器声明了真实小窗口的路由在默认设置下会主动压缩：没有预留输出的 32,768-token 窗口在 26,214 tokens 时压缩，摘要上限为 6,554 tokens；8,192-token 窗口在 6,553 tokens 时压缩，上限为 1,639。在默认比例下，预算为 65,537 到 117,963 tokens 时，触发阈值保持 52,428，上限逐步升至 65,536。固定请求开销（系统提示与工具 schema，在随附的 Web profile 中约 7.8k tokens）无法压缩，因此接近这一大小的窗口仍无法承载对话。溢出恢复与 `/compact` 在第一个事务前解析路由模型的窗口以确定上限，因此它们的开始标记出现在这次查询之后。窗口本身仍来自适配器；pi-ai 空白窗口仍为 262,144 tokens，当声明窗口大于服务端实际窗口时，仍由[溢出逐段并入](2026-10-19-overflow-summary-folding.zh.md)负责恢复。

## 测试

`compaction-basic.spec.ts` 固定了 8,192 到 1,000,000 tokens 预算下推导出的触发阈值、保留预算和摘要上限，包括 117,964 两侧；显式余量、显式上限和按模型余量；`thresholdRatio: 1` 时的上限；通过 `compactRegion()` 得到的上限，覆盖已知窗口、预留输出、未知窗口、未路由和查询失败；以及查询期间的取消。`provider-window-overflow.spec.ts` 在只计输入的 32,768-token 窗口上运行 30 轮对话且没有任何请求被拒绝，并验证 `compactNow()` 的第一次摘要即可放入窗口；两者在固定余量的实现上都会失败，而配置为 65,536 tokens 的上限仍会走逐段并入流程。
