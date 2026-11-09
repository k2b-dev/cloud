---
title: Operate Code requests
navTitle: Code requests
section: Operations
order: 920
description: Size and diagnose Code route requests in the shared runner pool.
tags: [code, runner, limits]
updated: 2026-11-09
---

# Operate Code requests

Code routes run through Core and the shared runner pool. They have an
eight-second deadline including queueing, capped further by
`core.code.wall_clock_ms`. Existing `core.code.runner_slots`,
`core.code.concurrency_per_code`, `core.code.concurrency_per_owner` and
per-run capability call limits apply. Admission refuses excess work with 503;
there is no unbounded HTTP queue and no automatic request replay after failure.

The HTTP contract limits bodies to 8 KiB, public bodies to 4 KiB and responses
to 128 KiB. Public routes share 20 requests per minute per client network and
per Code across Core replicas, enforced through Valkey. A 429 response carries
`Retry-After`. Unsupported body content types return 415; oversized bodies
return 413, including streamed requests.

Use the Code page's route entrypoints and Runs to inspect outcomes, queue and
execution timestamps, and capability refusals. Request input and output are
cleared when the waiting request ends. Capability calls retain the existing
Code audit and retention contract. A client disconnect cancels admission or
fences the current lease; it does not roll back committed domain effects.
Do not blindly retry a failed POST: read the domain state first and use the
capability's idempotency contract when repeating an intended effect.

