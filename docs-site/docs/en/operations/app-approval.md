---
title: Integrate an authenticator website
navTitle: App approval API
section: Reference
order: 1277
description: Pair per-account device keys and approve browser-bound Cloud sign-ins from a separate, multi-cloud authenticator.
tags: [authentication, accounts, security, api]
updated: 2026-10-20
---

# Integrate an authenticator website

Core provides `cloud-app-approval-v1` for a separately hosted authenticator.
One website can connect directly to multiple Clouds, with a separate key pair
for every Cloud/account pairing. There is no central credential server or
Cloud-cookie sharing.

Cloud includes app sign-in, device management under **My account → Security**,
and administrator-assisted pairing and device revocation from a user's
Accounts detail page.
The [Cloud Login authenticator](./cloud-login.md) is deployed separately. Existing email, FreeIPA
password and passkey sign-ins remain available; enabling app approval does not
remove them or grant Linux access.

Cloud Login approves sign-ins and [Action approvals](/en/docs/identity/approvals)
over the same signed device channel.

## Choose the trusted website

Operators should follow [Set up app sign-in](/en/docs/accounts/app-sign-in)
for configuration and deployment prerequisites.

The authenticator origin is a credential trust boundary. Compromised JavaScript
or a malicious service-worker update can use stored keys for paired Clouds.
Non-extractable keys prevent ordinary export, not malicious same-origin signing.
Changing the allowed origin does not revoke device credentials.
HTTP loopback origins work only outside production. The issuer is the canonical
origin of `app.url`, never the incoming Host header.

## Pair a device

In Cloud, open **My account → Security → Pair a device**. Scan the QR code,
copy its pairing link into the authenticator, or choose **Open app on this
device**. All three paths transfer the Cloud URL and the same short-lived
pairing secret. Keep the Cloud page open, compare the six-digit codes shown
in Cloud and the authenticator, then explicitly confirm that they match.
If this account already has an active paired device on this Cloud, open Cloud
Login on that device and approve the new pairing. The first device pairs as
soon as the codes are confirmed. Leave the new authenticator open until it
confirms completion.

Administrators with assisted pairing enabled start from **Accounts → Users →
the user → Pair sign-in app**. The pairing page names the target account and
warns that the device will be able to sign in as that user. The service checks
the administrator's current authority, session, and policy again on confirmation.

Enrollment, rename, and revoke require a session created within the last ten
minutes. When it is older, Cloud offers **Sign out and sign in again**, returning
to the relevant page after authentication. Start unfinished pairings again
after signing in: their original session cannot be replaced.

Pairing reloads retain only the pairing ID and expiry in tab-scoped session
storage, scoped to the initiating and target users. No pairing secret or
transfer link is stored. A pairing already received by the app can be resumed;
otherwise cancel it and start again. Closing the page does not cancel the
server request; unconfirmed pairings expire after five minutes. A request for approval gives
the paired device five minutes to decide and extends the pairing to cover that
time.

Use the public browser SDK for an independent PWA:

```ts
import { appApproval } from "@k2b/cloud/browser/app-approval";

const pairing = appApproval.parsePairingLink(pastedLink, location.origin);
// Show pairing.issuer and obtain explicit consent before connecting.
const client = await appApproval.connect({
  issuer: pairing.issuer,
  authenticatorOrigin: location.origin,
});
const key = await appApproval.createKey();
// Persist key in IndexedDB before claiming; do not export or JSON-serialize it.
const claimed = await client.claim(pairing, key, "My phone");
// Compare claimed.comparison and confirm in the initiating Cloud session.
const result = await client.pairingResult(pairing, key);
```

After confirmation, persist `{issuer: pairing.issuer, deviceId: result.deviceId,
key}` as a device binding, then discard the pairing secret. Call
`client.pending(device)`, `client.decide(device, request, "approve" | "deny")`,
`client.account(device)` or `client.revoke(device)`. Never call `decide` without explicit user approval
and comparison with the browser. Each client rejects bindings for another Cloud.

The namespace owns key generation, signing bytes, nonce/timestamp creation,
signature encoding, discovery validation and typed API calls. The PWA owns
issuer consent, device storage in IndexedDB, polling lifecycle and user actions;
it needs no cryptographic implementation. Store the returned non-extractable
`CryptoKey` through structured clone, not as JSON or an exported private JWK.
`connect` and each operation accept an `AbortSignal`. Calls have a 60-second
deadline and 8 KiB response limit, omit cookies, reject redirects and do not
retry automatically. `AppApprovalClientError` exposes a stable `code` and an
optional HTTP `status`, never a remote response body. Lost mutation responses
require state inspection before a new action.

### Encrypted local vault

Use `appApproval.vault` to encrypt stored device credentials.
`create()` returns an in-memory session; `session.pin(sixDigits)` or
`session.passkey(signal)` wraps its random 256-bit vault key. Persist a validated
`{version: 1, id: session.id, methods}` config only after an actual
`vault.unlock(config, method, pin?, signal?)` roundtrip succeeds. At least one
method is required; at most one PIN and one passkey are supported.

For an explicitly unprotected vault, use `session.local()` and persist it as
its only method. Reopen with `vault.unlock(config, "local")`. This stores the raw
vault key alongside the encrypted records and provides no protection against
someone reading browser storage. Never combine a local method with PIN or
passkey methods; validation rejects that configuration. To add a PIN later,
reopen the local session, create and verify its PIN method, and atomically
replace the config with only that method. Existing records keep the same key.

`vault.capability()` returns `supported`, `unsupported`, or `unknown`. It checks
browser capabilities without opening a credential dialog. Actual support still
requires a credential with PRF enabled and a successful PRF evaluation.
Passkeys request `userVerification: "required"` and use the exact local host as
RP ID. PRF output is derived through HKDF-SHA-256 with the app origin as salt
and `cloud-login-vault-wrap-v1` as purpose. PINs use `hash-wasm` Argon2id with
64 MiB, three passes, one lane, a random 16-byte salt, and a 32-byte result.
The fixed KDF identifier `argon2id-64m-t3-p1` rejects unknown work parameters.

