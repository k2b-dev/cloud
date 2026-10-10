---
title: Action approvals
navTitle: Action approvals
section: Identity and access
order: 357
description: How Cloud records, decides, and uses one approval for exactly the Action a person saw.
tags: [identity, approvals, capabilities, audit]
updated: 2026-10-10
---

# Action approvals

When Cloud asks a person to approve an Action, it records the question as one
approval request owned by the platform. The Assistant chat, `cld`, and code in
Assistant Studio ask through the same record, so one decision answers the
question wherever the person gives it.

An application does not opt in. Every Capability Action without
`approval: "none"` asks at the platform's capability boundary, as described in
[Approve Capability Actions](/en/docs/ai/tools-and-approvals#approve-capability-actions).
The application declares its Actions, an optional
[review](/en/docs/platform/capabilities#describe-an-action-before-it-runs), and
its approval sentence; Cloud does the rest.

## What a request records

| Field | Meaning |
| --- | --- |
| Scope | The application that owns the effect and the Action, taken from the capability ID, never from the caller |
| Approval scope | The app-owned scope from the review, used for remembered approvals |
| Requester | Who asked: an Assistant turn and its tool call, or a Studio capability call |
| Approver | The person who may decide: the owner of the chat, or the person running the Studio code |
| Level | `standard` when the Action offers a remembered approval, otherwise `confirm` |
| Sentence and review | What the person read, as a snapshot in their language |
| Input and review digests | SHA-256 over the canonical Action input and over the review snapshot |
| Status | `pending`, then `approved`, `rejected`, `expired`, or `cancelled`; `approved` becomes `consumed` when the Action runs |
| Decided via | The credential the decision came with: `web_session`, `app_session`, `oauth`, `api_key`, or `invocation` |
| Expiry | When an undecided request stops accepting a decision |

The level follows the existing manifest. An Action with
`approval: "rememberable"` and a tool whose policy allows remembering are
`standard`. An Action without `approval`, which includes every destructive and
open-world Action, is `confirm`. Cloud records the level; every place where the
person can decide today accepts both levels.

## Decide once

- **First decision wins.** Two decisions that arrive at the same time, for
  example from two open tabs, cannot both apply. The second one gets the
  existing conflict answer of its route, or succeeds unchanged when it repeats
  the same decision.
- **Only the approver decides.** Another account gets the same answer as for a
  request that does not exist.
- **Requests expire.** A chat request accepts a decision for 24 hours, like the
  turn that waits for it. A Studio capability call waits up to one day. No
  request waits longer than 24 hours.
- **Ending the wait cancels the request.** When a turn stops, fails, or runs
  out of time, its open requests are cancelled.

Rejecting is always possible while the request is open, also when the owning
application is unavailable.

## Use an approval once, for what was shown

An approval is used directly before the Action runs, not when the person
decides. At that moment Cloud computes the input digest from the real input
again and runs the Action's review again. Both must match the snapshot the
person saw. Then the request changes from `approved` to `consumed` in one step,
so it can never run a second time.

| Situation | Assistant chat | Studio code |
| --- | --- | --- |
| Review and input unchanged | The Action runs | The Action runs |
| The review changed, for example a draft got another recipient | Cloud asks again with the current review; nothing runs | The call fails with `CONFLICT`; the person can still decline |
| The approval was already used, for example after a restart during the call | Cloud asks again | The stored result is returned, or `CONFLICT` |

Asking again keeps the call's idempotency key, so an application that already
performed the effect does not perform it a second time.

The input digest binds only the input. When an Action's input refers to state
that can change, such as a draft ID, only the repeated review protects the
person, and only for what the review shows. Give such Actions a revision in
their input, as Mail's `draft.send` does with `expectedRevision`, and check it
in the Action.

## Audit

Every decision writes an audit event `auth.action.approve` or
`auth.action.deny`. Its target is the approval request, labelled
`<appId>.<action>`, and its metadata names the level, the requester, and the
`decidedVia` channel. Assistant tool calls also keep the channel next to their
approval state.

Approval requests are deleted with the capability execution records, 90 days
after they expired.

## Remembered approvals stay separate

**Approve for this chat**, **Always approve**, and allowed websites are still
stored as preferences in Assistant and resolve a later call without a new
request. Only a person in a signed-in browser session can remember a website.
Scheduled tasks and mandates never ask and never use a remembered approval;
see [Background mandates](/en/docs/identity/background-mandates).

## Platform-owned service

`@k2b/cloud/services/approvals` holds the table, its migration, and the
`request`, `decide`, and `consume` functions that Core and Assistant use. It is
platform-owned, not an application API: applications receive approvals through
their Capability Actions.

## Upgrade

Core creates the `approvals.requests` table on start and gives every chat
approval that is still open a request, with the same digests the running
Assistant computes. A Studio capability call that was waiting during the
upgrade receives its request when the person decides. People see no change,
except that a chat Action whose review changed since the question asks again
instead of running.
