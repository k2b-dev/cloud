---
title: Pair devices and open customer visits
navTitle: App-PWA sessions
section: Identity and access
order: 535
description: Let an employee pair a shared device while the application authorizes each customer visit.
tags: [pwa, devices, visits, sessions, shared devices]
updated: 2026-11-03
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

## Register a shared device

A reception iPad that several employees use can be registered once instead of
paired by each person. Issue the device with `register: true`. Its QR is a
normal device QR, and the device claims it with the same scanner. The
registration needs the staff action `register-device`, not `issue-device`.

A registered browser stays bound to this application for up to 400 days, the
upper cookie lifetime that browsers allow. Its guest cookie then persists
across restarts. The registration itself grants nothing: Cloud data and visits
reach the device only through a current *use*. The employee who registers it is
its first user.

A use is an ordinary device in the table above, with an owner, the owner's
current web session, and at most 12 hours. It ends on logout, authority
invalidation, revocation, expiry, or a takeover. When it ends, the device stays
registered and shows its waiting screen; it does not return to pairing.

### Take over a device

`registrations/list` (`list-registrations`) returns every registered device of
the application, not only the caller's. Each item has `holder` with the current
user's ID, display name, use `deviceId`, its expiry, and `visitActive`, or
`null` when nobody uses it. The staff list falls back to the login name.

`registrations/take-over` (`take-over-device`) takes `{ registrationId,
expectedDeviceId, presenceCode }`. The device shows a six-digit presence code
on its waiting screen; the employee types it at the desk. This proves that they
stand at that device and replaces the QR scan. The code changes every 30
seconds, and the previous code is still accepted. It is bound to the
registration and its browser, so a code from another device never matches, and a
registration whose browser is gone can no longer be taken over. An empty or
wrong code returns `403 PRESENCE_REQUIRED`; a request without the
`presenceCode` field is `400 INVALID_INPUT`. Each registration accepts five
attempts per 30 seconds, correct or not; more return `429 RATE_LIMITED`. A
Valkey failure returns `503 UNAVAILABLE`.

A free device is taken without confirmation. When someone else uses it, Cloud
returns `409 IN_USE` unless `expectedDeviceId` is the use the staff page showed.
Ask the employee to confirm the displayed holder, then send that
`holder.deviceId`. A use that changed in the meantime is never replaced
silently. A retry from the session that already uses the device returns its
current use.

A takeover ends the previous use and its running visit in the same transaction
and records `app_pwa.registration.taken_over` with the new user as actor,
`previousDeviceId`, and the ended `visitId`. `previousOwnerUserId` is set only
when the previous use was still live; it is `null` for a free device. End your
own use with `devices/revoke` and its `deviceId`. `registrations/revoke`
(`revoke-registration`) unregisters the device: its use and visit end, and the
browser must bootstrap again.

Listing, taking over, and unregistering act on other people's state. By default
any employee whom `authorizeStaff` admits for the action can do so for every
registered device of the application. Cloud calls `authorizeStaff` once without
a target and again with `target: { registrationId, name }` for the registration
being taken over or unregistered, and for each listed registration. These
checks repeat before the transaction commits. Return `false` to narrow the
action, for example to one location's devices. A listed registration that the
app refuses is left out of the page.

### Show who uses it

Guest `status` returns `registration` for a registered browser:
`{ id, name, expiresAt, holder, presence }`. `holder` is `{ displayName }` while
a use is live and `null` otherwise. `presence` is `{ code, expiresAt }`; poll
`status` at least every 30 seconds and show the current code. Staff responses
never contain it. Without a use, `device` and `visit` are `null`.
The device only learns the display name; it never receives an account ID,
login name, or contact detail, and an empty display name is `null`. Show the
name so customers and staff can see whose device it is.

### Send a visit without a QR

`visits/issue` with `push: true` works for any active device that the caller
owns: a device they paired by QR or their current use of a registered device.
The visit opens immediately, bound to that device's browser, and appears on the
next `status` poll. `qr` is `null`. `authorizeVisit` still decides the subject,
and deadlines start at issuance. A live visit on the device returns
`409 ACTIVE_VISIT`; end or revoke it first. Repeating the request ID returns
the same visit. Nobody else can push to a device.

### Recover on the device

On `401` or `410`, call `bootstrap` and then `status`. A registered browser keeps
its credential through bootstrap and gets `registration`; show the waiting
screen. Otherwise show pairing. A device on an older Cloud package treats the
end of a use as terminal and must be registered again, but it never gains
authority from a registration.

## Keep the authorities separate

