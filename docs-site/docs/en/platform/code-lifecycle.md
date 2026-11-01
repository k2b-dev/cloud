---
title: Code owner lifecycle
navTitle: Code lifecycle
section: Platform services
order: 964
description: Report owner deletion transactionally, follow durable grant cleanup, and pause Code whose owner is missing.
tags: [code, identity, permissions]
updated: 2026-11-01
---

# Code owner lifecycle

Deleting an owner permanently deletes its Code, versions, runs and Code account,
and removes every explicit permission granted to that account. Restoring the
owner does not restore its Code. Explain this consequence before asking the
person to confirm deletion.

Deleting a person deletes their personal Code. Resource Code that person
activated keeps running with its own account and mandate. Removing an
application after explicitly removing its retained listing pauses its Code; it
never starts automatic deletion. A temporarily missing live registry lease is
an outage, so a normal application restart does not permanently pause Code.
Per-Code databases are not provisioned in Phase 1; their lifecycle belongs to
the later database feature.

## Report deletion in the owning transaction

Import `codeOwnerDeleted` from `@k2b/cloud` and call it in the transaction that
deletes or soft-deletes the resource:

```ts
import { codeOwnerDeleted, sql } from "@k2b/cloud";

await sql.begin(async (tx) => {
  await tx`UPDATE example.projects SET deleted_at=now() WHERE short_id=${projectId}`;
  await codeOwnerDeleted(tx, { type: "example.project", id: projectId });
});
```

Use the public resource ID from the canonical reader. Report every Code owner
removed indirectly, including children removed with a parent. A rollback
reports nothing. Duplicate reports are safe. Do not call the helper for an
outage, an unregistered application or a temporary permission refusal.
Core also reports personal owners when their user row is deleted.
The helper accepts only the running application's declared `code.owners`.
Call it after `app.start()` has bound the application declaration.

The helper writes the existing platform transactional outbox. Core consumes the
committed report at least once without depending on event-stream retention.
Before contacting another application, Core atomically marks the Code
`deleting`, disables its account, revokes its version mandates, cancels runs and
stops unfinished activations.

## Follow cleanup through an outage

Core persists one `code.access.rm` job per recorded grant, including grants
whose activation request may still be in flight. Each job keeps the target as a
JSON object so cleanup reaches the recorded provider before marking the grant
released. Removal uses the platform's
account-bound cleanup authority; it does not retain the activating person's
session or require their continued access. Retrying a removal cannot restore a
grant or remove an ordinary person's share.

An unavailable target leaves its job waiting. Core retries automatically with
backoff, up to about five minutes between attempts. Other targets can still
finish. Code, its account and journal remain until all removals have been
confirmed and the activation worker has drained. Then Core deletes the Code
and its owned records.

Administration clients use `POST /api/code/cleanup` with
`{ codeId?, cursor?, limit? }`. Cloud administrator authority is required.
`limit` defaults to 20 and cannot exceed 50. Responses contain
`{ data: { items, nextCursor } }`; reuse `nextCursor` as the next `cursor`.

Core exports `listCodeCleanupJobs`, `codeLifecycleContracts`,
`CodeCleanupJobSchema` and `CodeCleanupJob` from `packages/core/src/code` for
Administration › Code. Every item includes the Code title, job kind, target,
attempt count, next retry time and a stable `lastError` code. Its state is
`pending`, `running` or `waiting`. Completed jobs disappear. A `code.delete` job
waits for the grant-removal jobs; it does not permit skipping failed cleanup.

## Check the owner before running

A resource's canonical reader supplies `codeResourceTitle(tx, id)`. This
server-only projection uses the supplied read-only transaction and returns the
current title, or `null` only when the resource is missing or deleted. Database
or provider failures throw. Readers of types listed in `code.owners` or offering
Code grants must supply it; startup rejects a reader that omits it.

Core reads only this projection under authority bound to the exact owning Code
account. It never impersonates the former activator or reads the full resource.
A missing title pauses Code with `pauseReason: "owner_not_found"`
(**Besitzer nicht gefunden**). Queued runs become `skipped` with the same
outcome. A reader outage refuses admission for retry. Neither case deletes
Code; deletion requires the explicit helper.

Core exports `checkCodeOwnerBeforeRun(code)` and
`readCodeRunOwnerTitle(code, db)`. The scheduler calls the guard after committing
the claim and immediately before signing the runner lease. Call it outside
caller transactions and dispatch locks: it reads the title first, then commits
any pause in a short transaction. A `false` result means no runner token may be
issued; the scheduler skips the claimed run with its generation fence. An
outage also issues no token and allows retry through lease recovery. This check
covers owners removed while work was queued. Run insertion remains a storage
primitive; the scheduler owns this execution check.

The same reader projection checks normalized targets of Code accounts before a
capability executes. A missing target returns `CODE_TARGET_DELETED` with
**Target deleted** or **Ziel gelöscht**, according to the invocation locale.
A target without a usable projection returns `CODE_RESOURCE_UNAVAILABLE` and
runs no handler. Ordinary permission refusals and missing objects inside the
operation's input retain their own errors.

See [Code activation](/en/docs/platform/code-activation) for target grants and
[Code data model](/en/docs/platform/code-data-model) for owned records.
