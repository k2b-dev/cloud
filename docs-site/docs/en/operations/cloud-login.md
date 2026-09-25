---
title: Run Cloud Login
navTitle: Cloud Login PWA
section: Accounts & sign-in
order: 1090
description: Build and host the standalone authenticator for multiple Cloud installations.
tags: [authentication, pwa, deployment]
updated: 2026-09-25
---

# Run Cloud Login

Cloud Login is a standalone authenticator for one or more Cloud accounts. It connects
directly to each paired Cloud and uses a separate device key for each pairing.
It does not require a central account or session server. Its server can
optionally send push notifications that wake the app for new sign-in requests.

The project deployment address is [cloud-login.pwa.k2b.dev](https://cloud-login.pwa.k2b.dev).
For installation and everyday use, see [Cloud Login](/en/apps/cloud-login).
You can also host it at your own stable HTTPS origin.

## Run the container

Cloud Login ships with every Cloud release as `ghcr.io/k2b-dev/cloud-pwa-auth:vX.Y.Z`.
Pin the digest from the release's `release.json` in your deployment; see
[Release process](/en/docs/contributing/release-process). The image
supports AMD64 and ARM64, listens on port 3000, and exposes `/health`.
Without push configuration it runs without a database, volume, Cloud
credentials or runtime dependencies. [Push notifications](#send-push-notifications)
additionally need Postgres and NATS JetStream.

Put it behind HTTPS at the root of one dedicated, stable origin. Preserve its
cache and content-type headers. The container supports a read-only filesystem
and runs as an unprivileged user. Publishing the image does not deploy it.
Route a release coherently: upload new hashed assets before switching HTML and
the service worker, retain old hashed assets during rollout, and keep the prior
image digest for rollback. Changing the image does not reset device vaults; check
storage-format compatibility before reverting after users opened a newer version.
The image reports its `CLOUD_VERSION` in **Settings**; a custom build
without one shows `unreleased`.

## Build and configure

Run `bun run --cwd pwas/pwa-auth build` in the monorepo and serve the resulting
`dist/` directory at the root of one stable HTTPS origin. Use
`Cache-Control: no-store` for HTML and `sw.js` and `Referrer-Policy: no-referrer`. Host scripts
and assets locally; do not add third-party scripts or analytics to this origin.

The service worker caches static app files for offline startup after one
successful online load, never Cloud API responses. Device credentials are stored
encrypted in the browser. Pairing
and approvals require a connection. A downloaded update waits until all open
Cloud Login tabs/windows close, then applies on a subsequent launch. Reloading
an open app does not force the update. Publish builds atomically and retain old
hashed assets during rollout.

In each Cloud, enable app approval and configure this exact authenticator origin
as described in [Set up app sign-in](/en/docs/accounts/app-sign-in).
Changing either origin requires reviewing the existing pairings.

## Send push notifications

Push notifications are optional. They only wake the phone: the app still loads
every request through the signed Cloud connection, and approving still needs
the code comparison. Without push, everything works as before; users open the
app to see pending requests.

A browser push subscription belongs to one VAPID key, so the Cloud Login
server, not each Cloud, owns the key pair and sends every notification. One
Cloud Login deployment therefore serves all Clouds its users pair with.

### Configure the server

Generate the key pair once and keep it stable:

```sh
bunx web-push generate-vapid-keys
```

| Variable | Value |
| --- | --- |
| `CLOUD_LOGIN_VAPID_PUBLIC_KEY` | Public key from the command above. |
| `CLOUD_LOGIN_VAPID_PRIVATE_KEY` | Private key. Store it as a secret. |
| `CLOUD_LOGIN_VAPID_SUBJECT` | Operator contact for push services, `mailto:ops@example.org` or an `https://` URL. |
| `DATABASE_URL` | Postgres connection. Cloud Login creates the `cloud_login` schema at startup. |
| `NATS_SERVERS` | NATS JetStream servers, as for Cloud. `NATS_CREDS_FILE` and `NATS_TLS_CA_FILE` work the same way. |
| `SYNC_NAMESPACE` | For example `cloud-login`. Use a namespace of its own when sharing a NATS cluster with a Cloud. |
| `SYNC_REPLICAS` | `1`, `3` or `5` JetStream replicas; default `3`. |

Set all three VAPID variables or none. With none, push is off and the
`/push/*` routes answer 404; the app then shows notifications as not supported.
With them, the server refuses to start when Postgres or NATS is missing, or
when the private key does not match the public key. Several replicas can run
at once: they share the database and the NATS queue. See the
[configuration reference](./configuration.md#application-pwa-auth).

Changing the private key invalidates every phone's subscription. Users then
reconnect under **Notifications**. Back up the key with your other secrets.

### Network and data

The server needs outbound HTTPS to the browsers' push services, for example
`fcm.googleapis.com` (Chrome, Edge, Android), `*.push.apple.com` (Safari,
iPhone, iPad), `updates.push.services.mozilla.com` (Firefox) and
`*.notify.windows.com`. It only connects to public addresses. Each Cloud needs
outbound HTTPS to the Cloud Login origin.

`cloud_login.push_subscriptions` stores one row per phone: the push
endpoint and its public encryption keys, a SHA-256 hash of the push token,
creation time, last successful delivery and a failure count. It stores no
Cloud, account or request data. `cloud_login.push_rate_limits` holds short-lived
counters keyed by hashes; old windows are removed every minute.

A notification is encrypted for the phone (RFC 8291) and contains only the
Cloud origin and an opaque request reference. The phone shows
“Sign-in request for cloud.example.org”; codes, secrets and account names
never pass through Cloud Login's server or the push service.

### Delivery and limits

Clouds send wake-ups to `POST /push/notify`. The server queues them in NATS
JetStream and answers at once. A worker delivers each one with a five-minute
push TTL and high urgency. Temporary failures are retried after 2, 10 and 30
seconds; a message that still fails lands in the queue's dead-letter store
and increments the subscription's failure count. A push service answer of 404
or 410 deletes the subscription, so the next notification for its token
answers 410 and the Cloud forgets the token. The same sign-in request wakes a
phone once, however often a Cloud retries.

| Limit | Value |
| --- | --- |
| Wake-ups per push token | 30 per five minutes |
| Requests per caller address | 3,000 per five minutes for `/push/notify` and `/push/test` |
| New subscriptions per caller address | 30 per five minutes |
| Request body | 1 KiB for notifications, 4 KiB for subscriptions |

The five-minute window matches the lifetime of a sign-in request. Callers are
identified like in Cloud: by the first `X-Forwarded-For` address, then
`X-Real-IP`, then the connection. Sanitize forwarding headers at your ingress.
Exceeded limits answer 429 with `Retry-After`.

### Push API

All bodies are JSON with no extra fields. Responses use `Cache-Control: no-store`.

| Request | Result |
| --- | --- |
| `GET /push/config` | `{publicKey}` for `PushManager.subscribe`. |
| `POST /push/subscriptions` with a `PushSubscription` JSON | 201 `{token}`. The token is a random 256-bit capability. Subscribing the same endpoint again replaces its previous token. Push endpoints must be public HTTPS URLs. |
| `DELETE /push/subscriptions/:token` | 204, also for unknown tokens. |
| `POST /push/notify` with `{token, cloudOrigin, requestRef}` | 202 queued, or 410 when the token is unknown or its subscription expired. `requestRef` has 1–64 URL-safe characters. |
| `POST /push/test` with `{token}` | 202 or 410; sends a test notification. |

Anyone holding a push token can make that phone show a sign-in notification,
up to its rate limit, but cannot read or approve anything. The app hands its
token only to the Clouds it is paired with, through each Cloud's signed device
channel, and again whenever the token changes. Revoking a device in Cloud or
through **Disconnect Cloud** stops its wake-ups. **Only remove from this app**
does not revoke the device, so that Cloud keeps sending wake-ups until you
revoke it there.

## Protect the app

The first **Add Cloud** action offers PIN setup before pairing starts. Choose
**Continue without PIN** or enter a six-digit PIN twice; leading zeroes count.
The choice is saved, so adding another Cloud does not ask again. Without a PIN,
the app opens directly and does not lock automatically or offer **Lock app**.
Anyone who can open the app can approve sign-ins; its stored vault key has no
PIN protection.

One PIN protects every connected Cloud on this device. Entering the sixth digit
in the unlock dialog starts unlocking automatically. Wrong PINs leave the app locked and impose a local
delay rising from one to thirty seconds.

A six-digit PIN has at most one million combinations. Argon2id makes guessing
more expensive but cannot prevent offline guessing against copied app data.
The retry delay survives reloads, but clearing or changing browser data can
bypass it; it is not a hardware guess limit.

With a PIN, the unlock dialog opens on startup or return to the locked app.
The app starts locked after a reload and locks after one minute in the background, on page
exit, after five minutes without interaction, or through **Lock app**. Locking
hides account details, closes sensitive dialogs, and stops polling. Other open
tabs receive the lock as well.

**App security** lets you add a PIN later without pairing again. If a PIN is
already set, it asks for the current PIN before setting a new one. The new PIN
must successfully unlock before it is saved. Cloud pairings remain unchanged.
If the stored protection method is unsupported, the app offers an explicit
reset and re-pairing path. Nothing is deleted automatically.

Changing app protection does not secure copies of browser data that an attacker
already obtained. After suspected compromise, revoke the devices in Cloud and
pair again.

If no configured method works, **Reset Cloud Login** removes local pairings
and protection after confirmation. It does not revoke devices in the Clouds.
Use another Cloud sign-in method to revoke old devices and pair again.
If the app asks you to reset unsupported stored data, review and revoke its old
devices in Cloud before pairing again.

## Connect a Cloud

On your own Cloud profile page, open **Security → Paired devices → Pair a device**.
Copy the link into **Add Cloud** in Cloud Login, open the link on the same device,
or choose **Scan QR code** to scan inside Cloud Login. The phone's camera can
also open the link. All paths carry the same temporary link.

Invalid pasted links remain editable. The app distinguishes expired links from
links intended for another app origin. After you trust the Cloud, progress is
shown while connecting and pairing. Network requests time out after 30 seconds.
If a claim may already have reached Cloud, the app checks its status without
resending it. You can use another link after an error.
The PWA removes its fragment from browser history before contacting the Cloud.

The in-app scanner requests camera access only after a click. Its images stay
on the device; closing or hiding the page stops the camera. If access is denied,
paste the link instead. Scanning never skips issuer consent or confirmation.

Check the Cloud address before trusting it. Choose an account label for this
device and a device name, compare the code in both windows, and confirm in the
original Cloud session. Once Cloud confirms, choose **Both codes match** in
Cloud Login to finish pairing. The local label is user-chosen, not verified account metadata.

A switch to the Cloud window keeps Cloud Login unlocked for up to one minute.
After a longer absence, it locks and closes the pairing dialog.
Unlock and paste the same unexpired link again to reuse the stored key. Pairing links expire
after five minutes. If the link expires, start again in Cloud and revoke any
previously confirmed device you can no longer use.

## Manage connected accounts

Open **Manage accounts** from the menu. Choose **Add Cloud** to connect another
account. Language and appearance are grouped under **Settings**. Use the pencil to change a local account
label, or the delete button to open the disconnect confirmation. Nothing is
removed until you confirm. By default, disconnecting revokes the device in Cloud;
the explicit local-only option removes it from this app without revocation.

## Approve and recover

Cloud Login checks for pending sign-ins while visible and online. New requests
open a bottom sheet once the app is unlocked and no other dialog is open.
Requests from all connected Clouds are shown in order. Dismissing the sheet
does not deny a request; open it again from its Cloud card. Compare its code
with the waiting browser, and explicitly approve or deny it.
A failing Cloud does not block the others. After an uncertain response, check
the original browser and start a new sign-in if needed; Cloud Login does not
silently resend the decision.

**Disconnect Cloud** offers device revocation and explicit local removal.
Local removal does not revoke the device in Cloud. Existing browser sessions
must be revoked separately.

Cloud Login stores device credentials encrypted in this browser. The app lock
does not protect against malicious code running on the authenticator website
or a compromised device. Deleted
browser data has no automatic recovery: sign in with another supported method,
revoke the old device and pair again. Do not assume that browser tabs, installed
apps and embedded browsers share storage; pair in the app you will actually use.

The dots menu also offers notifications, language, appearance, and installation guidance.
Approvals need an internet connection. Before making the app available to your
organization, check camera access, installation, notifications and switching
between Cloud and the app on the devices and browsers you support.

## Turn on notifications

When the server offers push, an installed app shows a **Turn on notifications**
card on first launch. The permission prompt appears only after a tap on
**Turn on**; the app never asks on its own. **Not now** hides the card, and
**Notifications** in the menu shows the status at any time:

| Status | Meaning and action |
| --- | --- |
| Active | This device is registered. **Send test notification** checks the whole chain. |
| Not requested yet | **Ask again** shows the browser's permission prompt. |
| Not allowed | The browser blocked notifications and cannot ask again. The app lists the steps for the system or browser settings, for example **Settings › Notifications › Cloud Login** on iPhone. |
| Not connected | Allowed, but registration failed. **Connect again** retries. |
| App not installed | iPhone and iPad allow web push only for apps on the Home Screen, from iOS 16.4. **Show steps** explains **Add to Home Screen**. |
| Not supported | The browser or this Cloud Login server offers no push. |

After notifications are on, the app sends its push token to every paired
Cloud the next time it is unlocked, and to newly paired Clouds right after
pairing. Clouds without push support keep working without notifications.
Tapping a notification opens Cloud Login, or focuses it, and shows that
request first once the app is unlocked. Notifications are not guaranteed:
the phone, its battery saver or the push service may delay or drop them.

For troubleshooting, open **Settings** and note the version shown below the
appearance control. Release images show their tag and source revision; local
development shows `dev`.

## Touch gestures

Cloud Login disables page pinch zoom, including in dialogs. Touch scrolling
remains available.
