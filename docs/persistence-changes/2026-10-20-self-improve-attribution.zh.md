---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-20-self-improve-attribution

[English](2026-10-20-self-improve-attribution.md) | 中文

## 概述

新增自我改进搜索角色的消息来源种类。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-20-self-improve-attribution
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-05-working-directory-attribution"
    after: "cb299da3183f6288f99f87572040acaad392811b56bcd0c5bdaf13094becb9c3"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-05-working-directory-attribution"
    after: "aa587a44d953b5d843afe1fb4a4fd0658a708c3009d7df72cc26077ff1d9e2fb"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-07-title-reasoning-effort"
    after: "939346ed19c79c9fb48273a389f9b3504ca5aa3de9c2cc0cc67c6ffa65413046"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-05-working-directory-attribution"
    after: "95553f91fb254a805d06803ab1e59cde081afcb5e30125c16e5e25719197583a"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有记录仍然有效。新增的 dsh-experimental-self-improve 来源种类标记 analyst、proposer 和 critic 的请求；插件在任何 Session 之外通过 ctx.llm 发送这些请求并将其保存在运行目录中，因此没有 Session 日志记录它。遇到该种类的读取方遵循已声明的来源策略，保留未知标记而不解释其含义。Session 格式保持不变。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/experimental/self-improve/tests：21 个文件、144 个测试通过。

<a id="dev-note"></a>
## 开发备注

无。