| Action | Authority |
| --- | --- |
| Issue a device, list it, or revoke it | Current authenticated web session, application staff authorization, and device ownership |
| Push a visit to a device | Current web session, `issue-visit` and visit authorization, and ownership of that active device |
| Register a shared device | Current web session and `register-device` authorization; the registering employee becomes its first user |
| List registered devices or unregister one | Current web session and application staff authorization for that registration; app-wide unless the app narrows it, no device ownership |
| Take over a registered device | Same as listing, plus the presence code shown on that device and confirmation of a live holder |
| Open, read, or complete a customer's visit | Paired device and browser, current visit, and the application's visit and document rules |
| Suggest addresses through an allowlisted Core query | Current pairing and visit, charged to the owner’s Geo budget |
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

## Offer address suggestions

Declare `coreQueries: ["address.autocomplete"]` in `createAppPwa()` to offer
address suggestions on a paired device. The default is an empty allowlist.
Unknown queries and actions fail at construction; autocomplete is the only
supported query. The existing `queries` map still holds application-owned
visit queries.

The closed guest route `core/query/address.autocomplete` accepts
`{ visitId, input }`, with the same cookie, CSRF, Origin, JSON, and byte budgets
as other guest operations. With an explicit `visitId`, the visit must be live;
an expired, ended, or revoked visit never falls back to device authority.
Without `visitId`, a live visit still binds the call. After that visit ends,
device mode resumes while the pairing remains valid. Queries never renew a visit.

```ts
const response = await fetch(`${guestApiPath}/core/query/address.autocomplete`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-App-Pwa-CSRF": csrf },
  body: JSON.stringify({ visitId, input: { text: "Example Str", countryCode: "de" } }),
  signal,
});
```

A successful response is the [autocomplete data](/en/docs/platform/places-and-maps)
(`suggestions` and `provenance`). Keep the linked Geoapify · OpenStreetMap
attribution beside the suggestions. Address text is limited to 3–300 characters
and results to five suggestions. Locale follows the request's normal Cloud
locale preference.

This is the narrow exception to the ownership rule above: the platform's
App-PWA adapter may use the validated pairing owner as the autocomplete budget
subject. It calls the same Geo service as the owner's Core query, preserving
the device or visit actor rather than creating an employee request actor.
It creates no bearer token, employee cookie, mandate, or arbitrary cross-app
invocation. Application code must continue to use the closed route.

Cloud checks pairing, browser, initiating web-session authority, and any visit
in short transactions before and after the lookup. No database lock spans the
provider request. A changed, expired, or revoked authority refuses the response;
provider work already sent can still consume credits. An in-flight call cannot
switch from one visit to another, or from a visit to device authority. If a visit
opens during a device-mode lookup, `503 UNAVAILABLE` asks the client to refresh
status and retry. A paid lookup can also consume credits before the application's
response-byte budget refuses an oversized result.
Revocation and expiry use the existing 401/410 errors. An undeclared query
returns `403 FORBIDDEN`. Valkey separately limits the device and visit, including
cache hits, to the smaller of `security.rate_limit_per_second` and the Geo plan's
requests per second. `429 RATE_LIMITED` means that request budget was reached.
A Valkey failure returns `503 UNAVAILABLE` and does not call the Geo service.

Paid lookups count against the owner's existing daily budget and the Cloud
monthly budget; cache hits remain free. Geo failures retain their own `code`.
`429 GEO_BUDGET_EXHAUSTED` includes only `scope` and `resetsAt` in `details`;
other Geo errors contain no details. Employee and operator balances and provider
costs stay private. Show budget recovery separately from a request-rate refusal.
The audit entry `app_pwa.core.query` records the owner in `metadata.subject` and
the device or visit in `metadata.via`. It leaves the employee actor unset and
stores no address input or results. Failed lookups and refusals after a lookup
are recorded too. No content is created, so this read has no content-provenance stamp.

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
staff authorization. `authorizeStaff(action, signIn, tx, target?)` checks staff actions;
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
| `core/query/address.autocomplete` | `{ visitId?, input }` |
| `query/<name>` | `{ visitId, input }` |
| `command/<name>` | `{ visitId, attemptId, input }` |
| `visit/attempt` | `{ visitId, attemptId }` |
| `visit/end` | `{ visitId }` |
| `device/<name>` | `{ input }` |

The staff protocol provides `bootstrap`, `devices/issue`, `devices/list`,
`devices/status`, `devices/revoke`, `visits/issue`, `visits/revoke`,
`registrations/list`, `registrations/take-over`, and `registrations/revoke`. Lists
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
