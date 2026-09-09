---
title: Run Cloud Login
navTitle: Cloud Login PWA
section: Accounts & sign-in
order: 1090
description: Build and host the standalone authenticator for multiple Cloud installations.
tags: [authentication, pwa, deployment]
updated: 2026-09-09
---

# Run Cloud Login

Cloud Login is a standalone authenticator for one or more Cloud accounts. It connects
directly to each paired Cloud and uses a separate device key for each pairing.
It does not require a central account or session server.

The project deployment address is [cloud-login.pwa.k2b.dev](https://cloud-login.pwa.k2b.dev).
For installation and everyday use, see [Cloud Login](/en/apps/cloud-login).
You can also host it at your own stable HTTPS origin.

## Run the container

Cloud Login has its own image release, independent of Cloud application images.
Use `ghcr.io/<repository-owner>/cloud-pwa-auth:pwa-auth-v<version>` after the
release workflow succeeds, and pin its digest in your deployment. The image
supports AMD64 and ARM64, listens on port 3000, and exposes `/health`.
It runs without a database, volume, Cloud credentials or runtime dependencies.

Put it behind HTTPS at the root of one dedicated, stable origin. Preserve its
cache and content-type headers. The container supports a read-only filesystem
and runs as an unprivileged user. Publishing the image does not deploy it.
The repository's `pwas/pwa-auth/RELEASING.md` describes release verification,
version tags and rollout precautions.

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

## Protect the app

The first **Add Cloud** action requires app protection before pairing starts.
Choose a passkey (recommended when available), a six-digit app PIN, or add the
second method later through **App security**. When both are configured, the
unlock dialog lets you switch between the six masked PIN fields and passkey
unlock. Entering the sixth PIN digit starts unlocking automatically. Wrong PINs
leave the app locked and impose a local delay rising from one to thirty seconds.
Switching methods clears any entered PIN. Either configured method unlocks
all Clouds in this browser installation. This does not approve a sign-in.

A passkey can use face recognition, a fingerprint, or the device code, as chosen
by the operating system. The app checks the selected provider's encryption
support during setup; browser support alone is not sufficient. If that check
fails, choose a compatible provider or set a PIN. A passkey saved in the password
manager does not by itself mean app protection is ready: the encryption check
and a successful unlock must finish first.

Enter a PIN twice, with exactly six digits; leading zeroes count. A PIN has at
most one million combinations. Its slow Argon2id derivation makes guessing more
expensive but cannot prevent offline guessing against copied browser data.
Adding a PIN fallback also gives such an attacker a PIN-based route into the
vault, even when a passkey is configured. Local retry delays are not a hardware
guess limit. Failed attempts and the remaining delay survive reloads, but
clearing or changing browser data can bypass this local delay.

The unlock dialog opens automatically on startup or return to the locked app.
It can be dismissed; passkey verification starts with an explicit button press.

The app starts locked after a reload and locks after one minute in the background, on page exit, after
five minutes without interaction, or through **Lock app**. Locking hides Cloud
and account details, closes sensitive dialogs, and stops polling. Other open
tabs receive the lock as well. Operating-system passkey dialogs may temporarily
hide a page during authentication. The app waits up to one minute for the page
to return before accepting the result; closing or locking the app cancels it.

**App security** requires a fresh unlock before adding, replacing, or removing
a method. A new method must successfully unlock before it is saved. The last
method cannot be removed. Changing the PIN keeps your Cloud pairings.
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

The dots menu also offers language, appearance, and installation guidance.
Approvals need an internet connection. Open the app to see pending requests;
there are no push notifications. Before making the app available to your
organization, check camera access, installation and switching between Cloud
and the app on the devices and browsers you support.

For troubleshooting, open **Settings** and note the version shown below the
appearance control. Release images show their tag and source revision; local
development shows `dev`.
