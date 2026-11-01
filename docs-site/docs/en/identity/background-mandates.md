---
title: Background authority mandates
navTitle: Background mandates
section: Identity and access
order: 358
description: Let durable app work call another application without storing a user's session or API key.
tags: [identity, background, capabilities, mandates]
updated: 2026-11-01
---

# Background authority mandates

A mandate records what one durable workload may ask Core to do later for a
current person or service account. It is not a bearer token, does not
grant resource access, and cannot be sent to a target application by itself.

Use a mandate when a job, workflow, or automation must call another Cloud
application after the originating browser session may have expired. Do not
store a browser cookie, OAuth access token, or personal API key with the job.

```text
interactive create/update                 later background run

user -> owning app -> mandate in Postgres
                         |
                         v
worker -- signed request + mandate id --> Core
                                          | validate current mandate + subject
                                          | sign exact 30-second invocation
                                          v
                                   target capability
                                          | current domain authorization
                                          v
                                        result
```

Only Core signs the target invocation JWT. The worker's app key signs requests
to Core, and the target never receives that app proof, mandate ID as authority,
or original user credential.

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

A mandate keeps acting after the person's device is removed, so the
[Cloud app's session](/en/docs/identity/authentication#app-sessions-preview)
never creates, widens, or resumes one. Before you create a mandate, change its
policy, or resume it with an interactive authority, reject such requests:
`auth.rejectAppSession` on the route, or `isAppSessionActor(actor)` in a service
or capability. Answer `403` with
`{ "code": "FORBIDDEN", "message": "Use Cloud on the web for this." }`.
Pausing and revoking stay allowed. `POST /api/me/mandates`, Assistant routines
(scheduled tasks), and Mail incoming automations with Spaces steps follow this rule.

Built-in applications that share Postgres create the mandate and owning
workload in one transaction. A separately deployed application that cannot
share that transaction creates a pending mandate, persists the workload, and
then confirms it with a signed app request (or legacy workload credential). A pending mandate
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
revision and a signed app request (or legacy workload credential). Ordinary `mandates.create(...)`
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
- `actions`: `deny`, `require_approval`, or `preapproved`;
- optional `grants`: exact capability pairs and fixed inputs, checked in addition
  to the app and operation allowlists.

`preapproved` requires explicit non-empty app and operation allowlists. A
wildcard mandate always requires approval. It cannot silently approve an
operation that the product or capability contract says needs user attention.
Unattended Actions follow the live capability policy: `ask`, `routines: false`,
and legacy Actions without `none` or `rememberable` approval require an
interactive workflow. Optional grants add exact capability and input
constraints. A `require_approval` mandate without grants can execute an Action
after its separate approval has completed through Cloud. The app invocation
broker never supplies this approval.

Background work does not inherit remembered interactive approvals, neither
those for a chat, including a website allowed for a chat, nor those that apply
everywhere. Use a
narrowly scoped `preapproved` mandate only for explicitly authorized unattended
operations. Missing, paused, expired or revoked authority must not be replaced
with a user's browser session or silently recreated by a worker.

Only a current interactive subject or administrator can create, resume, or
broaden a mandate. The owning workload may narrow, pause, or revoke it. A
revoked mandate is terminal.

Active standalone and agent accounts can also be mandate subjects. Only an
administrator can create authority for a machine; the editing person's grants
are never substituted for the machine's own grants. Grids binds its
`workflow.run` mandate to one workflow and a write ceiling; see
[Machine workflow mandates](./machine-workflow-mandates.md).

## Grant capabilities to an unattended Assistant routine

Assistant routines use explicit `grants` in their mandate policy. Each grant pairs
one `appId`, local `capabilityId`, and `kind` (`query` or `action`) with an
explicit resource target and optional fixed top-level inputs. The agent proposes the scope; the user reviews it when
creating or updating the routine. Capabilities need no additional metadata.

For example, a fictional application `demo` declares `item.edit` with a
`folder` target and an `itemId` domain input:

```json
{
  "appId": "demo",
  "capabilityId": "item.edit",
  "kind": "action",
  "target": { "type": "demo.folder", "id": "folder123" },
  "fixedInput": { "itemId": "abc123" }
}
```

This allows changes to that item within the named folder while leaving the
edit content unrestricted.
An empty `fixedInput` allows any domain input to that exact capability at the
granted target within the user's current access. Fixed JSON values use exact equality: nested objects
must match completely, and array order matters. There are no wildcards,
implicit parent-resource checks, or expressions. The provider must check that
the item belongs to the declared target folder.

Background runs discover and load only capabilities their mandate policy and
routine grants can permit. Previously loaded tools outside that scope stay
unavailable. Discovery ignores fixed inputs and target IDs; Core checks them on every call.
If the mandate cannot be read, has changed, or its policy is invalid, the run
stops before the model starts and the routine needs attention.

Core checks the current mandate revision, grant pair, fixed values, and live
capability approval mode before every invocation. Only actions with `approval:
"none"` or `approval: "rememberable"` can pass the routine mandate policy.
Remembered interactive approvals do not authorize background work. The target
application still checks the user's current resource permissions.

Before each change, a routine run checks the mandate first, then calls the
app's review for every Action with `approval: "rememberable"`. It runs the
Action only when the review returns an `approvalScope`. An Action that needs
approval and is not rememberable never runs in a routine, regardless of the
review. A missing review, a review error, or a result without that scope
refuses the call; the app's `run` is never invoked. The review only narrows the
mandate and never grants access. The same rule applies to background Code Mode.

The model receives a short `NEEDS_APPROVAL` error telling it to stop and say
what was missing. Even if the model completes its reply, the routine becomes
`needs_attention` with reason `needs_approval` and the action name in the
routine's locale. A one-time routine needs a new time before it can run again.

Changing grants updates the mandate revision, invalidating older runs' authority.
The agent can inspect a failed run and propose revised grants in the normal chat;
expanding the scope requires a new reviewed routine update. A worker cannot grant
itself more authority. A capability call rejected by the grants or fixed inputs
returns a tool error so the model can continue with granted tools or explain
what is missing. The routine also needs attention when its mandate is unavailable,
paused, revoked, expired, or changed, when the target app rejects the sponsor
with HTTP 401 or 403, or when an action's outcome is unknown. Scheduled turns
run server Code Mode tools under the same routine-scoped authority; see
[Scheduled Code Mode](/en/docs/ai/chat-runtime-and-streaming#scheduled-code-mode).

## Bind operations to targets

`CapabilityGrant`, exported from `@k2b/cloud/services`, is the durable grant
format for both person-owned routines and Code versions. `TaskGrant` includes
this format alongside the existing HTTP and database grants.

- `appId`, `capabilityId`, `kind`: one discovered operation, with its local ID.
- `target`: `{ type, id }` using the qualified resource type, or `null` for an
  app-wide Action. Omitting it does not authorize a resource-bound Action.
- `refs`: the complete map of additional targets, keyed by the operation's
  declared reference fields. Omitted means an empty map. Each type and ID must
  match; grants for different targets cannot be combined into a broader pair.
- `fixedInput`: exact top-level domain values, defaulting to `{}`. Target
  fields belong in `target` and `refs`, never in `fixedInput`.

Core compares the validated `NormalizedCapabilityCall` with one complete grant
before issuing either a review or an execution. Another target, reference,
operation or fixed input is denied. A workload cannot narrow its policy by
removing or changing an existing target restriction.

Existing routine grants with old target fields in `fixedInput` remain denied
for converted capabilities until they are migrated. Move those fields into the
explicit coordinates without broadening authority; if the mapping is unknown,
stop the routine with `needs_attention` rather than drop the restriction.

## Code version mandates

`CodeVersionMandateBinding` and `CODE_VERSION_MANDATE_WORKLOAD_TYPE`, exported
from `@k2b/cloud/services`, bind a mandate to `ownerAppId: "core"`,
`workloadType: "code.version"`, and `workloadId` equal to the immutable version
ID. All entry points share that version's mandate. A new version gets its own
mandate; policy updates advance the revision and invalidate earlier invocations.

Personal Code uses its current person as the subject. Its operation allowlist
can permit dynamic targets; the target application still checks that person's
current rights. Routine grants can restrict a person's calls to one target.

Resource and application Code use a service account of kind `code`. Only its
Core version mandate can issue invocations. Actions need explicit operation
and target pairs, including `target: null` for app-wide Actions. Queries check
the operation; their provider must return only resources with the Code
account's own current access. Neither a mandate nor a signed-in, public or group
grant supplies that access. Unattended `ask` Actions remain blocked.

Code Actions need an explicit `silent` policy that permits routines. Version
approval does not override `ask`, `routines: false`, or `unattended: false`.
The target provider repeats the Action review immediately before execution;
a failed review or a per-call `ask` blocks the call. The chat remembering
scope is not additional authority for Code.

For example, Spaces declares `task.create` and `task.update` as
`policy: { silent: "shared" }`. An approved version with the matching mandate
and Space access can create or update tasks unattended. Creating from a
template or with assignees still requires confirmation for that call.
In chat, these policies keep the existing behavior: the first call asks and
the person may remember the Space scope. A per-call confirmation cannot be
remembered. Deletes and sends continue to require confirmation.

The signed invocation carries empty credential scopes. Once the platform has
verified its current version mandate and Code principal, the mandate replaces
credential scopes and human app-entry rules for this capability request. For
existing app scope resolvers, `actor.scopes` projects a `read`/`write` ceiling;
it never projects `admin`. The invocation's signed scopes and
`RequestAuthority.scopes` remain empty. Applications must still intersect this
ceiling with their current resource grants. Code cannot obtain this projection
through an API key, OAuth, an ordinary app-access grant or a non-version mandate.

## Invoke from a worker

Configure the owning application's [app key](/en/docs/operations/app-keys) and
`CLOUD_CORE_INTERNAL_ORIGIN`. Workers supply mandate coordinates and context;
the platform signs each final request, including every safe retry. Core resolves
the key to `cloud.app/<appId>` with `identity:invoke`, checks revocation directly,
and applies the current mandate and grant checks.

### Legacy credentials during this release

Apps without an app key retain the deprecated workload-credential path.
Core automatically delivers an app-bound `identity:invoke` credential to each
registered app instance. Use `getAppWorkloadCredential()` from
`@k2b/cloud/services` at call time so rotation takes effect. It returns
`undefined` when no valid credential is available; dependent work must fail
closed with a visible reason. A transient refresh failure keeps the current
token available until it expires. Never cache the returned token or pass it to a browser
or target app.

Set `CLOUD_CORE_INTERNAL_ORIGIN` to Core's private service origin. Workload
broker routes are not reachable through the public gateway, and the helper
does not fall back to the public origin for mandate calls. For host-run apps,
deprecated `CLOUD_APP_CREDENTIAL` is an optional explicit override; it wins over automatic
delivery and remains operator-managed. See [runtime configuration](/en/docs/operations/runtime-configuration)
for rotation, revocation, health diagnostics, and the shared-infrastructure trust limit.

For an explicit host-run override, an administrator opens **Administration → Apps** (`/admin/apps`), opens the owning app,
then **Keys**, unfolds **Tokens for host operation**, chooses **Create token**, and enters a name and
optional expiration time in the dialog. The old address `/admin/app-credentials` opens the Apps page with a hint.
The token is shown once. Save it in the deployment's secret store and inject it
only into that app. The table lists credentials across all apps and supports revocation.

The CLI exposes the same operations. For example, using an administrator profile:

```sh
cld admin app-credentials apps
cld admin app-credentials list mail
(umask 077; cld admin app-credentials create mail --name production --yes > mail-credential.txt)
cld admin app-credentials revoke mail <credential-id> --yes
```

The create command prints the token once (structured output includes token and
metadata). Transfer it into the deployment secret store and remove the temporary
file. Use `--expires-at` with a future ISO 8601 timestamp to set the expiration time.
Create/list/revoke also work for an explicit app ID before it registers; the UI
selector and `apps` command show registered applications.

Core's administrator API provides the same creation operation:

```http
POST /api/admin/identity/workloads/inventory/credentials
Content-Type: application/json

{"name":"Inventory background work","scopes":["identity:invoke"]}
```

The raw token appears only in this credential-creation response. List bounded
credential metadata across apps with `GET /api/admin/identity/workloads/credentials`,
or for one app with `GET /api/admin/identity/workloads/inventory/credentials`, and
revoke one exact credential with
`DELETE /api/admin/identity/workloads/inventory/credentials/<credentialId>`.
Revoking an automatic runtime credential disables the app's workload access
across all instances and restarts. Restore it in the app's **Keys** column with
**Turn on again**, with `cld admin app-credentials enable <app> --yes`,
or with `PATCH /api/admin/identity/workloads/<app>` and `{"status":"active"}`.
The shared capability client refreshes a broker-rejected workload credential
and retries once; persistent credential rejection returns HTTP 503 so workers
can retry later. Subject and target authorization failures remain permanent.

For a host-run override, rotate by creating a new credential, deploying it to the owning app, verifying
broker calls, and then revoking the old credential. Do not reuse the OAuth
broker secret; it is shared only by Core and OAuth for OAuth issuance.

The same app-key proof or legacy app-bound credential owns the remote mandate lifecycle under
`/api/_internal/identity/v1/mandates/<mandateId>`. It may read its mandate,
confirm a pending workload, narrow policy, pause, or revoke. It cannot create
user authority, broaden policy, or resume a paused mandate. Core derives the
owner from the authenticated credential; an app ID in a request body is never
trusted as owner authority.

For remote lifecycle requests, use `sendAppRequest` from
`@k2b/cloud/services/identity` with the final `Request` and `{ appId }`.
Call it again for every safe retry. It signs the exact method, path including
query, and body with a fresh proof and disables redirects. Without an app key,
it uses the legacy workload credential. It sets `X-Cloud-App-Id` in both modes
and rejects a conflicting caller-supplied app identity before sending.
It never retries an uncertain transmission on its own.

Signed request body reads have an absolute 10-second deadline, including
uploads that continue to send data. Core returns `DEADLINE_EXCEEDED` (HTTP 504)
when that deadline expires. Admission returns `RATE_LIMITED` (HTTP 429) with
`Retry-After`; authentication failures retain their HTTP 401 or 403 status.
All these failures include the capability error fields `code` and `message`.

Lifecycle request bodies are limited to 256 KiB, including streamed requests
without a reliable `Content-Length`. Oversized bodies return HTTP 413. Missing
mutation authority returns HTTP 403; an authorized but stale revision returns
HTTP 409.

### Invoke a capability

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
    mandate: {
      id: job.mandateId,
      revision: job.mandateRevision,
      callingAppId: "inventory",
    },
  },
);
```

The helper signs with the app key, or uses the legacy workload credential when
no key is configured. Only Core receives it. Core checks the app binding and
`identity:invoke` scope, reloads the mandate and subject,
matches the target and operation, signs one target-specific invocation, and
dispatches through the live capability schema. The target then performs its
ordinary effect-time permission checks.

An app workload credential cannot use the ordinary interactive capability
route to bypass the mandate.

## Assistant routine runtime grants

Routines keep capability, HTTP, and RSQL access in the same mandate
`grants` list. Capability entries use `appId`, `capabilityId`, `kind`, and
`fixedInput`. Code Mode entries use `kind: "http"` or `kind: "database"` and
`fixedInput`: HTTP can fix an HTTPS origin, exact URL, and method; database
access can fix a Studio app ID, operation, and table. Omitted fields are free
for the routine to choose. An empty object explicitly grants unrestricted inputs
for that kind, within the runtime's existing limits and current resource access.

Flat `cloud.db` operations `list`, `get`, `insert`, `update`, and `delete` match grants `rows.list`, `rows.get`, `rows.insert`, `rows.update`, and `rows.delete`; `query` matches `query`.

The ordinary routine approval describes these grants before they are saved.
Runtime calls check the stored mandate revision and exact fixed values; HTTP
checks again immediately before sending. Personal remembered approvals do not
replace routine grants. Expanding a grant needs a new interactive confirmation.
Table-scoped grants do not authorize arbitrary SQL, export, or connection setup;
those operations need a separate matching grant. See
[Scheduled Code Mode](/en/docs/ai/chat-runtime-and-streaming) for examples.

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
routine and automation presentation in their own UI. Lifecycle and issuance audit
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