Use `session.createKey()` for each new pairing. `session.sealRecord(record,
context)` encrypts a record containing that session-owned `key`;
`session.openRecord(blob, context, validate)` decrypts and validates it while
restoring a non-exportable runtime key. Bind `context` to the store, issuer and
pairing/device ID. Do not persist the returned runtime record. Existing keys
from `appApproval.createKey()` cannot be sealed because their private material
is non-exportable; retain the original API only for consumers that deliberately
own a different storage-protection policy.

Encryption uses AES-256-GCM, fresh random 12-byte IVs, and 128-bit tags. Envelope
AAD binds version, vault ID, method, salt and KDF/credential ID. Record AAD binds
version, vault ID and caller context. Public and private signing keys are checked
for correspondence on import. Only the explicit local method stores a raw vault key in browser storage.
PINs, PRF outputs and unencrypted private signing keys must not be stored.
Never send key material to logs or Cloud API requests.

For protected vaults, call `session.lock()` on lock and hidden/page-exit
lifecycle transitions. Always lock stale async results and disposed sessions. It invalidates session operations and SDK signing with keys from
that session. JavaScript memory cleanup is best effort, not guaranteed secure
zeroization. Consumers must also abort requests, close sensitive UI, drop all
runtime records, and prevent late unlock results from reactivating a session.
Use an atomic storage revision check for config changes and record writes.
Cloud Login implements this in IndexedDB and broadcasts invalidation to tabs.

