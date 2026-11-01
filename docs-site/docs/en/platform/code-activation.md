---
title: Activate a Code version
navTitle: Code activation
section: Platform services
order: 963
description: Activate submitted Code with durable target checks, version mandates, rollback and draining.
tags: [code, identity, permissions]
updated: 2026-11-01
---

# Activate a Code version

Activation checks the owner and every target needing new or broader permission
before creating any grants. A refusal leaves the current version running and
identifies the one target that blocked activation. Submit the version first;
[current policy and version approval](/en/docs/platform/code-versions) must
permit it.

Resource Code needs an administrator of its owner and of every target needing
new or broader permission. Existing permission can be reused by a new owner
administrator. A new version using the same permissions needs only the owner's
administrator. A Code editor alone cannot bypass the owner check.

A Cloud administrator can activate resource Code through the same target
contract. Managers of affected targets, including the owner, receive one
notification per activation and target. Activation adds no personal resource
shares for that administrator. Personal Code can be activated only by its owner
and runs with that person's current rights.

Browser sessions and personal OAuth credentials can activate. Phone sessions,
service accounts, API keys, Code runs and forwarded invocations cannot create
this authority. A CI credential can submit code but cannot activate it.

## Start and follow activation

Core exposes these JSON routes. Authenticate directly to Core with the original
interactive credential; do not call activation through another application's
capability invocation.

| Route | JSON body | Result |
| --- | --- | --- |
| `POST /api/code/activate` | `{ codeId, versionId, activationId }` | Durable activation status |
| `POST /api/code/activation/read` | `{ codeId, activationId }` | Current activation status |
| `POST /api/code/activation/cancel` | `{ codeId, activationId }` | Status after scheduling cancellation |
| `POST /api/code/access` | `{ codeId }` | Active version's target access observations |

Generate `activationId` as a UUID once. Reuse it after a lost HTTP response;
Core returns the existing process. Reusing it for another Code, version or
activating person returns a conflict. A terminal failure needs a new activation
ID after its cause has been resolved. Read routes require access to the Code;
mutation routes retain the credential's write scope. Enqueue and cancellation
record intent without waiting for the worker's target requests. Explicit
activation also resumes paused Code after all activation checks succeed.

Status contains `id`, `codeId`, `versionId`, `state`, `failure`, `mandateId`,
`createdAt` and `updatedAt`. Timestamps use ISO 8601 UTC. `failure` is null or
`{ target, code, reason }`; `target` is the exact `{ type, id }`, or null for a
Code-wide failure. Provider refusal text remains separate from its stable code.
Use the target's canonical resource reader to show its current name.

| State | What to show or do |
| --- | --- |
| `pending`, `preflight`, `applying` | Activation is in progress. Read its status again. |
| `waiting` | A dependency is unavailable. Core retries automatically with the same grant identities. Cancellation is available. |
| `rolling_back` | Core is removing this process's new grants. Failed cleanup remains queued and retries. |
| `failed` | Activation stopped and its grants were compensated. Resolve the named failure and start a new process. |
| `cancelled` | Cancellation and compensation completed. |
| `active` | The version mandate and active version were committed together. |

A cancelled or failed activation leaves older grants and the previous active
version intact. Revoking or expiring the activating credential stops the process
and schedules compensation. Core stores revocation coordinates and scopes,
never the original cookie or bearer token, and reloads the person's current
identity before continuing. If a non-admin is promoted to Cloud administrator while
activation is pending, start a fresh activation so its notifications follow the
Cloud-admin path.

## How target permissions are applied

