---
title: Activate a Code version
navTitle: Code activation
section: Platform services
order: 963
description: Switch an approved Code version on with its current account rights and a durable version entry.
tags: [code, identity, permissions]
updated: 2026-11-04
---

# Activate a Code version

Activation switches the running version. It checks the Code owner, the
activating credential and the required version approval. It creates no target
permissions. A target manager grants the Code service account View or Edit
through the target's normal share dialog, using its exact handle. Every call
then uses that account's current rights at the target.

For resource Code, the person switching on must manage the owner. A Code editor
may submit a version but cannot bypass that owner check. A Cloud administrator
can activate resource or application Code with full administrative authority;
this grants no access at any target. Personal Code can be activated only by its
owner and runs with that person's current rights.

Personal Code requires the owner's browser session. Resource and application
Code also accept personal OAuth credentials with the required scope. Phone
sessions, service accounts, API keys, Code runs and forwarded invocations cannot
activate Code. CI can submit a version but cannot activate it.

## What a Code service account cannot get

Target shares follow the normal grant services, with these refusals:

| Case | Result |
| --- | --- |
| Manage (`admin`) on any target | Refused by the platform, the database and the share dialog, which offers only View and Edit. |
| Groups, “all signed-in people” and public links | Grant nothing to a Code account. Only its own direct shares count. |
| App access and Studio | Offer only their own Use level; Edit does not exist there. |
| Templates | Offer only Use (stored as `read`). |
| Creating a resource that needs an initial Manage share, such as an AI Project or Skill | Refused: the account cannot be its first manager. |
| A target without a share, or a target that no longer exists | The target app answers 403 or 404. A setting that names a target grants no access to it. |

A Code account also never receives an API key, an OAuth client or an app key.
See [service accounts](/en/docs/identity/service-accounts).

## Start and follow activation

Submit the immutable version first. The
[current policy and required version approval](/en/docs/platform/code-versions)
must permit it. Authenticate directly to Core with the original interactive
credential.

| Route | JSON body | Result |
| --- | --- | --- |
| `POST /api/code/activate` | `{ codeId, versionId, activationId }` | Durable activation status |
| `POST /api/code/activation/preview` | `{ codeId, versionId }` | Version, approval and credential state |
| `POST /api/code/activation/read` | `{ codeId, activationId }` | Current activation status |
| `POST /api/code/activation/cancel` | `{ codeId, activationId }` | Status after recording cancellation |

Generate `activationId` as a UUID once and reuse it after a lost response. Core
returns the same process. Reusing it for a different Code, version or person
returns a conflict. After a terminal failure, resolve the cause and start with
a new UUID. Status reads require access to the Code; mutation routes retain the
credential's write scope.

The chat version card and `cld code activate` use the preview. It contains the
version's `number`, `running`, `latest`, optional reviewed `automations`, and
`readiness`: `ready`, `approval_pending`, or `refused` with a stable code and
message. `allowed` explains phone or credential restrictions. A running version
also returns `activated`. Preview has no target-rights rows and asks no target
application to plan, inspect or grant access. The Code page's dialog starts the
same durable activation directly.

Status contains `id`, `codeId`, `versionId`, `state`, `failure`, `mandateId`,
`createdAt` and `updatedAt`. Timestamps use ISO 8601 UTC. A failure contains
`{ target: null, code, reason }`; it describes an activation failure, rather
than a target's permission decision.

| State | What to show or do |
| --- | --- |
| `pending`, `preflight`, `applying` | Activation is in progress. Read its status again. |
| `waiting` | An owner or another dependency is unavailable. Core retries; cancellation remains available. |
| `rolling_back` | Core is recording a failed or cancelled attempt. No target shares need compensation. |
| `failed` | Resolve the reported cause and start a new process. |
| `cancelled` | The attempt ended without switching versions. |
| `active` | The version entry and active version committed together. |

Enqueue and cancellation record intent without waiting for an owner provider.
The worker checks current owner authority and approval before switching.
Credential expiration or revocation stops the attempt. Core stores only
revocation coordinates and scopes, never the original cookie or bearer token.
A failure or cancellation leaves the previous version and ordinary target
shares intact. An unresolved response stays visible and can be recovered by
reading the same process ID.

## Version entries and old runs

Core creates one `code.version` entry under app `runner` for the immutable
version. Its subject is the personal owner or the resource or application's
Code service account. Its `policy` is `null`. The
[bridge](/en/docs/platform/code-bridge) applies the Cloud administrator's policy
and required version approval to each actual call; the target application
checks current resource rights. The checker's `manifest.permissions` is review
evidence and grants nothing. Dynamic target IDs are allowed.

Core creates the entry pending and confirms it in the transaction that switches
`activeVersionId`. Pending entries issue no token. An existing entry is reused
only while active, unexpired and bound to the same subject. Activation never
resumes a paused or revoked entry. The authenticated runner path retains the
chain from run to approved version to active subject; it has no API key or
scope fallback.

Old `core`-owned mandates keep their saved operation, target, reference and
input restrictions. Reactivating the same version does not clear them.
Explicitly activate a new version to confirm the new model.

Queued or running work on a superseded version drains with its version entry.
Once it has no open runs, Core revokes that old entry. Ordinary target shares
belong to the service account, persist across version switches and pauses, and
change only through normal sharing. Re-activation, retries and background
cleanup never restore a share a target manager removed.

## Integration contracts

Core's `code/index.ts` exports `codeActivationContracts`, `CodeActivation`,
`CodeActivationState`, `CodeActivationFailure`, `CodeActivationPreview` and
their schemas. CLI and UI use `activateCodeVersion`, `previewCodeActivation`,
`readCodeActivation` and `cancelCodeActivation` with `CodeContext`.
`processCodeActivation` is the trusted worker entry point;
`cleanupCodeActivation` drains old version entries. Applications use the public
[normal share contract](/en/docs/identity/authorization#code-with-access),
without Code adapters or activation proofs.

Core starts activation and drain outbox workers with its normal lifecycle.
Their failures retain attempts and an error for retry. Separate ordered streams
let new activations proceed while old runs drain. For owner checks and deletion,
see [Code lifecycle](/en/docs/platform/code-lifecycle).

## Asking actions and legacy entries

In Administration → Code → Policy, every `ask_*` row is fixed at **Never**.
The editor says “In diesem Release läuft das nicht unbeaufsichtigt.” Historical
defaults and group overrides normalize to `never`; approval cannot enable an
asking action. Migration visibly pauses active versions that declare an asking
row. Silent actions with `routines: false` and sending remain refused.
The review's **What the Code calls** section describes the checked calls; it
does not grant access to their targets.

An active version with a legacy mandate policy shows **Neu bestätigen**.
Its policy continues to restrict every call. Submitting another version changes
nothing. Switching on another version confirms a new entry and atomically
pauses the old policy-bearing entry. New policy-free entries keep their normal
run-draining lifecycle. To confirm again, switch on a new version through the
existing activation flow.