Replacing a method rewraps the same vault key; the current config rejects the
old method. Previously copied envelopes still expose the same key if their
old method is recovered. This local mechanism is not server-verified WebAuthn
or fresh MFA for each approval. See [Protect the app](./cloud-login.md#protect-the-app)
for PIN limits, lifecycle and recovery.

Paths below are relative to `/api/auth/app-approval/v1`. JSON bodies are strict:
extra fields and private JWK material are rejected.

1. In the Cloud, call `POST /manage/pairings/start` with `{}` for yourself or
   `{userId}` for administrator-assisted pairing. The response is
   `{protocol, issuer, pairingId, secret, expiresAt}`. Only a current interactive
   session issued within the last ten minutes can start or confirm pairing;
   API/OAuth tokens cannot.
2. Transfer this pairing payload by QR, copy/paste or opening the link on the
   same device. All three use the same link format described below; no camera
   or extra API endpoint is required. Remove the fragment from browser history after reading;
   never send it to analytics or logs. Validate the issuer and obtain explicit
   consent before trusting a new Cloud. Never follow discovery across origins.
3. Generate a fresh, non-extractable ECDSA P-256 private key in the authenticator.
   Persist the CryptoKey in IndexedDB, scoped by issuer and device ID. Send
   `POST /pairings/claim` with `{pairingId, secret, publicKey, name, signature}`.
   `publicKey` contains exactly `{kty:"EC", crv:"P-256", x, y}`. Trim `name` before
   signing; it must contain 1–80 characters. The signature
   proves possession. The result is `{deviceId, comparison, expiresAt}`.
4. The original Cloud session checks `POST /manage/pairings/status` with
   `{pairingId}`, compares the six-digit code with the authenticator and
   explicitly confirms through `POST /manage/pairings/confirm` with
   `{pairingId, comparison}`. Only the same initiating user **and session family**
   can confirm. Assisted pairing rechecks admin authority and the pairing
   setting. The response is `{deviceId, approval}`. `approval` is `null` for the
   first device and administrator-assisted pairing. For a further device it is
   `{state:"pending", expiresAt}`: a paired active device of the same account
   and Cloud must approve before enrollment. Reconfirming while pending returns
   the same approval. A claim alone creates no usable device.
5. The authenticator polls `POST /pairings/result` with `{pairingId, secret, publicKey}`
   until `state` is `confirmed`. The response includes `deviceId` and, while
   claimed, `comparison` so a lost claim response can be recovered. Discard the
   pairing secret afterwards. Always send the public key generated locally for
   this pairing: a mismatch with the claimed key is forbidden. Never replace
   your local key/device binding with one obtained from an unrelated claim.
   Repeated claims otherwise return conflict.

Pairings expire after five minutes. `POST /manage/pairings/cancel` with
`{pairingId}` cancels an unconfirmed pairing. Confirmed devices require
revocation instead. Enrollment creates an audit entry and a durable user
notification, including whether an administrator assisted. Email is a required
delivery channel; failures remain visible in notification operations. Delivery
failure does not roll back enrollment.

### Approve device changes

`GET /info` lists `"device-changes"` in `features`. A supporting authenticator
asks for these requests with the signed command
`{operation:"inbox", accept:["device-changes"]}`. The response adds `changes`
and `moreChanges` to the existing `{logins, actions, moreActions, pollAfterSeconds}` inbox.
Without `accept`, the signing bytes and JSON keys keep their original form.
The SDK exposes `client.deviceChanges` and
`client.inbox(device, signal, {accept:["device-changes"]})`; it sends only
accepted features advertised by the Cloud. `client.pairingResult` lets the
server apply the extended deadline even after the original link expires;
claiming still requires an unexpired link.

`changes` contains at most five pending requests, oldest first. Each has
`{changeId, kind, device:{id,name}, endSessions, createdAt, expiresAt}`. `kind`
is `pair` or `revoke`. Names are single-line plain text, at most 80 Unicode
code points; after normalization they may be empty. Pairing always has
`endSessions:false`. A request is shown and can be decided only while the
browser session that started it remains active. The 8 KiB inbox budget keeps
every login. It trims Action summaries first and then the newest device
changes; a trimmed change stays pending and appears once the inbox has room.
`moreChanges` counts these omitted changes (0–5) and is present exactly when
`changes` is present. Do not treat an absent change as decided while
`moreChanges` is positive.

After the person reviews the request, call
`client.decideChange(device, change, "approve" | "deny", signal)` or send:

```json
{"operation":"change","changeId":"<UUID>","kind":"pair","targetId":"<device UUID>","endSessions":false,"decision":"approve"}
```

The signed command binds the request ID, kind, target device ID, session
choice and decision exactly as shown. It returns `{state:"approved"}` or
`{state:"denied"}`. Any active paired device of that account on this Cloud
whose latest inbox opted in to `device-changes` can decide; any other device
gets 409. The device being removed can approve its own removal; its `deny`
returns 409 and leaves the request pending for the other devices. A changed,
expired, cancelled or already decided request returns 409. Approval enrolls or revokes the device;
denial and expiry leave it unchanged. Enrollment uses the same audit and
required email notification path as the first pairing.

The initiating browser polls `POST /manage/pairings/status` with
`{pairingId}`. Its response adds `approval`, either `null` or
`{state,expiresAt}`. States are `pending`, `approved`, `denied`, `cancelled`
and `expired`. While approval is pending, the pairing remains `claimed` for
both the browser and `/pairings/result`. Approval makes it `confirmed`;
denial makes it `cancelled`. The browser can read a pairing's approval status for one minute after expiry,
including `expired` for an undecided request. The new device can also read a
confirmed or cancelled result during that minute. Nothing can be approved
after expiry.
Cancelling the pairing also cancels its pending device change.

For a removal, the browser polls `POST /manage/device-changes/status` with
`{changeId}` and receives `{changeId,state,expiresAt}`. A decided or expired
request stays readable for one minute after expiry. A reload resumes the saved
reference during that minute and reads Cloud's result. After that the route
answers 404, and the result is unknown to the browser, so Cloud's own dialog
says so and offers to check again. After a lost answer it
sends `{deviceId}` instead and gets this session's newest removal of that
device, or 404. That 404 does not prove that no request exists: a send that
Cloud still holds can commit later. Cloud's own dialog keeps the saved device
reference until it expires and looks again on the next reload. Sending the same removal again from the same session returns
the pending request instead of a second one; a changed `endSessions` choice
replaces it. It can cancel a pending request
through `POST /manage/device-changes/cancel` with the same body (204).
Both routes require the requesting account and session family; another session
of the same account receives 404. They do not require a recent sign-in. Once a
pairing has a device-change request, its initiating browser can also follow or
cancel it without another recent-sign-in check. Starting and confirming a
pairing still require recent authentication.

Older authenticator apps do not opt in and cannot show these requests, so a
browser's pending request expires unless a supporting paired app decides it.
People without a usable paired device need the administrator path: revoke the
old device through Accounts or `cld accounts users devices revoke`, then use
administrator-assisted pairing when enabled. Operators can configure that
path through the existing `cld admin app-sign-in config` commands described in
[Set up app sign-in](/en/docs/accounts/app-sign-in#configure-from-the-cli).
Administrator-assisted pairing and administrator revocation remain immediate.

Device changes record `auth.app.device_change.request`,
`auth.app.device_change.approve` or `auth.app.device_change.deny`. Each entry
targets the device and includes `changeId`, `kind` and the session choice as
`endSignIns`; approval also records the number of ended sessions. Enrollment and revocation retain
their `auth.app.device.enroll` and `auth.app.device.revoke` entries.

### Copy a pairing link without a camera

Use `appPairingLink(authenticatorOrigin, payload)` from the contracts export to
create `https://auth.example/#pairing=<percent-encoded JSON payload>`. The
authenticator origin comes from the operator setting, not from user input.
The QR encodes this exact link; copying it or opening it on the same phone
transfers the same five-minute, one-use enrollment secret.

The authenticator accepts the whole link as pasted text and calls
`parseAppPairingLink(text, location.origin)`. This validates the payload and
destination without making network requests. It does not authenticate the
Cloud or check whether enrollment is still available: explicit issuer consent,
discovery validation, server expiry checks and the normal confirmation remain
required. The six-digit comparison code is **not** a pairing credential.

Keep the secret in the fragment, never the query or path. Clear the fragment
with `history.replaceState` before requests and avoid logging parsing errors
with their input. Copy only on explicit user action; do not read the clipboard
automatically or persist pairing links. A clipboard manager may retain a copy.

## Approve a browser sign-in

When app approval is enabled and configured, **Login** defaults to app sign-in
by email or username. **FreeIPA** defaults to the password and **Guest** to
email, each with **Use the app instead** as an alternative. Users without a
paired device can use the email or password method and enroll one under
Security. Cloud does not expose a public account/device lookup to choose a
method: the default follows the selected category, an explicit
`credential=app` or `credential=legacy` link, and for FreeIPA the
`login_freeipa_app` cookie. A completed FreeIPA app sign-in sets that cookie in
the browser and a FreeIPA password sign-in removes it; it names no account.
The category switch remains unchanged. Local accounts retain **Use an email
link instead**. When FreeIPA opens with the app, the password alternative
stays available. Passkeys and email-link verification still work. An unpaired
or unknown account does not get a distinct error: use another existing sign-in
method if no paired app receives the request.

The waiting Cloud page displays the comparison code. Open the paired app and
approve only a request you started whose code matches. The page continues as
soon as you approve: it keeps one status request open, and Cloud answers it
the moment the app decides. The page starts at most one status request every
five seconds, pauses while it is in the background and checks again on return,
backs off on connection errors, and stops at a terminal state. Requests have a
30-second UI network timeout. The browser completes an approved login once,
keeps showing that you are signed in, and visits `/auth/continue` with its
validated local `redirectTo`. Core requests explicit first-use legal
acceptance if needed, then follows the return URL. A newly issued session
without acceptance cannot authorize application or API access. The PWA does
not collect this acceptance. A lost completion response requires checking the session by reloading or
starting a new request, never retrying the old completion.

The initiating tab stores its pending browser secret in session storage,
scoped to the category and return URL, to survive reloads. It is never placed
in a URL or transferred to the authenticator. Terminal states and **Cancel**
discard it; the server request expires after five minutes. Stopping
does not remove the request from the app immediately.

The Cloud browser calls `POST /login/start` with `{identifier, category}`.
Category is `guest`, `login` or `freeipa`; identifier is an exact username or
email, matched case-insensitively. Ambiguous identifiers are not resolved.

The HTTP 202 response is
`{requestId, browserSecret, comparison, expiresAt, pollAfterSeconds}`.
Unknown, disabled, ambiguous and over-capacity accounts receive the same pending
response shape. This is not a constant-time lookup guarantee. Keep
`browserSecret` only in the initiating Cloud browser, never in the authenticator
or a URL.

The authenticator sends signed commands to `POST /device`:

| Command | Result |
| --- | --- |
| `{operation:"pending", accept?: ["login-context"]}` | `{requests, pollAfterSeconds}` for this device's account and Cloud only. Each request contains `requestId`, `challenge`, `comparison`, `createdAt`, `expiresAt`. Signed opt-in adds `context` as described below. |
| `{operation:"decide", requestId, challenge, comparison, decision:"approve"}` | `{state:"approved"}`. With `decision:"deny"`, returns `{state:"denied"}`. |
| `{operation:"revoke"}` | `{state:"revoked"}` for the signing device only. |
| `{operation:"push", token}` | `{state:"updated"}`. Stores the authenticator's opaque push token (43 URL-safe characters) for this device; a new token replaces the old one. Clouds without this command answer 400. |
| `{operation:"account"}` | `{account:{uid, displayName, mail}, device:{name, createdAt}}` for the signing device only. `uid` is the username, `displayName` may be empty, and `mail` is `null` when no email is set. Clouds without this command answer 400. |

Fetching pending requests must **never** approve them automatically. Require
explicit confirmation and comparison with the initiating browser's code. The
authenticator receives no browser secret, session cookie, user API token,
FreeIPA password or Kerberos ticket.

`account` lets the authenticator show which account a pairing signs in. It
returns only the username, display name and email of the device's own
account, plus the device name and enrollment time. A device of another account,
another Cloud, or a revoked device gets 403. Like every command, it updates
the device's last use. Because the answer names the account, anyone who can
sign with a device key, including compromised JavaScript on the authenticator
origin, can start a sign-in for that account and approve it without knowing the
username beforehand. Treat a device key as a complete sign-in credential.

The Cloud browser calls `POST /login/status` with `{requestId, browserSecret}`.
States are `pending`, `approved`, `denied`, `consumed`, or `expired`; after cleanup
an expired request may instead be unavailable. While the request is pending,
Cloud holds the response for up to `pollAfterSeconds`, or until the request
expires, and answers as soon as the app approves or denies it on any Core
replica. The wake-up travels over Sync; the answer is always read from
Postgres. Start the next status request no sooner than `pollAfterSeconds`
after the previous one started. Once approved, call
`POST /login/complete` with that body. Success is HTTP 204 with the normal
HttpOnly Cloud session cookie, never a token in JSON. Completion is atomic and
one-use. A lost response or failed session issuance requires a new login.

## Read browser sign-in context

Cloud announces `"login-context"` in `/info.features`. The SDK exposes this as
`client.loginContext`. An app opts in only when it can show the context:

```ts
const pending = await client.pending(device, signal, { accept: ["login-context"] });
const inbox = await client.inbox(device, signal, {
  accept: ["terminal-logins", "login-context"],
});
```

Both commands sign `accept`. The SDK filters the list against `/info.features`
and omits the key when nothing matches. `APP_APPROVAL_PENDING_ACCEPT` contains
only `login-context`; `terminal-logins` is inbox-only, so `pending` drops it
from the list instead of failing. `APP_APPROVAL_ACCEPT`
contains both. Without `login-context`, neither response includes a `context`
key. Updating the SDK alone does not opt in.

With opt-in, each browser sign-in carries this strict `AppLoginContext`:

| Field | Meaning |
| --- | --- |
| `level` | `info`, `hint`, or `warn`, computed by Core. The app displays it and never derives its own. |
| `browser` | `firefox`, `chrome`, `safari`, `edge`, `samsung`, `opera`, or `other`. |
| `os` | `windows`, `macos`, `mac-or-ipad`, `ios`, `android`, `linux`, `chromeos`, or `other`. `mac-or-ipad` means the browser cannot distinguish the two. |
| `country` | Uppercase ISO 3166-1 alpha-2 code, or `null` when unknown. |
| `city`, `network` | Plain text, each at most 96 UTF-8 bytes, or `null`. `network` names the network operator; it never labels a VPN or data center. |
| `history` | `null` during the installation's 14-day introduction phase. Cloud makes no known/new claim then. Otherwise the object below. |
| `history.knownSince` | This browser's first successful sign-in for this account inside its current remembered period, or `null` if unknown. |
| `history.newCountry` | Core has a country for the request, `geoip_since` is set, and this account has no successful sign-in from that country inside the 90-day window. |
| `history.countriesSince` | `geoip_since` when less than 90 days ago, otherwise `null`. A shorter history can be shown as “since {date}”. |
| `sameNetwork` | Optional literal `true`. The browser request and phone share the full IPv4 address or IPv6 /64. Absence makes no claim. |

Dates use UTC ISO date-times. Browser recognition uses the browser cookie
(S1); countries use successful sign-ins inside the last 90 days (S6).
Core applies this level table:

| Browser and country history | Level |
| --- | --- |
| Introduction phase | `info`, with `history: null` |
| Known browser; country seen or no country/GeoIP | `info` |
| Known browser; new country | `hint` |
| New browser; country seen or no country/GeoIP | `hint` |
| New browser; new country; account has no countries in the window | `hint` |
| New browser; new country; account already has countries in the window | `warn` |

Browser/OS descriptions (S2), network operator (S4), and the same-network hint
(S5) never change the level. The shorter `countriesSince` window does not
change it either. See [Sign-in locations](./sign-in-locations.md) for accuracy,
address pseudonyms, storage, and retention.

Terminal sign-ins never carry context. Push never carries it. The waiting
browser's `/login/start`, `/login/status`, and `/login/complete` responses stay
unchanged, and `/login/start` sets no cookie. Context is a snapshot of the
start request; it is not recomputed while the phone polls.

An opted-in browser request can lack context if it started before the upgrade
or the response budget forced it out. Cloud first drops Actions from the end
of the inbox and adds them to `moreActions`. If needed, it then drops context
from the last login backwards. It never drops a login. `pending` uses the same
context trim order. Both responses stay within 8 KiB. Keep `context` optional
when you parse a response, and treat a missing context as no claim about the
browser.

| App and Cloud combination | Browser context behavior |
| --- | --- |
| Old app, old Cloud | Original signed commands and response bytes. |
| Old app, new Cloud | No opt-in; original response bytes, with no `context` key. |
| New app, old Cloud | SDK omits unsupported `accept`; original command body and signing bytes. |
| New app, new Cloud | Signed `login-context` opt-in returns browser context. |

## Approve a terminal sign-in

A terminal sign-in links an OAuth device authorization (RFC 8628) to the
paired app. The app approves authentication and consent in one step.
Only the OAuth app can create it, through Core's broker-authenticated internal
endpoint. Browser sign-in endpoints cannot create or complete it.
OAuth sends these requests when a first-party client supplies
[`login_hint`](/en/docs/identity/oauth#approve-in-cloud-login). Today that
client is the Cloud CLI: `cld login --user <username or email>` creates them.

Check for `"terminal-logins"` in `/info.features`. Opt in only when your app can
show the client, every scope code, and the login lifetime before a decision:

```ts
const inbox = await client.inbox(device, signal, { accept: ["terminal-logins"] });
```

The SDK filters `accept` against the Cloud's announced features. It omits the
key when none match. Updating the SDK alone does not opt in. Each signed
`inbox` stores the device's latest capability list; omitting `accept` clears
it. `pending` always returns browser sign-ins only.
Only a device whose latest inbox opted in to `terminal-logins` can decide a
terminal request.

Each terminal login has the usual request ID, challenge, comparison code,
creation time and expiry, plus:

```json
{"terminal":{"client":{"id":"cloud-cli","name":"Cloud CLI"},"scopes":["openid","profile"],"lifetimeSeconds":3600}}
```

The client name comes from the registry. It is plain text, shortened to
60 code points. Render it as text. The scope list contains 1–16 codes.
Show the lifetime as a duration. Compare the six-digit code with the terminal
and require an explicit choice. Never approve on arrival.
The shown lifetime is already capped by `user.session.expiry_hours` and the
90-day maximum; issued tokens never outlive it.

Use the existing signed `decide` command. **Approve** authenticates the account
and consents to exactly the shown client, scopes and login lifetime.
**Approve** rechecks the client's access and scopes. **Deny** reaches the linked
OAuth grant while the request is pending, even if the client's access or scopes
changed, and denies both requests. Both state changes and their audits commit
together. The device authorization and client IDs come from the stored request.
The `admin` scope is never offered through this channel; use browser consent.
A decided, expired or stale authorization returns `409`, as does an approval
that is no longer allowed.
Reload the inbox after a conflict. Do not retry an uncertain decision.

Browser and terminal sign-ins share five outstanding requests per account.
Each request expires after 300 seconds. Unknown, ambiguous, unpaired, expired,
category-disabled, client-disallowed and over-budget accounts receive the same
response shape and no wake-up. So do accounts that have not yet accepted the
legal documents.

Before token issuance, Core checks that the approving device still exists,
is active and belongs to the account, and that the account's authentication
epoch still matches. As with browser completion, app approval must still be
enabled, and the request and device must belong to the current issuer.
Revocation, signing out everywhere, disabling app approval or changing the
issuer between approval and issuance prevents tokens. Approve and Deny both
record the request's authentication epoch on the linked OAuth grant. After the
account is signed out everywhere, an earlier approval cannot be redeemed, and
the terminal receives `invalid_grant`; a denial still reaches it as
`access_denied`. Approved terminal evidence
stays until issuance consumes it or the linked OAuth authorization row is deleted,
even when that row has expired. Existing browser approvals of OAuth device grants
keep their current behavior.

### Upgrade the three components

Update **Core, then OAuth, then Cloud Login**. Use versions with these
capabilities; a package or image version alone does not opt a device in.
This Core bridge must be present before enabling OAuth's app-approval handoff.
The handoff and Cloud Login's consent UI are separate changes.

| App and Cloud combination | Behavior |
| --- | --- |
| Old app, new Cloud | No opt-in. Browser sign-ins and existing commands keep their current response shape. |
| New app, old Cloud | The SDK omits `accept`. Terminal sign-ins are unavailable. |
| New app, new Cloud | Explicit opt-in enables terminal consent when OAuth supports the handoff. |

| Component version capability | Required behavior |
| --- | --- |
| Core with `terminal-logins` | Internal broker endpoint, signed inbox extension, atomic decisions and issuance recheck. |
| OAuth with app-approval handoff | Creates the linked request for `login_hint`; clients can start without the hint to use browser approval. |
| Cloud Login with terminal consent | Shows client, scope codes and lifetime, then opts in explicitly. |

## Approve an Action

Check `/info` for `"actions"` in `features` before using these commands.
The feature extends `cloud-app-approval-v1`; it does not change `limits`.
Older Clouds omit the feature and answer the new commands with `400`.
Existing authenticators can keep using `pending` and `decide` for sign-ins.

Send the following signed commands to `POST /device`:

| Command | Result |
| --- | --- |
| `{operation:"inbox", accept?: string[]}` | `{logins, actions, moreActions, pollAfterSeconds}`. Without `accept`, `logins` has the same fields as the `pending` list. Opt-in adds terminal consent or browser context fields as requested. `device-changes` adds `changes` and `moreChanges`; see [Approve device changes](#approve-device-changes). `actions` contains up to five newest open Action summaries of the device's account. `moreActions` counts other open requests. |
| `{operation:"action", actionId}` | The full device view of one open request. |
| `{operation:"act", actionId, digest, decision:"approve"}` | `{state:"approved"}`. With `decision:"deny"`, returns `{state:"denied"}`. |

`accept` lists any of `terminal-logins`, `login-context` and `device-changes`.
`inbox` without `accept` has no signature appendix. With `accept`, append
the capability list as one nested array. For `action`, append `[actionId]` to the
device proof array. For `act`, append `[actionId, digest, decision]`.
Use a fresh `jti` for every command.

The view contains `actionId`, `app: {id, name}`,
`requester: {app: {id, name}, title}`, `assurance`, `sentence`, `message`,
`details`, `truncated`, `argsDigest`, `createdAt`, `expiresAt`, and `digest`.
App names come from Cloud's registry in the language Cloud used when it asked.
The chat title is `null` when empty.
`message` is plain text or `null`. Each detail has `{label, value}` and may
carry `format: "date" | "date-time"`. Those values retain their raw date
encoding; show them in the phone's locale and time zone. Markdown details
arrive as plain text with no markdown format. Dates are ISO dates or RFC 3339;
creation and expiry times are UTC ISO timestamps.

A summary contains the view's `actionId`, `app`, `requester`, `assurance`,
shortened `sentence`, `createdAt`, and `expiresAt`.
The inbox may return fewer summaries to keep the whole response, including
logins, within 8 KiB. Omitted requests count in `moreActions`.
Read the full view before offering a decision. Cloud Login can approve or
reject both `standard` and `confirm`. It decides only this request and never
remembers an approval.

`APP_ACTION_LIMITS` bounds the device text by Unicode code points:

| Field | Limit |
| --- | --- |
| Inbox Actions (`inboxActions`) | 5 |
| App IDs and names (`nameChars`) | 60 |
| Chat title (`titleChars`) | 80 |
| Summary sentence (`summaryChars`) | 120 |
| Full sentence (`sentenceChars`) | 280 |
| Message (`messageChars`) | 500 |
| Details (`details`) | 8 |
| Detail label (`labelChars`) | 40 |
| Detail value (`valueChars`) | 300 |

Cloud derives the device text from the same Action question card as the chat
and approvals page. `sentence` is the plain question (up to 280 characters),
`message` is its reason line (up to 500), and `details` contains up to eight
preview rows. People include their addresses, such as
`Lea Berg <lea.berg@example.com>`.

The row labels follow the question's language. The main labels are:

| Preview | German / English labels |
| --- | --- |
| Message | Von / From, An / To, Cc, Bcc, Betreff / Subject, Senden am / Send at, Warnung / Warning, Anhänge / Attachments, Text |
| Event | Titel / Title, Wann / When, Bis / Until, Wo / Where, Mit / With, Wiederholung / Repeats, Text |
| Task | Titel / Title, Ort / Place, Fällig / Due, Zuständig / Assignees, Status, Checkliste / Checklist, Tags, Text |
| File | Name, Ordner / Folder, Größe / Size, Ziel / To |
| Page | Titel / Title, Ort / Place, Text, Neu / Added, Entfernt / Removed |
| Rule | Startet / Starts, Text, Darf / May, Hinweis / Note when the rule cannot see the chat |
| Fields | The app's labels; previous values add `(vorher)` / `(before)` |

Rows appear only when the preview supplies their value. A title or file name
that the question already says gets no row of its own. Consequences follow the preview as Folge / Also,
Neu / Added, or Entfernt / Removed. Rule permission changes use
Darf (neu) / May (added) and Darf (entfernt) / May (removed).
Legacy reviews keep their literal question and detail rows; Markdown becomes
one Text row. Without a review, Cloud asks the first sentence line as a
question, removes its leading registry app name, and uses later
`Label: value` lines as rows. Its reason is `app_asks`. A legacy row without
a label gets the label Hinweis / Note, because every device detail needs one.

Cloud replaces control characters and line or paragraph separators with a
space, removes format characters (including bidi overrides), collapses
whitespace, and trims every text. Block rows become one line.
Cuts end in `…` within the field limit and set `truncated: true`. Omitted
rows, an incomplete preview, additional recipients or attachments also set it.
If the full JSON still exceeds 8 KiB in UTF-8, Cloud drops details from the
end, then shortens the message.

A question whose review names no reason takes it from the Action's declared
policy, as the approvals page does. Dates and times stay typed rows, an event's
end too, so the device shows them in its own time zone. A truncated question
is browser-only when its reason or the Action's declared policy is `sends`,
even when the call names another reason. An incomplete question also stays in
the browser when Cloud cannot read the declared policy, including when the
app is not registered. A browser-only question is absent from
the device inbox and detail endpoint and triggers no device push. It still
counts in `moreActions`. The person decides in Cloud using the shared review
and its link to the complete reviewed revision. Opening Cloud does not restore
content omitted from that review; the application must supply the complete
proposed content as described in [Action approvals](/en/docs/identity/approvals#where-to-decide).
To fill the inbox past such questions, one inbox call reads at
most the newest 100 open requests. Other truncated questions remain available on the device; show
that their complete content is available in Cloud.

The device protocol and `cloud-action-v1` digest do not change. Existing
authenticators need no release for this mapping.

The digest is unpadded base64url of SHA-256 over UTF-8 of this exact JSON
array, without extra whitespace:

```text
["cloud-action-v1",issuer,actionId,app.id,app.name,requester.app.id,requester.app.name,requester.title,assurance,sentence,message,details.map(d => [d.label,d.value,d.format ?? null]),truncated,createdAt,expiresAt,argsDigest]
```

Use `appActionDigestMessage` and `appActionDigest` from
`@k2b/cloud/contracts`. Recompute the digest before showing an
approval choice. Refuse to offer approval if it differs from `digest`.
The browser SDK's `action()` checks it before returning the view; `act()`
checks it again before signing. `argsDigest` binds the stored input, which
the authenticator cannot inspect, to the decision.

Never decide automatically. Build your own frame from registry app names
and the Cloud host. Render the app's sentence, message, and details only as
plain text below that frame. Show the chat title as content, never as your
own frame. Do not interpret app text as HTML, links, instructions, or a
reason to approve. Require the person's explicit choice for every decision.

A `409` means the request was decided elsewhere, expired, or its view changed.
Remove the old choice and reload the inbox. Do not retry the old decision
against a new view.

### Wake the paired phone

A device with a push token gets at most one sign-in wake-up in 30 seconds
while its previously woken request is pending and unexpired. A new sign-in
can wake it sooner after that request is decided or expires. Browser and
terminal requests share this rule. Terminal requests wake only devices whose
latest inbox opted in to `terminal-logins`, and device-change requests only
devices whose latest inbox opted in to `device-changes`. A withdrawn or
replaced device-change request still holds the 30-second window; only a
decision or its expiry frees it early. Cloud Login allows 30 sign-in
wake-ups per token per five minutes.

After the login request commits, Core claims eligible devices atomically and
calls the configured authenticator origin once per distinct token:

```http
POST <authenticator origin>/push/notify
Content-Type: application/json

{"token":"…","cloudOrigin":"https://cloud.example.org","requestRef":"<requestId>"}
```

The body carries only the Cloud's issuer and the login request ID. It never
carries the comparison code, challenge, browser secret, account name or email.
The call runs in the background with a five-second timeout: it never delays
`/login/start`, and unknown, disabled or throttled accounts, which receive a
decoy request, never trigger one. Core does not retry; Cloud Login queues and
retries delivery itself. An answer of 410 means the phone's subscription is
gone, so Core clears that token from the account's devices. Revoked devices
are never woken.

For an Action approval asked outside Cloud's pages, Core sends the same body
with `kind: "action"` and the approval ID as `requestRef`. It wakes only active
devices that called `inbox` and registered a push token. Each device gets at
most one Action wake-up in 30 seconds while the previously woken request is still
open. Cloud Login counts Action wake-ups separately from sign-ins.
Requests from signed-in browser turns do not trigger an Action wake-up.
A `400` from an older Cloud Login server leaves the token unchanged.
Sign-in wake-ups keep their original body without `kind`. Cloud Login uses
separate Web Push topics for Actions and sign-ins, so one does not replace the
other while delivery waits.

Push is only a hint. For Actions, load the signed `inbox` and `action` before
offering a decision. The authenticator still loads sign-in requests with a signed
`pending` command, or an opted-in `inbox` for terminal sign-ins, and needs
the usual comparison and approval. Each Cloud
needs outbound HTTPS to the authenticator origin. See
[Send push notifications](./cloud-login.md#send-push-notifications) for the
authenticator side.

## Sign the versioned payload

Use UTF-8 encoding of these JSON arrays, without extra whitespace. Sign with
WebCrypto ECDSA P-256 and SHA-256. Signatures use 64-byte IEEE-P1363 `r || s`,
encoded as unpadded base64url, **not** DER or JWS. JWK coordinates and secrets
are canonical unpadded base64url of 32 bytes.

Pairing proof:

```text
["cloud-app-approval-v1","pair",issuer,pairingId,secret,"EC","P-256",x,y,name]
```

Device request body is `{proof, signature}`. `proof` contains exactly
`{issuer, deviceId, jti, issuedAt, expiresAt, command}`. `jti` is a fresh UUID for
every call, including polls. Times are Unix seconds. Sign:

```text
["cloud-app-approval-v1","device",issuer,deviceId,jti,issuedAt,expiresAt,operation]
```

For `change`, append `changeId,kind,targetId,endSessions,decision` in that order:
`[...,"change",changeId,kind,targetId,endSessions,decision]`.

For `decide`, append `requestId, challenge, comparison, decision` to the array.
For `push`, append `token`.
For `action`, append `actionId`; for `act`, append `actionId, digest, decision`.
For `pending` or `inbox` with `accept`, append the whole list as **one nested array**:

```text
["cloud-app-approval-v1","device",issuer,deviceId,jti,issuedAt,expiresAt,"inbox",["terminal-logins"]]
```

For example, the context-only pending proof ends with
`"pending",["login-context"]]`.
Without `accept`, the signing bytes stay unchanged and there is no appendix.
`accept` must be non-empty and unique, with at most eight entries from
`APP_APPROVAL_ACCEPT` (`terminal-logins`, `login-context` and `device-changes`) for `inbox`.
For `pending`, use only `APP_APPROVAL_PENDING_ACCEPT` (`login-context`).
Unknown entries are rejected.
All operation parameters are covered. Public `@k2b/cloud/contracts`
exports include `appDeviceProofMessage`, `appPairingProofMessage`, request/response schemas
and `APP_APPROVAL_PROTOCOL`, `APP_APPROVAL_PATH`, `APP_APPROVAL_LIMITS`,
`APP_APPROVAL_FEATURES`, `APP_APPROVAL_ACCEPT`, `APP_APPROVAL_PENDING_ACCEPT`,
`AppLoginContextSchema`, `AppLoginContext`, `AppTerminalLogin`, `APP_ACTION_LIMITS`, and the Action schemas and
digest helpers. These helpers hold no credentials and make no network calls.

The compile-checked signing example is
`docs-site/examples/cloud-docs/app-approval.ts` in the Cloud checkout.

A proof expires within 60 seconds of issuance, has a positive lifetime, and
allows at most five seconds of future clock skew. Successful commands consume
`(deviceId, jti)` atomically. After losing a mutation response, inspect state
instead of blindly retrying with a new nonce.

## Transport, errors and limits

`GET /info` returns `{protocol, issuer, api, appOrigin, algorithm, limits, features}`.
`features` is optional on older Clouds. `limits` remains exactly the original
version 1 object; Action limits live in `APP_ACTION_LIMITS`.
Require the expected protocol, exact issuer and `ES256`. Discover only from an
explicitly trusted pairing issuer. PWA requests use `credentials:"omit"`.

Only `/info`, `/pairings/claim`, `/pairings/result` and `/device` allow CORS from
the configured authenticator origin. Preflight allows GET/POST and Content-Type,
not credentialed requests. Management and browser-login writes require the
exact Cloud Origin header. CORS is not authentication; non-browser callers
still need the appropriate proof or session.

Version 1 budgets are five-minute pairing/login lifetimes, five outstanding
pairings and five outstanding logins per account/Cloud, twenty active devices,
twenty device records per page and 8 KiB request and response bodies.
Action inboxes contain at most five summaries; full views contain at most eight
details. See [Approve an Action](#approve-an-action) for their text limits.
These bound storage, cryptographic work and response sizes. Poll at most once every five seconds
while foregrounded, stop on terminal states, and back off on errors. Background
PWA execution is not guaranteed, and push wake-ups are best effort.

The existing Cloud IP rate limit applies. Behind a reverse proxy, the gateway
must trust that proxy; see [Pass client addresses through the reverse proxy](/en/docs/operations/deployment-requirements#pass-client-addresses-through-the-reverse-proxy). IP throttling returns HTTP 429 with Retry-After.
Other errors: 400 (invalid input), 401 (missing management session),
403 (forbidden or recent authentication required), 404 (unavailable object),
409 (used/stale/conflicting operation), 413 (body too large), and 503 (disabled,
invalid configuration or unavailable dependencies). Never log rejected bodies.

Expired transient rows are
removed in bounded batches on requests and by a minute-based schedule. The same
schedule retries enrollment notices after restarts; delivery deduplicates by
device ID. Device records remain until account deletion; revocation preserves
their history.

## Revoke and recover

**My account → Security → Paired devices** lists names, enrollment dates,
last use and administrator-assisted provenance. Rename or explicitly revoke
an active device here. Revoked devices remain visible, including their
revocation time. Use **Load more** to page through older device records.
Disabling app sign-in hides enrollment but leaves this management available.

Revoking a device also voids Action approvals it gave that have not been used
yet. Signing out everywhere ends open requests and unused approvals. Cloud
checks both when an approval is used, before the Action runs.

`GET /manage/devices?after=<UUID>` lists only the current user's devices,
including revoked ones, as `{items,nextCursor}`. Items contain
`id,name,createdAt,lastUsedAt,revokedAt,assisted`.
`POST /manage/devices/update` accepts either
`{operation:"rename",deviceId,name}` (204) or
`{operation:"revoke",deviceId,endSessions}` (200). `endSessions` defaults to
`true`. Removal returns `{state:"pending",changeId,expiresAt}` until a paired
device approves it; the target stays active while waiting. An already revoked
device returns `{state:"revoked"}` without another request. With `endSessions`,
approval also ends the browser sign-ins approved by that device, except the
requesting session. Other devices' sign-ins and sessions with no device link
stay signed in. Both mutations require recent authentication and ownership.
Listing and renaming remain available when app approval is disabled or its
setup is incomplete. Removal then answers `503` with `UNAVAILABLE`, because no
paired device can approve it; an administrator revokes the device instead.

### Revoke a device for someone else

A person who lost their only paired device cannot sign in to revoke it.
Administrators open **Accounts → Users → the user**. **Sign-in devices** lists
the account's active devices with their name, pairing date and last use.
**Revoke device** asks for confirmation, then stops that device from approving
sign-ins. Administrators can do the same through the Accounts API and the
CLI:

| Surface | List | Revoke |
| --- | --- | --- |
| HTTP | `GET /api/accounts/users/{id}/devices` returns `{devices}` with the item fields above | `DELETE /api/accounts/users/{id}/devices/{deviceId}` |
| CLI | `cld accounts users devices list <user>` | `cld accounts users devices revoke <user> <device-id> --yes` |

Only administrators can list or revoke another account's devices; everyone
else gets 403. The list contains active devices only. No recent sign-in is
required, and revocation works while app sign-in is disabled or the account
has expired. Repeating a revocation succeeds without changing anything. The
first revocation writes an `auth.app.device.revoke` audit entry naming the
administrator as actor, the device as target and the account as
`targetUserId`. It also notifies the person, by default by email and browser
notification; the person can change these channels. Delivery is best effort:
the revocation stands when no channel reaches them.

Revoking a device does not end the sessions it already approved. They stay
valid until they expire after **Session Expiry Hours** (8 by default) or until
the account is signed out everywhere, for example when the person resets
their FreeIPA password with **Reset password** on the sign-in page. Accounts
has no separate action that ends another account's sessions.

The list and revocation cover devices paired at the Cloud's current address
(`app.url`), which are the only ones that can approve sign-ins. Devices paired
under an earlier address work again if `app.url` changes back, so review the
list after such a change.

To replace a lost device, revoke it and then pair a new one with
[administrator-assisted pairing](#pair-a-device).

### What revocation ends

Revocation before completion prevents even an approved request from being used.
Login completion records the approving device on the new browser session
family and checks that the device is still active at issuance. Browser removal
can end those linked sessions on approval, except the requesting session.
Families issued before this update have no device link and stay signed in.
Administrator revocation and a device's own signed `revoke` command leave
existing sessions signed in until expiry or sign-out everywhere.
Signing the account out everywhere or removing the approving device also ends
an approval that completion consumed but has not yet turned into a session:
completion answers HTTP 409 with code `CONFLICT`, and the browser starts a new
login. Signing out everywhere also ends existing sessions and OAuth sign-ins,
including user access tokens at their next request.

When Cloud signs an account out everywhere, it also revokes every paired
device of that account, including devices paired while the Cloud used another
address. Each device gets an `auth.app.device.revoke` audit entry without an
actor, with the account as `targetUserId` and `reason: "sign_out_everywhere"`.
This happens after a FreeIPA password reset from the sign-in page,
when an administrator changes the account's provider (including creating a
FreeIPA account for an existing local account) or demotes it to a guest, and
when FreeIPA synchronization or the account lifecycle job demotes or deletes a
FreeIPA account, for example an expired one. A temporary password that an
administrator sets with **Reset password** in Accounts or
`cld accounts users reset-password` does not sign the account out.

Outstanding login requests from before that point stay unusable, and so do
pairings started before it, including administrator-assisted ones. The person
pairs again after signing in, or an administrator starts a new assisted
pairing.

Account expiry and current category policy are checked on device operations and
completion. Expiry alone does not revoke devices: they cannot approve sign-ins
while the account is expired and work again when an administrator extends it.
FreeIPA users use the synchronized **Cloud account**: there is no
live FreeIPA password, OTP or Kerberos check. Enabling this method permits an
independent Cloud credential for these accounts. Upstream disablement not yet
synchronized into Cloud cannot be observed here. Keep synchronization healthy
or disable app approval when immediate upstream revocation is required.

Recovery uses an existing supported login method followed by recent-session
device revocation, or an administrator who revokes the device. This API
introduces no email override for FreeIPA, grants no Linux access, and removes
no passkeys.

## Verify the integration

Test two issuers and two accounts, wrong origins, key persistence after reload,
explicit confirmation, replay, expired proofs, concurrent completion, lost
responses, revocation and disabled accounts. The maintained service/HTTP fixture
is `packages/cloud/src/services/app-approval.integration.test.ts`; it refuses
to run against the development database or cache.

Review authenticator dependencies and service-worker updates as credential
handling code. Do not add analytics, remote scripts, exported private-key
backups or a shared cross-Cloud key as incidental integration work.
