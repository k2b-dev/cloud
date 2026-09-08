---
title: Background authority mandates
navTitle: Background mandates
section: Identity and access
order: 358
description: Let durable app work call another application without storing a user's session or API key.
tags: [identity, background, capabilities, mandates]
updated: 2026-09-07
---

# Background authority mandates

A mandate records what one durable workload may ask Core to do later for a
current user or resource service account. It is not a bearer token, does not
contain resource grants, and cannot be sent to a target application by itself.

Use a mandate when a job, workflow, or automation must call another Cloud
application after the originating browser session may have expired. Do not
store a browser cookie, OAuth access token, or personal API key with the job.

```text
interactive create/update                 later background run

user -> owning app -> mandate in Postgres
                         |
                         v
worker -- app credential + mandate id --> Core
                                          | validate current mandate + subject
                                          | sign exact 30-second invocation
                                          v
                                   target capability
                                          | current domain authorization
                                          v
                                        result
```

Only the Core-to-target hop carries the invocation JWT. The worker never gets
signing power and the target never receives the app credential, mandate ID as
authority, or original user credential.

## Create one mandate with the workload

Create exactly one mandate for one durable workload, not one per target app.
Its bounded policy lists every target application and canonical operation the
workload may request.

```ts
import { mandates } from "@k2b/cloud/services";

const mandate = await mandates.create(
  {
    authority: { kind: "interactive", userId: user.id },
    subject: { type: "user", id: user.id },
    ownerAppId: "inventory",
    workloadType: "scheduled-report",
    workloadId: report.id,
    policy: {
      version: 1,
      apps: ["mail"],
      operations: ["capability.action.run:message.send"],
      actions: "require_approval",
    },
  },
  { db: transaction },
);
```

Built-in applications that share Postgres create the mandate and owning
workload in one transaction. A separately deployed application that cannot
share that transaction creates a pending mandate, persists the workload, and
then confirms it with the owning app's workload credential. A pending mandate
cannot issue invocations. Revoke it when persistence fails; Core also revokes
unconfirmed mandates after the bounded confirmation window.

Only confirmed active or paused mandates reserve an owning workload coordinate.
Pending registrations cannot block a legitimate workload. Confirmation returns
HTTP 409 if another confirmed mandate already owns the coordinate. Revoked
metadata remains visible, and a failed registration can retry with a new mandate.

Each creator may have at most 100 live pending mandates during the 15-minute
confirmation window. Paused pending mandates count too; expired ones do not.
At HTTP 409, confirm or revoke outstanding registrations before creating more.

Use `POST /api/me/mandates` from the signed-in browser session for that remote
sequence. Core always derives the user subject from that session; the request
contains only the bounded owner app, workload coordinates, policy, and optional
expiry. Persist the returned ID and revision first, then call
`POST /api/_internal/identity/v1/mandates/<mandateId>/confirm` with the same
revision and the app workload credential. Ordinary `mandates.create(...)`
remains the atomic same-transaction path and is confirmed immediately.
Before confirming, the owning app must verify that the persisted workload
belongs to the mandate's subject; knowing a workload ID is not proof of ownership.

Policy values are:

- `apps`: an explicit target-app allowlist, or `"*"` only for a deliberately
  open user-sponsored agent;
- `operations`: canonical values such as `capability.query:item.read`,
  `capability.action.review:item.rename`,
  `capability.action.run:item.rename`, `search.query`, or
  `widget.read:weather`;
- `actions`: `deny`, `require_approval`, or `preapproved`.

`preapproved` requires explicit non-empty app and operation allowlists. A
wildcard mandate always requires approval. It cannot silently approve an
operation that the product or capability contract says needs user attention.

Background work does not inherit remembered interactive approvals. Use a
narrowly scoped `preapproved` mandate only for explicitly authorized unattended
operations. Missing, paused, expired or revoked authority must not be replaced
with a user's browser session or silently recreated by a worker.

Only a current interactive subject or administrator can create, resume, or
broaden a mandate. The owning workload may narrow, pause, or revoke it. A
revoked mandate is terminal.

## Invoke from a worker

