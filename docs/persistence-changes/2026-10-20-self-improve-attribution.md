---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-20-self-improve-attribution

English | [中文](2026-10-20-self-improve-attribution.zh.md)

## Summary

Adds the self-improve search roles' message source kind.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

Existing records remain valid. The additive dsh-experimental-self-improve source kind attributes the analyst, proposer, and critic requests, which the plugin sends through ctx.llm outside any Session and keeps in its run directory, so no Session log records it. A reader that meets the kind follows the declared source policy, which preserves unknown attribution without interpreting it. The Session format remains unchanged.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/experimental/self-improve/tests: 21 files and 144 tests passed.

<a id="dev-note"></a>
## Dev Note

None.
