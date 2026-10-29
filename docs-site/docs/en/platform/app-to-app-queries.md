---
title: App-to-app queries
navTitle: App-to-app queries
section: Platform services
order: 563
description: Allow an authenticated application to call a narrowly declared read-only query without a person's mandate.
tags: [capabilities, identity, authorization, background]
updated: 2026-10-29
---

# App-to-app queries

Use an app-to-app Query when the provider can authorize a small read-only
operation for the calling application itself. Use a [mandate](/en/docs/platform/capabilities)
when background work acts with a person's or service account's rights. Actions
always require that existing authority path.

This contract is a draft for maintainer review. Its first consumers are Chat's
reader checks for Spaces items and Notebooks notes.

## Declare the trust boundary

A Query may declare `callers: readonly string[]`, containing exact application
IDs. A missing or empty declaration grants no application access. Actions
cannot declare `callers`: the types and startup compiler reject it. App callers
cannot use streams or exchange their invocation for a nested Query.

The dispatcher in Core checks the declaration against the app identity from
the workload credential. A caller cannot supply a person, grants, scopes,
schema hash, or an approval decision. Declaring `callers` makes the Query
app-only: ordinary person, service-account, mandate, MCP, and Assistant calls
cannot invoke it. Queries declaring `callers`, including `callers: []`, are
omitted from the REST capability catalog, MCP `tools/list`, and the AI capability
catalog. All three catalogs use the same person-visible Query filter.
Core and the provider compiler enforce this before the handler runs.

An app invocation supplies:

- `actor: { kind: "app", appId }`;
- `accessSubject: { type: "none" }`;
- `user: null`, with no `authority`, nested `query`, or idempotency key;
- the request ID, locale, cancellation signal, and `origin: "app"`.

The app context is confined to capability execution. It never enters ordinary
request authentication, grant checks, or a person fallback. Existing Queries
without `callers` keep their person-context type.

At startup, providers validate every caller against the platform's built-in
application IDs plus `CLOUD_APP_IDS`, the operator's additional third-party inventory. Invalid app-ID syntax fails compilation;
an unknown ID fails startup before catalog publication. Inventory entries do
not grant access: the Query must still name the caller, and Core must authenticate
its current workload credential. Optional or offline apps can be in the
inventory without forcing a startup order.

## Call through Core

Use `invokeCapabilityWithDataSchema()` from
`@k2b/cloud/capabilities/server`, passing `workload: { appId }` and the owning
app's `CLOUD_APP_CREDENTIAL` as Bearer authorization. Set
`CLOUD_CORE_INTERNAL_ORIGIN` to Core's direct listener. Never forward the
workload credential to the target application.

The client uses `POST /api/_internal/identity/v1/invoke` with `kind: "query"`,
`targetApp`, `capabilityId`, and `input`, omitting both mandate fields. Providing
only one mandate field is invalid. Providing both retains the existing mandate
path. The gateway blocks these internal paths.

Core sends a separate signed `app_query` token to the framework-owned
`/api/_internal/capabilities/v1/app-queries/:capabilityId` endpoint. It binds the
caller, target, exact input, operation, schema, workload credential, request
ID, and a 30-second lifetime. The provider verifies that token and rechecks
that the workload credential is active, unexpired, correctly bound, and still
has `identity:invoke`. It also enforces the local caller declaration. A person
invocation token cannot enter this endpoint, and an app-query token cannot
become a person invocation. Redirects never receive the source workload credential.

## Keep the answer bounded

The first two Queries are `spaces.item.readable` and `notebooks.note.readable`:

- Input: `{ id, container: { type, id }, userIds }`, with one public element ID,
  its expected container ref, and at most 500 person UUIDs. Spaces requires
  `container.type = "spaces.space"`; Notebooks requires `"notebooks.notebook"`.
  Container IDs are public IDs from the system conversation, never inferred from the element.
- Result data: `{ readable: string[] }`, containing only a subset of the supplied people.
- Caller: `chat` only.