Core serializes activations for each Code. It saves the target plan and each new
`grantId` before issuing [Code access proofs](/en/docs/platform/capabilities#code-access-at-the-target).
A busy worker retries without holding a database connection while waiting for
another worker. It first calls `set` with `dryRun` for the owner and all new or broader targets.
Only after every preflight succeeds does it apply grants. A crash or lost
response repeats `set` with the saved grant identity, preventing duplicates.

If a later target refuses, Core removes only grant IDs belonging to that
activation, including attempts whose responses were lost. Reused grants remain.
Each target adapter must keep grants with different IDs independent.

Dry-run answers reveal only what the person may read. A target's existing
`access.readable` check controls whether an activation refusal includes its
`title` and `managerUserIds`. Otherwise the answer keeps the target ID and the
stable reason code, with “Only someone who manages this target can activate it”
(“Einschalten kann nur, wer dieses Ziel verwaltet” in German). The Code link
remains available to copy. Status reads check the current reader again before
returning a saved title or manager list.

Cloud-admin notification audiences use a separate Core-only, target-bound
`signCodeAccessNotifications` proof. Each successful adapter dry run identifies
current human managers in `managerUserIds`, including administrator-group
members. Core obtains this audience through the server-only notification lookup,
then records one durable notice per manager and target when activation commits.
Recipients do not enter the target plan or the person's set answer when the
target is unreadable. A retry repeats preflight and obtains the current audience;
real sets need not return it. An unavailable audience retries activation, and an
empty array means there are no human managers. Every adapter, including a
third-party adapter, supplies this audience for Cloud-admin activation. The
shared capability result budget bounds it; refuse an oversized audience rather
than truncate it.

Activation stores target references, plans and failures as JSON objects or
arrays. Rollback routes every persisted grant to its target provider before
marking it released, including a write whose response was lost.

## Version mandates and old runs

Core stores one `code.version` mandate per immutable version under owner app
`core`. Its subject is the personal owner or the resource's Code account.
Resource Actions receive `CapabilityGrant` pairs with exact targets and reference
maps; Queries receive operation grants. The checker supplies flat
operation/target sets, without primary/ref roles. Where several literals match a
declared target Type, activation permits their type-matching combinations; every
such target still needs its own grant. The mandate budget bounds combinations. Personal Code uses operation authority,
with its current resource rights checked at execution. The existing mandate
policy budgets apply; versions exceeding them fail before any target effects.
An existing mandate is reused only while active, unexpired and unchanged.
Activation reports a conflict if someone separately pauses or changes it; resolve
that mandate before activating the same version again.

Switching `activeVersionId` and storing the version mandate happen in one
transaction. New admissions use the active version. Existing queued or running
runs of the old version drain with their mandate and target grants. Once no run
needs them, Core revokes old mandates and removes grants unused by the active
version. Pausing a Code retains its active version's grants.

Target reconciliation uses `list` only. Access observations are
`{ grantId, target, operations, state }`, where `state` is `present`, `removed`
or `unavailable`. A provider outage is not reported as removal. Reading,
reconciling and background cleanup never call `set` to restore removed access.
Only another explicit activation can create a fresh grant, after checking target
authority again.

## Core integration contracts

Core's `code/index.ts` exports `codeActivationContracts`, `CodeActivation`,
`CodeActivationState`, `CodeActivationFailure`, `CodeTargetAccess` and their
schemas. CLI and resource UI integrations use `activateCodeVersion`,
`readCodeActivation`, `cancelCodeActivation` and `reconcileCodeAccess` with the
same `CodeContext` used by the other Code services. Lifecycle and runner
integrations can call `cleanupCodeActivation` after state changes; the durable
cleanup worker also retries while old runs remain open. For owner deletion,
first block new work, clear `activeVersionId`, and let unfinished activations
compensate and open runs finish or be cancelled. Run cleanup to completion before
deleting Code, versions or activation records: reused grants are owned by their
original journal row, so that journal must not be pruned independently.

`processCodeActivation` is the trusted worker entry point. Applications do not
call it or issue access proofs themselves. `readCodeActivationManifest` from `@k2b/cloud/capabilities/server` is a Core-only
registry reader: plan construction does not require the activating person to
hold entry access to every already-authorized target app. It grants no resource
access and must not be exposed through a generic caller transport.

Core starts both outbox workers with
its normal lifecycle. Their failed jobs retain attempts and the last error;
cleanup runs separately so a draining version does not block new activations.

Owner deletion stops activation and durably removes its grants. See
[Code lifecycle](/en/docs/platform/code-lifecycle) for the deletion helper,
owner checks and the cleanup read model.