Provision a resource-bound service-account credential for the owning
application with binding `{ appId, resourceType: "cloud.app", resourceId:
appId }` and the `identity:invoke` scope. Store it as
`CLOUD_APP_CREDENTIAL` in that application only.
Also set `CLOUD_CORE_INTERNAL_ORIGIN` to Core's private service origin. Workload
broker routes are not reachable through the public gateway, and the helper
does not fall back to the public origin for mandate calls.

An administrator creates it through Core's identity API:

```http
POST /api/admin/identity/workloads/inventory/credentials
Content-Type: application/json

{"name":"Inventory background work","scopes":["identity:invoke"]}
```

The raw token appears only in this credential-creation response. List bounded
credential metadata with `GET /api/admin/identity/workloads/inventory/credentials` and
revoke one exact credential with
`DELETE /api/admin/identity/workloads/inventory/credentials/<credentialId>`.
Rotate by creating a new credential, deploying it to the owning app, verifying
broker calls, and then revoking the old credential. Do not reuse the OAuth
broker secret; it is shared only by Core and OAuth for OAuth issuance.

The same app-bound credential owns the remote mandate lifecycle under
`/api/_internal/identity/v1/mandates/<mandateId>`. It may read its mandate,
confirm a pending workload, narrow policy, pause, or revoke. It cannot create
user authority, broaden policy, or resume a paused mandate. Core derives the
owner from the authenticated credential; an app ID in a request body is never
trusted as owner authority.

Lifecycle request bodies are limited to 256 KiB, including streamed requests
without a reliable `Content-Length`. Oversized bodies return HTTP 413. Missing
mutation authority returns HTTP 403; an authorized but stale revision returns
HTTP 409.

Use the server capability helper with the current mandate revision:

```ts
import { invokeCapability } from "@k2b/cloud/capabilities/server";

const result = await invokeCapability(
  {
    appId: "mail",
    capabilityId: "message.send",
    kind: "action",
    input: { draftId: job.draftId },
    idempotencyKey: job.id,
  },
  {
    authorization: `Bearer ${process.env.CLOUD_APP_CREDENTIAL}`,
    mandate: {
      id: job.mandateId,
      revision: job.mandateRevision,
      callingAppId: "inventory",
    },
  },
);
```

The helper sends the app credential only to Core. Core checks the credential's
exact app binding and `identity:invoke` scope, reloads the mandate and subject,
matches the target and operation, signs one target-specific invocation, and
dispatches through the live capability schema. The target then performs its
ordinary effect-time permission checks.

An app workload credential cannot use the ordinary interactive capability
route to bypass the mandate.

## Handle lifecycle and retries

Persist the mandate ID and revision with the workload. A policy update,
pause, resume, or revocation increments the revision. Core rejects requests
carrying an old revision; the worker must reload current workload state before
trying again. This does not require freezing the revision when work is queued.


Pause the mandate when the workload pauses. Revoke it when the workload is
deleted or permanently disabled. Revocation blocks new issuance immediately;
an invocation already admitted can remain valid for at most 32 seconds: its
nominal 30-second lifetime plus the dedicated two-second clock tolerance.

Keep the capability's existing idempotency and approval rules. A mandate does
not make an unsafe retry safe. If a non-idempotent Action loses its response,
the helper returns `ACTION_OUTCOME_UNKNOWN` and the worker must reconcile
instead of retrying blindly.

Users can inspect their own mandates through the bounded
`GET /api/me/mandates` listing. Administrators use
`GET /api/admin/identity/mandates`; owning applications keep product-specific
task and automation presentation in their own UI. Lifecycle and issuance audit
records include subject and workload provenance, target application, operation,
revision, and outcome, but never a JWT, app credential, policy body, or
capability payload.

A signing failure is recorded as a failed issuance before an internal error is
returned, and no target request is sent.



## What still authorizes the effect

Authentication reconstructs the current `actor` and `accessSubject`. It does
not copy or freeze application permissions. The target application must still
check its current domain grants, resource ownership, object state, and any
app-owned workflow snapshot before committing the effect.

Continue with [App capabilities](/en/docs/platform/capabilities) and
[Resource authorization](/en/docs/identity/authorization).
