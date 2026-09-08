---
title: Integrate an authenticator website
navTitle: App approval API
section: Operations
order: 1176
description: Pair per-account device keys and approve browser-bound Cloud sign-ins from a separate, multi-cloud authenticator.
tags: [authentication, accounts, security, api]
updated: 2026-09-08
---

# Integrate an authenticator website

Core provides `cloud-app-approval-v1` for a separately hosted authenticator.
One website can connect directly to multiple Clouds, with a separate key pair
for every Cloud/account pairing. There is no central credential server or
Cloud-cookie sharing.

This is the technical foundation, not a shipped PWA or login-screen flow.
Existing email, FreeIPA and passkey sign-ins remain unchanged. The management
API is ready for the later `/me` integration; it does not add a device panel.

## Choose the trusted website

Configure these Core settings through **Administration → Settings → Accounts &
sign-in**, or the existing administrator settings API:

| Setting | Default | Meaning |
| --- | --- | --- |
| `user.app_approval.enabled` | `false` | Enable pairing and app-login endpoints. |
| `user.app_approval.origin` | empty | Exact authenticator HTTPS origin, without path, query, credentials or fragment. No wildcard. |
| `user.app_approval.admin_pairing` | `false` | Permit a recently authenticated administrator to pair another account's device. |

Additional settings appear after enabling the feature. An invalid origin fails
closed. HTTP loopback origins work only outside production. The issuer is the
canonical origin of `app.url`, never the incoming Host header. Moving the Cloud
to another origin requires pairing again.

The authenticator origin is a credential trust boundary: compromised JavaScript
or a malicious service-worker update can use stored keys for all paired Clouds.
Non-extractable WebCrypto keys prevent ordinary export, not malicious same-origin
signing. This method is not automatically hardware-backed, phishing-resistant,
or a second factor. Changing the allowed origin does **not** revoke device keys;
review and revoke them when replacing an untrusted authenticator.

## Pair a device

Use the public browser SDK for an independent PWA:

