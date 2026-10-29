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
schema hash, or an approval decision. Ordinary interactive and mandate calls
keep their existing authorization rules. A Query accepting app callers must
handle the additional app context explicitly if it uses caller authority.

An app invocation supplies:

- `actor: { kind: "app", appId }`;
- `accessSubject: { type: "none" }`;
- `user: null`, with no `authority`, nested `query`, or idempotency key;
- the request ID, locale, cancellation signal, and `origin: "app"`.

The app context is confined to capability execution. It never enters ordinary
request authentication, grant checks, or a person fallback. Existing Queries
without `callers` keep their person-context type.

At startup, providers validate every caller against `CLOUD_APP_IDS`, the
operator's deployment inventory. Invalid app-ID syntax fails compilation;
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

- Input: `{ id, userIds }`, with one public element ID and at most 500 person UUIDs.
- Result data: `{ readable: string[] }`, containing only a subset of the supplied people.
- Caller: `chat` only.

They resolve current people with `resolveUserReaders()` from
`@k2b/cloud/services/identity`, then use the owning application's bulk permission
helper. Expired accounts and disabled account categories are omitted; guests
keep the same grants as interactive readers. Service-account IDs are not
person IDs and never become recipients. Bulk permission helpers also preserve
resource bindings and credential scope ceilings when used with service accounts.

Unknown or deleted elements return `{ readable: [] }`, the same answer as an
element none of the candidates can read. These Queries return no title,
content, permission level, or other existence detail. Invalid or oversized
input receives a validation error without a partial result.

Core uses Valkey to limit app Queries to **1,001 requests per calling app per
60-second weighted sliding window**, shared across targets. The budget comes from one
500-recipient Chat delivery batch: one bulk decision plus one badge and one
final send check per person. Additional badge elements, coalesced elements, and
delivery batches share that budget and can delay delivery.
HTTP 429 returns `RATE_LIMITED`; an unavailable limiter fails closed with HTTP
503. Existing delivery jobs retry infrastructure failures and expose failed
work in their administrative controls.

Chat forwards only people who are current participants of the system chat or
followers of its exact item thread. It rechecks the chosen message's element,
and the latest message's element when different, immediately before sending.
System pushes show the chosen message without an aggregate count of earlier
coalesced messages. Chat stores no app-query permission cache. A revoke after
that final check can still race the send; an already queued or delivered notification cannot be
recalled. General system-chat messages have no item or note ID and stay closed
on this item-only contract.

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
