---
title: Pair devices and open customer visits
navTitle: App-PWA sessions
section: Identity and access
order: 535
description: Let an employee pair a shared device while the application authorizes each customer visit.
tags: [pwa, devices, visits, sessions]
updated: 2026-10-23
---

# Pair devices and open customer visits

Use an [App-PWA](/en/docs/frontend/app-pwa) for a shared device on which a
customer reads or signs documents without a Cloud account. An employee owns
the paired device. The device acts as a device, and a customer acts through a
visit; neither receives the employee's identity or credentials.

The application decides what each visit permits. Cloud supplies pairing,
browser binding, expiry, revocation, attempt reconciliation, and the transaction
that joins these checks to the application's domain writes.

## Pair by scanning

The employee opens the application's device page in an authenticated web
browser, names the device, and requests a pairing QR. The device opens its own
scanner and scans that QR. A QR lasts at most two minutes and can bind only
one browser. The employee page then shows the paired device's name and a
revoke action. There is no phone, comparison code, or pasted-link flow.

After preparing a customer's visit, the employee shows a visit QR for that
device. Its scanner opens the visit, binding it to the paired browser. A
second browser cannot claim it. A live visit cannot be replaced with another
customer's visit; end or revoke it first.

A repeat claim from the same browser recovers a lost response. Repeating an
issuance request with the same request ID rotates an unclaimed secret on the
same record, without extending its original deadline. If it was already
claimed, issuance returns its state with `qr: null`. The employee UI must show
that state instead of attempting to render a missing QR. A new request ID
starts a new issuance.

## Keep the authorities separate

| Action | Authority |
| --- | --- |
| Issue a device, list it, or revoke it | Current authenticated web session, application staff authorization, and device ownership |
| Open, read, or complete a customer's visit | Paired device and browser, current visit, and the application's visit and document rules |
| Use a declared Cloud resource operation | Explicit device permission ceiling intersected with the owner's current resource grants |

The owner can issue visits from another currently authorized web browser while
the original pairing session remains valid.

Customer commands do not intersect the employee's resource grants. For
example, the application may let a customer sign a document offered by their
visit without granting the pairing employee permission to read that document.

Use `AppPwaDeviceActor` and `AppPwaVisitActor` in handlers. `ownerUserId` records
ownership; do not convert it into an employee request actor, bearer token, or
session cookie. `appPwaDeviceOperation()` provides a local service adapter
with current Cloud resource-grant checks. It does not create cross-application
invocation credentials or authorize arbitrary downstream services. The adapter
must preserve device provenance when it calls its owning service.

## Choose lifetimes

`deviceTtlSeconds` chooses the device lifetime. A positive requested value
above 12 hours is capped at 12 hours. The initiating web session's remaining
lifetime and browser binding may shorten it. Logout of that session, owner
authority invalidation, or device revocation also closes access. Device lists
report that earlier device as expired or revoked even after its owner signs in
again.

A visit expires after 15 minutes without a newly committed command, or after
60 minutes in total, or when its device expires. Queries, status polling,
claim retries, and repeated command attempts never extend these deadlines.
Do not send a heartbeat command merely to keep a visit alive.

## Create the service and closed router

Import these server APIs from `@k2b/cloud/app-pwa`:

- `createAppPwa()` returns `service`, `router`, and `setup`.
- `appPwaQuery()` validates a read's input and output without renewing the visit.
- `appPwaCommand()` validates a command and runs it with attempt reconciliation.
- `appPwaDeviceOperation()` declares a local device operation and its resource permission.
- `AppPwaError` reports a stable transport code and status for an application rejection.

Pass the application ID and declared `installable.path`, a canonical configured
HTTPS `publicOrigin`, its Postgres `schema`, a subject schema, and application
staff authorization. `authorizeStaff(action, signIn, tx)` checks staff actions;
`authorizeVisit(signIn, subject, tx)` must separately authorize exposing the
validated domain subject to a customer. Both are required and repeated before
issuance commits. Lock the subject's domain authority with `tx`; a schema-valid
resource ID alone is not permission to create a visit. Supply explicit `budgets` for request and response bytes,
list page size, and the maximum resource IDs checked by an operation. Size
these for the actual document and signature format. An oversized request,
response, or stored attempt result is rejected.

Register the finite `queries`, `commands`, and optional `deviceOperations`
maps. Missing operations are denied. Registering a device operation alone
grants nothing: `devicePermissions` must declare its permission ceiling too.

Run `setup()` in the application's normal startup setup, before listening.
It creates reserved `_cloud_pwa_*` tables in the application's schema. A failed
setup leaves the service unavailable. Keep these tables in the application's
normal database backup and data-management contract.