Core declares `/code` in the gateway registry and checks each path against the
active version's manifest. Sign-in is required unless that exact matched route
was reviewed as public. Public responses contain only the data that Code
returns. Public routes never use visitor session authority, CSRF tokens or
an anonymous binding cookie; public forms omit the token. Non-public mutations
still require a session-bound CSRF token. Incoming request headers and cookies
are not forwarded to Code. R1 webhooks use ordinary public POST routes without
signature verification; handlers take an ID, read its state back with bound
secret HTTP, then act ([example](/en/docs/platform/code-sdk#webhooks-r1-ohne-secret)).
Keep the shared runner, NATS, Postgres and Valkey healthy; request
capacity competes with scheduled runs and authoring checks.

Page responses use wire format version 1 and the same runner response budget.
Core validates the whole tree at completion and again before rendering. Invalid
page descriptions fail the run and return 503. The first renderer limits the
tree to 64 KiB, 256 nodes and 12 levels, with 200 rows per table and 40 fields
per form. Page inputs, trees and visitor identities are transient; the retained
run records the outcome and timings. Rendering uses Core's assets and only the
checked description reaches the browser; no Code source runs there.

## Mail capability compatibility

Deploy Mail and its capability consumers from the same release. R1 names the
text readers `mail.message.content.read` and `mail.attachment.text.read`;
`mail.attachment.content.read` opens the original file as a stream. Refresh
generated SDKs and resubmit preview Code after upgrading. There are no aliases
for the previous text-reader names; update external capability clients as
described in [Deprecations](/en/docs/reference/deprecations-and-migrations#code-sdk-declarations-are-simpler).

## Schedule and result delivery compatibility

Code schedules use one declaration, `{ cron | at, timeZone?, name?, title? }`.
When `timeZone` is omitted, Core uses the instance setting `app.timezone`
(default `Europe/Berlin`). Existing checked schedules without a zone inherit
that setting too. Changing it changes future ticks of those schedules; use an
explicit IANA zone when a schedule must keep its own wall-clock time.
Handlers receive `{ runId, scheduledAt, input }`; retry attempts keep the same
run ID and original scheduled instant. Action idempotency keys have the same
principal/capability scope across runs for at least 24 hours, including chat delivery
and chat turns. Include the intended occurrence in keys for recurring effects.
Grids workflows retain their own schedules. Old Assistant routines are retired;
rebuild them as Code.

All non-public Code routes now admit every signed-in person, including routes
owned by a person. Handlers restrict access through the explicit `c.user`
identity before reading or changing data. SDK calls retain the Code account's
grants. Public routes always receive `c.user === null`. Previously checked non-public page bundles fail closed with 503 after this SDK update until they are resubmitted; schedule old page versions for resubmission before upgrading a development stack. Resubmit old sources
using `c.user.groups` or `provider`: the supported fields are `id`, `username`,
`groupIds`, `groupNames`, `kind` and `name`.

Core adds `code.chat_deliveries` as an additive migration. Personal Code chat
results commit their messages and receipts together. The existing Assistant
notification recovery worker publishes the response notification, normally
within one minute, and retries with a stable key after failures. Keep that
worker running; a failed notification never repeats the chat message. Delivery
receipts follow Code run retention; the chat message remains ordinary chat
history. Inspect the run's capability calls to diagnose a refused delivery.

## Rebuild scheduled Assistant routines

Rebuild an open-ended routine as personal Code with `app.schedule` and
`core.ai.chat.run`, preserving its prompt, destination and explicit time zone.
Use `{ at, timeZone }` for one-time work and `{ cron, timeZone }` for recurring
work. Export definitions on the old release before upgrading. The upgrade stops
all old routines; it does not activate replacements. Ask Gustav to rebuild and
review the new Code, then enable its schedule. See
[Routines became Code](/en/docs/operations/routines-to-code).

The replacement starts a normal turn in the owner's chat. Required approvals
wait there and the Code run ends promptly; this differs from routines that
refuse approval-needed tools. Each provider call uses the owner's normal
interactive AI budget and settles to actual usage. The existing Assistant USD
budget rules, when enabled, supply the bound and reset window; no new count
setting is added. Disabled Assistant budgets retain normal unlimited owner usage.
The existing Code and Code-owner daily USD limits also count these actual
costs. A turn never allocates the full Code attempt allowance, so several cheap
turns can run without consuming the full allowance for `core.ai.generate` and
`core.ai.decide`. The normal loop and step limits still bound each turn. See the
[capability contract](/en/docs/platform/capabilities#start-personal-code-chat-turns)
for states, budget codes and a cost example. Bounded text tasks can keep
`core.ai.generate` instead of starting a tool-using turn.

Core adds `code.chat_runs` without altering routine definitions. Receipts
follow Code run retention; ordinary chat messages and turns retain their own
history. Keep the normal AI worker and sweep running so committed queued turns
recover after a failed wake-up. A waiting turn appears in the chat and remains
subject to its normal wait and execution limits.

## File transfers

Core now transfers a Code FileRef directly between capability providers.
The additive `code.file_redemptions` table holds only spent-reference digests,
scoped to each run and removed by existing run retention. No new service or
configuration is needed. Each source read at redemption uses the ordinary
per-run call budget; binary bodies do not use the JSON bridge budget.

A failed import attempt spends its FileRef. Inspect the destination's domain
receipt and the run's calls before recovery. Read a fresh reference and keep
the intended import's business idempotency key. Expired references and references
from another attempt cannot be resumed. Providers remain responsible for
reclaiming abandoned upload reservations. Cancellation does not undo a
publication already committed by the receiving application.

## Middleware in checked Code

The generated SDK supports `app.use()` for HTTP routes registered after it.
Keep Core, checker and runner images on the same release, and pull the current
SDK before checking sources that use middleware. Existing checked versions
continue using their bundled SDK. Middleware adds no policy classification;
its SDK calls use the version's ordinary declared capabilities and the Code
account's current grants. Request variables remain transient, per request.
See [Middleware and request variables](/en/docs/platform/code-sdk#middleware-and-request-variables).

## Event place compatibility

`app.on(handle, event, handler)` can subscribe to a readable place in another
app. Existing mailbox handlers without a handle keep their owner and
entrypoint names. Activation checks the executing account's read access;
every Runner attempt repeats that check. Withdrawn access leaves a visible
`resource_access_revoked` delivery or run and sends no event to the Runner.
Restore the share before using Retry delivery or Run again. An unavailable
readability provider prevents execution and follows the existing recovery
budget.

The generic event-place readability query is generated from the ordinary Type
reader when the application has no explicit batch-readable hook. Deploy the
publisher apps with the same platform release before activating new event
places; an older app manifest may not yet expose this query.

`core.code.event_backlog` also bounds active registrations per Code; no new
transport or queue is installed. Handlers at one place share ordered admission
and execution even when they react to different event types. Catch-up uses
the same saved snapshots and checkpoints as Mail, only for events whose
publisher declares a catch-up reader. See [Code runs](/en/docs/platform/code-runs#understand-event-deliveries).
