---
title: Run Cloud Login
navTitle: Cloud Login PWA
section: Accounts & sign-in
order: 1090
description: Build and host the standalone authenticator for multiple Cloud installations.
tags: [authentication, pwa, deployment]
updated: 2026-10-19
---

# Run Cloud Login

Cloud Login is a standalone authenticator for one or more Cloud accounts. It connects
directly to each paired Cloud and uses a separate device key for each pairing.
It does not require a central account or session server. Its server can
optionally send push notifications that wake the app for new sign-in requests.

The project deployment address is [cloud-login.pwa.k2b.dev](https://cloud-login.pwa.k2b.dev).
For installation and everyday use, see [Cloud Login](/en/apps/cloud-login).
You can also host it at your own stable HTTPS origin.

Cloud Login approves sign-ins and device actions only.
Decide [Action approvals](/en/docs/identity/approvals) in Cloud.

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
| Wake-ups per push token | 30 sign-in or test wake-ups and, separately, 30 Action wake-ups per five minutes |
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
| `POST /push/notify` with `{token, cloudOrigin, requestRef, kind?}` | 202 queued, or 410 when the token is unknown or its subscription expired. `requestRef` has 1–64 URL-safe characters. `kind` is `"login"` or `"action"`; omitted means `"login"`. Unknown kinds answer 400. |
| `POST /push/test` with `{token}` | 202 or 410; sends a test notification. |

The encrypted wake-up is `{v:1, type:"login" | "action", cloud, ref}`.
Delivery deduplicates by subscription, type, Cloud, and request reference.
Actions use a separate Web Push topic, so an Action wake-up cannot replace an
undelivered sign-in wake-up. Bodies without `kind` keep the original sign-in
message and topic.

Anyone holding a push token can make that phone show a sign-in or Action notification,
up to its rate limit, but cannot read or approve anything. The app hands its
token only to the Clouds it is paired with, through each Cloud's signed device
channel, and again whenever the token changes. Revoking a device in Cloud or
through **Disconnect Cloud** stops its wake-ups. **Only remove from this app**
does not revoke the device, so that Cloud keeps sending wake-ups until you
revoke it there.

## Protect the app

Cloud Login opens directly and never asks you to set an app PIN. Anyone who
can open it on an unlocked phone can approve sign-ins and Actions. Protect the
phone with its own screen lock.

Device credentials are encrypted in browser storage, but the key is stored
alongside them. Copied browser data is a full credential. After suspected
compromise, revoke the devices in each Cloud and pair again. Without a usable
paired device, an administrator revokes them. Removing a PIN
or resetting the app does not secure copies an attacker already obtained.

An existing install that still has a PIN starts with **Remove app PIN**.
Enter the PIN one last time to keep all connected Clouds. Cloud Login then
removes the PIN, confirms with **App PIN removed**, and opens directly on later
launches. Wrong PINs keep it locked
with the existing retry delay of one to thirty seconds, including after reload.

If you forgot the PIN, or the stored protection method is unsupported, use
**Reset Cloud Login**. After confirmation, this removes local pairings and
protection. It does not revoke devices or sessions in your Clouds. Sign in
there another way, revoke the old devices and pair again. Their removal needs
approval on another paired device; without one, ask an administrator to revoke
them. Nothing is deleted automatically.

## Connect a Cloud

On your own Cloud profile page, open **Sign-in → Paired devices → Pair a device**.
Copy the link into **Add Cloud** in Cloud Login, open the link on the same device,
or choose **Scan QR code** to scan inside Cloud Login. The phone's camera can
also open the link. All paths carry the same temporary link.

Invalid pasted links remain editable. The app distinguishes expired links from
links intended for another app origin. After you trust the Cloud, progress is
shown while connecting and pairing. Network requests time out after 30 seconds.
If a claim may already have reached Cloud, the app checks its status first.
It retries the claim with the saved key only when Cloud still reports it as
pending. **Retry pairing** checks again after an interruption; **Use another
link** starts over after an error.
The PWA removes its fragment from browser history before contacting the Cloud.

The in-app scanner requests camera access only after a click. Its images stay
on the device; closing or hiding the page stops the camera. If the camera
cannot start, the app says why: access is off, no camera was found, or the
camera is busy, most often because another app uses it. Paste the link instead.
Scanning never skips issuer consent or confirmation.

Check the Cloud address before trusting it. Cloud suggests an account label,
and your browser suggests a device name. Both fields are editable. Compare
the code in both windows and confirm in the original Cloud session. Once
Cloud confirms, choose **Both codes match** in Cloud Login to finish pairing.
The local label is not verified account metadata.

Only **Close** or the X closes the pairing dialog. Tapping outside, dragging
down or pressing Escape does not close it. Escape is disabled throughout the
flow so its meaning does not change between steps. Switching apps pauses
requests; returning resumes status checks. Connection failures stay visible
and offer **Retry pairing**. If the page reloads or closes, open **Add Cloud**:
it reports an unfinished saved pairing. Paste the same link to reuse its key
and names; the link itself is never stored. Links expire after five minutes;
a claimed pairing can wait longer for approval on another device. If Cloud
reports expiry, start again there and revoke any previously confirmed device
you can no longer use.

### Suggest a Cloud label

In Cloud's administration settings, set **Name in Cloud Login**
(`user.app_approval.label`). Empty uses the application display name (`app.name`),
whose default is **My App**. New pairing links carry the suggestion, shortened
to the label field's 80 characters. People can change it before pairing.
Changing either setting leaves existing connections and saved enrollments
unchanged.

**Upgrade:** update the separately hosted Cloud Login app before updating
Cloud. Close all its tabs and windows so the service worker can activate,
then reopen it. Older authenticator clients with a strict payload parser must
accept the optional `label` field before they read new pairing links. The
updated app also accepts links from earlier Clouds without a label.

### What a browser can suggest about this device

- Android Chromium browsers can return `model` and `platformVersion` through
  `navigator.userAgentData.getHighEntropyValues()`. A model may be a name such
  as **Pixel 8**, a manufacturer code such as **SM-S911B**, or empty. Cloud
  Login uses the reported value without guessing a marketing name. If hints
  are unavailable or refused, it uses **Android**, with the reported version
  when available.
- Safari on iPhone and iPad does not implement User-Agent Client Hints and
  does not expose the exact hardware model or the personal name from Settings.
  Cloud Login suggests **iPhone** or **iPad** and adds the iOS/iPadOS version
  only when the user-agent explicitly reports it. That version may be frozen
  or reduced by the browser; it is not a verified OS version. A desktop-mode
  iPad reports a Mac user-agent: the app uses its Mac platform plus multitouch
  capability as an iPad suggestion and never labels the reported Mac version
  as iPadOS. This is a heuristic, not proof of the device type.
- Desktop browsers get a suggestion such as **Firefox on macOS**. All names
  remain editable. No canvas, WebGL, screen-size model lookup, hardware
  fingerprinting or external device database is used.

Sources: [MDN: getHighEntropyValues](https://developer.mozilla.org/en-US/docs/Web/API/NavigatorUAData/getHighEntropyValues)
and [WebKit: desktop-class browsing on iPad](https://webkit.org/blog/9674/new-webkit-features-in-safari-13/#desktop-class-browsing-on-ipad).

## Manage connected accounts

Open **Manage accounts** from the menu. Choose **Add Cloud** to connect another
account. Language and appearance are grouped under **Settings**. Use the pencil to change a local account
label, or the delete button to open the disconnect confirmation. Nothing is
removed until you confirm. By default, disconnecting revokes the device in Cloud;
the explicit local-only option removes it from this app without revocation.

The info button at the top right of each Cloud card shows which account the
pairing signs in: the username, with a copy button, the name if one is set, and
the email or **Not set**. It also shows the device name, the pairing date and
the last approval from this device. The app asks the Cloud through the signed
device channel each time the details open, so the request never passes through
the Cloud Login server. It keeps a copy with the other encrypted connection
data. When the Cloud cannot be reached or no longer accepts this device, the app
shows that copy with the date it was saved. A Cloud without this feature shows
only the device facts. The last approval is recorded on this device and appears
after the next approval.

## Approve and recover

Cloud Login checks for waiting requests while visible and online. New sign-in
requests open a bottom sheet when no other dialog is open.
Requests from all connected Clouds are shown in order. Dismissing the sheet
does not deny a request; open it again from its Cloud card. Compare its code
with the waiting browser, and explicitly approve or deny it.
A failing Cloud does not block the others. After an uncertain response, check
the original browser and start a new sign-in if needed; Cloud Login does not
silently resend the decision. If the account is signed out everywhere before
browser completion, its earlier approval cannot create a session; start a new
sign-in.

Cloud Login opts in to `login-context` on both `inbox` and `pending` reads
only when the Cloud announces it in `/info.features`; the public SDK filters
the signed opt-in, so Core and Cloud Login can be upgraded in either order.
No new configuration is required. Once both support it, browser requests show
[sign-in context](/en/docs/accounts/app-sign-in#read-the-request-details).
Context stays optional: requests started before the Core upgrade or trimmed
for the 8 KiB response budget can omit it. Those requests and older Clouds
keep the earlier dialog with the start time. Terminal sign-ins are unchanged.

Cloud Login opts in to `terminal-logins` only when the Cloud announces it in
`/info.features`. Older Clouds keep browser sign-ins only. A terminal sign-in
starts with `cld login --user <name>`, where `<name>` is the username or email.
For terminal sign-ins, the sheet shows the client name from the Cloud's
registry in the title, the Cloud host, the comparison code, the login lifetime
and every scope in plain words; unknown scope codes appear verbatim. The
lifetime is `user.session.expiry_hours`, at most 90 days; `cld login --ttl`
can only shorten it.
One tap approves exactly these scopes for that lifetime, with no scope
downgrade in the sheet; people who want fewer rights sign in with
`cld login --scope`.
Uncertain and expired endings direct the user to the terminal to check the
result or start again. If the account is signed out everywhere before the
terminal finishes, its earlier approval no longer counts; run `cld login`
again. Upgrade **Core, then OAuth, then Cloud Login**; see
[Approve a terminal sign-in](./app-approval.md#approve-a-terminal-sign-in).

Actions appear below the sign-ins in each Cloud card, with the app's name,
its sentence, the chat title when available, and the request time. They stay
in the list until you choose **Review**; arriving Actions never open a sheet
on their own. If more are waiting, the card shows how many to review in Cloud.
Older Clouds continue to show sign-ins only.

**Review** loads and checks the request before the sheet opens, so the sheet
appears complete. If loading or checking fails, the row says so in place of
its chat title and time; review the request in Cloud.

The review sheet identifies the app and Cloud host in Cloud Login's own frame,
then names the requesting app. The quoted sentence, message, chat title and
details are the application's text; they are displayed as text, without HTML
or links. Read them before choosing **Approve** or **Deny**. Shortened requests
carry a note to see everything under **My account → Approvals** in Cloud.
**Asks every time** marks an Action that always needs confirmation. The sheet
shows its remaining lifetime. Both buttons become available half a second
after the sheet opens.

The result replaces the request in the same sheet, at the same height:
**Approved** and that the requesting app continues in Cloud, or **Denied** and
that nothing happens. **Not applied** means the request was already decided,
expired or changed (Cloud answered HTTP 409); it leaves the list, check it in
Cloud. **Not confirmed** means the result is uncertain; Cloud Login never sends
the decision again, so check its status in Cloud. **Expired** appears when the
request runs out while the sheet is open. Choose **Done** to close the sheet.

**Disconnect Cloud** offers device revocation and explicit local removal.
Local removal does not revoke the device in Cloud. Existing browser sessions
must be revoked separately.

Cloud Login stores device credentials encrypted in this browser. Malicious
code running on the authenticator website or a compromised device can use them.
Deleted browser data has no automatic recovery: sign in with another supported method,
revoke the old device and pair again. Without another method, an administrator
[revokes the device](./app-approval.md#revoke-a-device-for-someone-else) and
can help pair a new one. Do not assume that browser tabs, installed
apps and embedded browsers share storage; pair in the app you will actually use.

The dots menu also offers notifications, language, appearance, and installation guidance.
Approvals need an internet connection. Before making the app available to your
organization, check camera access, installation, notifications and switching
between Cloud and the app on the devices and browsers you support.

On Android, tell people to install from Chrome. On Samsung phones, Samsung
Internet builds its own app package, which Android 14 and later may block as
built for an older Android version. The manifest, icons and headers of this
origin neither cause nor prevent that warning. The app's installation guide
therefore offers **Open in Chrome** in Samsung Internet instead of an install
button. For what people see and how to move to Chrome, see
[Install on Android](/en/apps/cloud-login#install-on-android).

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
Cloud the next time it is open, and to newly paired Clouds right after
pairing. Clouds without push support keep working without notifications.
Tapping a notification opens Cloud Login, or focuses it, and shows that
request first once it appears in the Cloud's inbox. Notifications are not guaranteed:
the phone, its battery saver or the push service may delay or drop them.

Action notifications say **Approval requested on cloud.example.org** and
**Open Cloud Login to review it.** They name only the Cloud host, without app
names, sentences, chat titles or account details. Tapping one opens its review
sheet, also when the Cloud card does not list that request; you still read the
request and explicitly approve or deny it.

For troubleshooting, open **Settings** and note the version shown below the
appearance control. Release images show their tag and source revision; local
development shows `dev`.

## Touch gestures

Cloud Login disables page pinch zoom, including in dialogs. Touch scrolling
remains available. The page itself never scrolls or bounces: the header and the
note about saved connections stay in place, and only the list of Clouds scrolls
when it does not fit. On a phone in landscape, the note is hidden so the list
has more room.