They resolve current people with `resolveUserReaders()` from
`@k2b/cloud/services/identity`, then use the owning application's bulk permission
helper. Expired accounts and disabled account categories are omitted; guests
keep the same grants as interactive readers. Service-account IDs are not
person IDs and never become recipients. Bulk permission helpers also preserve
resource bindings and credential scope ceilings when used with service accounts.

Unknown or deleted elements, and elements outside the expected container,
return `{ readable: [] }`, the same answer as an element none of the candidates
can read. The owner checks the element's current container and the candidates'
current rights in that container. These Queries return no title,
content, permission level, or other existence detail. Invalid or oversized
input receives a validation error without a partial result.

Core uses Valkey to limit app Queries to **1,501 requests per calling app per
60-second weighted sliding window**, shared across targets. For one
500-recipient delivery batch, Chat needs one bulk query plus up to two fresh
final queries per recipient (chosen and latest elements): **1,001 background
requests**. Push badge computation uses the interactive allowance below.
More batches, retries, or other app-query traffic share this finite budget;
this is capacity for one batch, not a throughput guarantee.
HTTP 429 returns `RATE_LIMITED`; an unavailable limiter fails closed with HTTP
503. Delivery jobs retry failed checks and expose exhausted retries in their
administrative controls.

Chat batches recipient checks per element. Interactive counts cache only yes/no
results per person, expected container, and element for at most **60 seconds**.
An atomic cache reservation prevents concurrent misses for the same key.
Before contacting Core, Chat admits at most **100 uncached element checks per
person** (one candidate page) and **500 across all interactive traffic** (one
five-page scan) per weighted 60-second window. Per-person admission precedes
global interactive admission; rejected requests never reach Core. An admission
rejection releases its own cache reservation with an atomic UUID comparison,
so the next request can retry admission immediately without waiting 60 seconds.
It cannot remove a newer reservation or result. This leaves
1,001 Core slots for background checks within the stated batch budget, even
when interactive misses flood the counter. Admission or provider failures
omit those elements from badge and For you counts and are logged. Counts may
undercount until admission or the cache recovers. A cached count can lag a
revocation by at most 60 seconds; cached counts never authorize a push.

Chat forwards only people who are current participants of the system chat or
followers of its exact item thread. Delivery and the final checks always ask
the owner afresh. Final checks cover the chosen and latest message elements
when different, each bound to the system conversation's container. Owner calls
and badge preparation run outside database transactions. Short write
transactions validate the prepared cursor, pending messages, local membership,
resource refs, read state, and notification preferences before enqueueing.

For system pushes, a monotonic **three-second** deadline starts immediately
before final reader preparation, before the first owner call. Immediately
before calling `notifications.send`, elapsed time must be **less than 3,000 ms**.
This includes all final owner round-trips, connection acquisition, row-lock
waits, and local validation, even when two elements need checks. Each lock wait
in that write transaction is limited to **one second** with transaction-local
`lock_timeout`. A lock timeout or an expired deadline keeps the pending push
and resubmits it immediately; preparation starts again with fresh owner checks
outside the transaction. The deadline bounds entry to the enqueue operation,
not its completion or device delivery. Sustained contention or slow owners can
delay delivery through retries; they do not extend a prepared decision's validity.

Read snapshots consume only previously resolved count decisions; new or expired
candidates fail closed until a subsequent read.

System pushes show the chosen message without an aggregate count of earlier
coalesced messages. A revoke after the final check can still race the send;
an already queued or delivered notification cannot be recalled. General
system-chat messages have no item or note ID and stay closed on this item-only
contract.

## Inspect calls

Core records the normal capability execution row, including failures. App calls
use `actor_kind = 'app'`, the caller in `via_app_id`, and null person, actor UUID,
and access-subject fields. The row includes target, Query, outcome, request ID,
and invocation ID. Input and result metadata describe shape only; they do not
store element IDs or reader lists. The handler receives the same request ID
for joining an application audit trail.

Execution history remains a bounded, best-effort observational write: a history
storage failure is logged and does not turn a successful read into a failure.
See [Chat notifications](/en/docs/operations/chat-notifications) for setup and
health checks.