```ts
import { appApproval } from "@valentinkolb/cloud/browser/app-approval";

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
`client.pending(device)`, `client.decide(device, request, "approve" | "deny")`
or `client.revoke(device)`. Never call `decide` without explicit user approval
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
   setting. A claim alone creates no usable device.
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
The PWA and Cloud UI tickets must implement this camera-free path; the helpers
alone do not add a paste field or copy control to either website.

## Approve a browser sign-in

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
| `{operation:"pending"}` | `{requests, pollAfterSeconds}` for this device's account and Cloud only. Each request contains `requestId`, `challenge`, `comparison`, `createdAt`, `expiresAt`. |
| `{operation:"decide", requestId, challenge, comparison, decision:"approve"}` | `{state:"approved"}`. With `decision:"deny"`, returns `{state:"denied"}`. |
| `{operation:"revoke"}` | `{state:"revoked"}` for the signing device only. |

Fetching pending requests must **never** approve them automatically. Require
explicit confirmation and comparison with the initiating browser's code. The
authenticator receives no browser secret, session cookie, user API token,
FreeIPA password or Kerberos ticket.

The Cloud browser polls `POST /login/status` with `{requestId, browserSecret}`.
States are `pending`, `approved`, `denied`, `consumed`, or `expired`; after cleanup
an expired request may instead be unavailable. Once approved, call
`POST /login/complete` with that body. Success is HTTP 204 with the normal
HttpOnly Cloud session cookie, never a token in JSON. Completion is atomic and
one-use. A lost response or failed session issuance requires a new login.

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

For `decide`, append `requestId, challenge, comparison, decision` to the array.
All operation parameters are covered. Public `@valentinkolb/cloud/contracts`
exports include `appDeviceProofMessage`, `appPairingProofMessage`, request/response schemas
and `APP_APPROVAL_PROTOCOL`, `APP_APPROVAL_PATH`, `APP_APPROVAL_LIMITS`. These
helpers hold no credentials and make no network calls.

The compile-checked signing example is
`docs-site/examples/cloud-docs/app-approval.ts` in the Cloud checkout.

A proof expires within 60 seconds of issuance, has a positive lifetime, and
allows at most five seconds of future clock skew. Successful commands consume
`(deviceId, jti)` atomically. After losing a mutation response, inspect state
instead of blindly retrying with a new nonce.

## Transport, errors and limits

`GET /info` returns `{protocol, issuer, api, appOrigin, algorithm, limits}`.
Require the expected protocol, exact issuer and `ES256`. Discover only from an
explicitly trusted pairing issuer. PWA requests use `credentials:"omit"`.

Only `/info`, `/pairings/claim`, `/pairings/result` and `/device` allow CORS from
the configured authenticator origin. Preflight allows GET/POST and Content-Type,
not credentialed requests. Management and browser-login writes require the
exact Cloud Origin header. CORS is not authentication; non-browser callers
still need the appropriate proof or session.

Version 1 budgets are five-minute pairing/login lifetimes, five outstanding
pairings and five outstanding logins per account/Cloud, twenty active devices,
twenty device records per page and 8 KiB request bodies. These bound storage,
cryptographic work and response sizes. Poll at most once every five seconds
while foregrounded, stop on terminal states, and back off on errors. Background
PWA execution or push delivery is not guaranteed.

The existing Cloud IP rate limit applies. Operators must sanitize forwarded IP
headers at the trusted ingress. IP throttling returns HTTP 429 with Retry-After.
Other errors: 400 (invalid input), 401 (missing management session),
403 (forbidden or recent authentication required), 404 (unavailable object),
409 (used/stale/conflicting operation), 413 (body too large), and 503 (disabled,
invalid configuration or unavailable dependencies). Never log rejected bodies.

Core migrates four additive authentication tables. Expired transient rows are
removed in bounded batches on requests and by a minute-based schedule. The same
schedule retries enrollment notices after restarts; delivery deduplicates by
device ID. Device records remain until account deletion; revocation preserves
their history.

## Revoke and recover

`GET /manage/devices?after=<UUID>` lists only the current user's devices,
including revoked ones, as `{items,nextCursor}`. Items contain
`id,name,createdAt,lastUsedAt,revokedAt,assisted`.
`POST /manage/devices/update` accepts either
`{operation:"rename",deviceId,name}` or `{operation:"revoke",deviceId}`.
Both require recent authentication and ownership. Management remains available
when app approval is disabled.

Revocation before completion prevents even an approved request from being used.
Completion's database commit is the authorization boundary: later revocation
does not cancel issuance already authorized or existing sessions. Revoke
sessions separately during incident recovery. Conversely, session revocation
does not delete device credentials; changes to the account authentication epoch
invalidate outstanding login requests.

Account expiry and current category policy are checked on device operations and
completion. FreeIPA users use the synchronized **Cloud account**: there is no
live FreeIPA password, OTP or Kerberos check. Enabling this method permits an
independent Cloud credential for these accounts. Upstream disablement not yet
synchronized into Cloud cannot be observed here. Keep synchronization healthy
or disable app approval when immediate upstream revocation is required.

Recovery uses an existing supported login method followed by recent-session
device revocation. This API introduces no email override for FreeIPA, grants
no Linux access, and removes no passkeys.

## Verify the integration

Test two issuers and two accounts, wrong origins, key persistence after reload,
explicit confirmation, replay, expired proofs, concurrent completion, lost
responses, revocation and disabled accounts. The maintained service/HTTP fixture
is `packages/cloud/src/services/app-approval.integration.test.ts`; it refuses
to run against the development database or cache.

Review authenticator dependencies and service-worker updates as credential
handling code. Do not add analytics, remote scripts, exported private-key
backups or a shared cross-Cloud key as incidental integration work.
