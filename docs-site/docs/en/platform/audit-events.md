---
title: Audit events
navTitle: Audit events
section: Platform services
order: 550
description: Record security-relevant and administrative actions as durable audit evidence.
tags: [audit, security, operations]
updated: 2026-10-22
---

# Audit events

Audit events answer who attempted a sensitive action, what they targeted, and
whether it succeeded.

Record permission changes, credential lifecycle events, administrative
mutations, and denied security decisions. Do not use audit storage for routine
diagnostics or product analytics.

Domain history belongs to its application (Grids `audit_log`, Files `activity`);
security evidence belongs to audit events.

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

## Accounts notification batches

The batch mutation methods on `notificationBatches` require an `actor` with
`userId` and optional audit identity fields (`uid`, `provider`, and `roles`).
`createDraft` and `finalize` derive their stored creator or approver from this
actor. The Accounts API supplies the authenticated administrator.

Successful mutations write `accounts.notification_batch.create`, `.delete`,
`.finalize`, `.retry_failed`, or `.retry_recipient` in the same transaction as
the batch change. An audit failure rolls back that change. Delivery jobs are
submitted after commit. These events describe the administrative action, not
mail delivery success. They contain batch IDs, counts, or a retried user ID;
message content and recipient email addresses are omitted.

## Remembered AI approvals

Remembering an AI tool approval for one chat or always writes
`ai.approval.remember`. Revoking it through the approvals page or API, or
`forgetAiToolApproval`, writes `ai.approval.revoke`. A Core migration can also
revoke approvals as system work, with a stable `reason` code and no actor.
Each changed preference writes one event with outcome `allowed` in the same
transaction as the change. An audit failure rolls back the change. A revoke
that deletes nothing writes no event. Remembering the same approval again
keeps its preference ID and writes another `ai.approval.remember` event.

The target has type `ai_approval`, the preference ID, and the tool name as its
label. Metadata contains `toolName`, `approvalScope`, `remember` (`chat`
or `always`), `conversationId` for chat approvals, and `accessSubject`.
The actor records the request's user or delegated user. `accessSubject` is
derived from the request actor and includes `delegatedByServiceAccountId`
for a delegated user. Service-account requests also record `serviceAccountId`
in metadata. Calls without request identity record the preference's owner in
both fields. System revocations have no actor and record the owner as
`accessSubject`, or null when the approval has no owner.
The event includes the request ID when known.

No chat content, tool input, or model reason is stored. Deleting a chat or a
Studio app ends its approvals without separate audit events.

## Geo service transitions

Core records `core.geo.provider_key_rejected` (`failed`) on a provider 401/403,
and `core.geo.monthly_budget_exhausted` (`denied`) on the first reservation
that cannot fit the Cloud monthly budget. Each event is recorded at most once
per local calendar month, across Core replicas. The transition marker and
audit row commit together; a failed audit write rolls back the marker.

The actor is the request actor, including service accounts, and `requestId`
links the event to its capability execution. Metadata contains only the month.
There is no per-call geo audit event and no address, search text, coordinates,
provider body, or key in these rows. See
[Places and maps](/en/docs/platform/places-and-maps) for budgets and recovery.

Administrator changes on **Administration → Places and maps** are recorded as
`core.geo.key_set` (metadata `replaced`), `core.geo.key_removed`, and
`core.geo.budget_changed` (the saved plan and limits), all `allowed`, in the
same transaction as the settings write. The page names the person of the
latest such event. A refused or unverified key records nothing and never
appears in an event.
