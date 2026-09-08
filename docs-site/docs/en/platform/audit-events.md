---
title: Audit events
navTitle: Audit events
section: Platform services
order: 550
description: Record security-relevant and administrative actions as durable audit evidence.
tags: [audit, security, operations]
updated: 2026-07-27
---

# Audit events

Audit events answer who attempted a sensitive action, what they targeted, and
whether it succeeded.

Record permission changes, credential lifecycle events, administrative
mutations, and denied security decisions. Do not use audit storage for routine
diagnostics or product analytics.

## Record an outcome

```ts
import { audit } from "@k2b/cloud/services";
import { expectUserBackedActor } from "@k2b/cloud/server";

const user = expectUserBackedActor(c);
await audit.record({
  action: "inventory.item.permission.update",
  outcome: "allowed",
  actor: {
    userId: user.id,
    uid: user.uid,
    provider: user.provider,
    roles: user.roles,
  },
  target: {
    type: "inventory_item",
    id: itemId,
    label: itemName,
  },
  requestId,
  metadata: { permission: "write" },
});
```

Use a stable, dotted action name. Outcomes are `allowed`, `denied`, and
`failed`.

The actor and target are optional because system work may have no user and
some decisions have no persisted target. Include them when known. Map the
request actor deliberately: a resource-bound service account has no user.

## Audit a service result

`audit.recordResult()` maps a Cloud `Result` to an audit outcome and returns the
same result. Pass the transaction when the domain change and audit record must
commit together:

```ts
import { sql } from "bun";

return sql.begin(async (tx) => {
  const result = await inventory.update(input, tx);

  return audit.recordResult({
    action: "inventory.item.update",
    actor: auditActor,
    target: { type: "inventory_item", id: input.id },
    requestId,
    result,
    db: tx,
  });
});
```

Outside a shared transaction, `recordResult()` runs after the operation. An
audit write failure rejects the call, but it cannot undo a completed side
effect.

Use `recordResultAfterSideEffect()` only when the side effect has already
happened and cannot be rolled back. It logs an audit storage failure instead of
masking the completed operation.

## Record denials

`audit.deny()` records a denied outcome and returns a forbidden `Result`:

```ts
return audit.deny({
  action: "inventory.item.delete",
  actor: auditActor,
  target: { type: "inventory_item", id: itemId },
  message: "Access denied",
});
```

Authorization still belongs in the domain service. The audit call records its
decision. See [Resource authorization](/en/docs/identity/authorization).

## Protect audit records

Cloud sanitizes audit metadata before storage:

- sensitive keys such as password, secret, token, cookie, authorization, API
  key, private key, and session are replaced with `[REDACTED]`;
- strings are limited to 500 characters;
- arrays are limited to 50 entries;
- nested values stop after eight levels.

Sanitization is a safety net. Do not pass credentials, request bodies, or
unbounded domain data.

Audit storage is durable evidence. A write failure rejects `record()`,
`recordResult()`, and `deny()`. Handle that failure like any other failed
security operation.

Use [logging](/en/docs/platform/logging) for diagnosis and
[tracing](/en/docs/platform/tracing) for timing and execution flow.