Mount `router.fetch` at the returned `guestApiPath` and `staffApiPath` without
adding routes inside it. The guest path is `<installable.path>_api/`; the staff
path is `/api/<app-id>/app-pwa/`. The router exposes only its declared protocol,
not a generic authenticated Hono context. Configure the installation's public
page and guest API as explicit public app-access routes. The staff API still
requires its own current web session and application authorization.

## Write within the visit transaction

A query receives `{ actor, tx, signal }`. A command also receives `endVisit()`.
Read the visit's validated `actor.subject`, authorize the offered domain
resource, and use the supplied `tx` for every domain read and write. Check the
current document revision, whether it was offered to this visit, consent, and
the signature format on the server. Never accept the browser's display model
as authority.

For a final action, call `endVisit()` after the domain write. The domain result,
attempt record, and visit completion commit together. A rollback leaves none
of them committed. Device and visit revocation use the same authority and
session locks as the command. Do not write through another connection, and
do not send external effects from the handler; persist an outbox record in
`tx` when delivery must survive a crash.

Commands carry a client-generated `attemptId`. Keep it for retries of that
same route and validated input. Reusing it for different input is rejected.
If the response is lost, query that attempt before offering another signature.
An attempt lookup returns `{ state: "unknown" }` or
`{ state: "committed", completed }`. `completed` means the visit ended through
`endVisit()`; a committed command alone does not prove that the whole visit
completed. Terminal command replays also include this flag with `result: null`.
Neither response exposes stored customer content after terminal state. A new customer cannot read an earlier visit's
result.

Handlers must honor `signal` and finish inside Cloud's bounded request budget.
The transaction checks current database time after waiting for locks and again
before COMMIT, after deferred constraints have been checked. Cancellation and
the remaining request and authority budgets guard SQL through COMMIT. The
platform requests PostgreSQL cancellation and keeps the connection out of reuse
until cancellation and cleanup settle. It discards the cancelled connection.
COMMIT may become durable before cancellation takes effect; those writes remain
committed. A timeout or lost response therefore leaves the outcome uncertain:
reconcile the same attempt before offering another signature.
A pending UI must not infer success or rollback from a timeout.

## Use the browser protocol

Import `parseAppPwaQr()` and `clearAppPwaFragment()` from
`@k2b/cloud/app-pwa/browser`. The parser accepts only the configured HTTPS
origin, exact installation path, QR kind, and secret format. Never navigate to
or fetch the scanned URL. Clear a directly opened fragment before asynchronous
work; it is not an alternate claim flow.

All protocol requests are same-origin JSON `POST` requests. Bootstrap returns
a CSRF value and sets a generated, host-only `Secure`, `HttpOnly`, `SameSite=Strict`
cookie scoped to the installation path. Send `X-App-Pwa-CSRF` with subsequent
requests. The staff bootstrap binds its CSRF value to its web session instead.
Requests require the exact configured `Origin`; there is no CORS grant or
GET mutation. Rate limiting uses Cloud's existing request budget.

| Guest operation | Body |
| --- | --- |
| `bootstrap`, `status` | `{}` |
| `device/claim`, `visit/claim` | `{ qr }` |
| `query/<name>` | `{ visitId, input }` |
| `command/<name>` | `{ visitId, attemptId, input }` |
| `visit/attempt` | `{ visitId, attemptId }` |
| `visit/end` | `{ visitId }` |
| `device/<name>` | `{ input }` |

The staff protocol provides `bootstrap`, `devices/issue`, `devices/list`,
`devices/status`, `devices/revoke`, `visits/issue`, and `visits/revoke`. Lists
return `{ items, next }`; pass `after: next` for another bounded page. Issuance
returns `qr` and `qrExpiresAt` alongside state. Treat QR content as a transient
secret: do not log, persist in browser storage, or put it in a navigated URL.

## Return to a neutral screen

Keep unfinished signatures and sensitive display state only in memory. Hide
them on page hide, visibility loss, and loss of connection. On return,
reload, or Back, revalidate before showing customer content. Aborted or late
responses must not restore a previous customer's view.

Show distinct pending, unknown, rejected, and confirmed states. If ending a
visit loses its response, conceal the content immediately but do not announce
that the server has confirmed the end. Provide status recovery. An expired or
revoked device must return to pairing without manual cookie removal.

Use an iPad browser profile with no employee sign-in. Installation paths are
not separate origins; applications on the same origin share a script trust
boundary. See [App-PWA installation](/en/docs/frontend/app-pwa) for the neutral
offline page and restart-only worker updates.
