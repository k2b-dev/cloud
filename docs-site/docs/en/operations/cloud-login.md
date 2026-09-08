---
title: Run Cloud Login
section: Operations
order: 1177
description: Build and host the standalone authenticator for multiple Cloud installations.
tags: [authentication, pwa, deployment]
updated: 2026-09-08
---

# Run Cloud Login

Cloud Login is the standalone authenticator in `pwas/pwa-auth`. It connects
directly to each paired Cloud and uses a separate device key for each pairing.
It does not require a central account or session server.

## Build and configure

Run `bun run --cwd pwas/pwa-auth build` in the monorepo and serve the resulting
`dist/` directory at the root of one stable HTTPS origin. Use
`Cache-Control: no-store` for HTML and `sw.js` and `Referrer-Policy: no-referrer`. Host scripts
and assets locally; do not add third-party scripts or analytics to this origin.

The production build caches only its static app files for offline startup after
one successful online load. Cloud APIs and credentials are never cached. Pairing
and approvals require a connection. A downloaded update waits until all open
Cloud Login tabs/windows close, then applies on a subsequent launch. Reloading
an open app does not force the update. Publish builds atomically and retain old
hashed assets during rollout. The development server does not register a worker.

In each Cloud, enable app approval and configure this exact authenticator origin
as described in [App approval API](./app-approval.md). Cloud Login uses the
public browser SDK to validate discovery and send device-authenticated requests.
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
fails, choose a compatible provider or explicitly set a PIN. Local development
of passkey unlock requires `http://localhost:4178`, because numeric IP addresses
are not valid WebAuthn relying-party IDs. Production requires stable HTTPS.

Enter a PIN twice, with exactly six digits; leading zeroes count. A PIN has at
most one million combinations. Its slow Argon2id derivation makes guessing more
expensive but cannot prevent offline guessing against copied browser data.
Adding a PIN fallback also gives such an attacker a PIN-based route into the
vault, even when a passkey is configured. Local retry delays are not a hardware
guess limit. Failed attempts and the remaining delay survive reloads, but
clearing or changing browser data can bypass this local delay.

The app starts locked after a reload and locks when hidden, on page exit, after
five minutes without interaction, or through **Lock app**. Locking hides Cloud
and account details, closes sensitive dialogs, and stops polling. Other open
tabs receive the lock as well. Operating-system passkey dialogs may temporarily
hide a page during authentication; they do not keep an unlocked vault alive.

**App security** requires a fresh unlock before adding, replacing, or removing
a method. A new method must successfully unlock before it is saved. The last
method cannot be removed. Changing the PIN keeps your Cloud pairings. Changes
replace the current unlock envelopes atomically, but cannot revoke access to
previously copied envelopes or data: a previously recovered vault key remains
sensitive. After suspected key compromise, revoke the affected Cloud devices
and pair them again.

If no configured method works, **Reset Cloud Login** removes local pairings
and protection after confirmation. It does not revoke devices in the Clouds.
Use another Cloud sign-in method to revoke old devices and pair again.
Older installations with unencrypted, non-exportable keys also require this
explicit reset and new pairings; those keys cannot be wrapped retrospectively.
No automatic deletion or conversion takes place.

## Connect a Cloud

On your own Cloud profile page, open **Security → Devices** and start pairing.
Copy the link into **Add Cloud** in Cloud Login, open the link on the same device,
or choose **Scan QR code** to scan inside Cloud Login. The phone's camera can
also open the link. All paths carry the same temporary link.
The PWA removes its fragment from browser history before contacting the Cloud.

The in-app scanner requests camera access only after a click. Its images stay
on the device; closing or hiding the page stops the camera. If access is denied,
paste the link instead. Scanning never skips issuer consent or confirmation.

Check the Cloud address before trusting it. Choose an account label for this
device and a device name, compare the code in both windows, and confirm in the
original Cloud session. Finish pairing in Cloud Login after confirming that
the codes match. The local label is user-chosen, not verified account metadata.

Switching to the Cloud window can lock Cloud Login and close the pairing dialog.
Unlock and paste the same unexpired link again to reuse the stored key. Pairing links expire
after five minutes. If the link expires, start again in Cloud and revoke any
previously confirmed device you can no longer use.

## Approve and recover

Cloud Login checks for pending sign-ins while visible and online. Open a request,
compare its code with the waiting browser, and explicitly approve or deny it.
A failing Cloud does not block the others. After an uncertain response, check
the original browser and start a new sign-in if needed; Cloud Login does not
silently resend the decision.

**Disconnect Cloud** offers device revocation and explicit local removal.
Local removal does not revoke the device in Cloud. Existing browser sessions
must be revoked separately.

IndexedDB stores encrypted Cloud keys and account records. Runtime signing keys
are imported as non-exportable WebCrypto keys and discarded on lock. This is
not a hardware-protection or biometric-only guarantee; malicious same-origin
JavaScript or a compromised operating system can defeat the local lock. Deleted
browser data has no automatic recovery: sign in with another supported method,
revoke the old device and pair again. Do not assume that browser tabs, installed
apps and embedded browsers share storage; pair in the app you will actually use.

The dots menu also offers language, appearance, and installation guidance.
Offline approvals and push delivery are not implemented. Actual camera scanning,
iOS/Safari installation and Android same-device handoff still require device
acceptance before an operator promises those flows to users.
