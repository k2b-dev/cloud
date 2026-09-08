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

Keep the pairing dialog open when switching to the Cloud window. After a reload,
paste the same unexpired link again to reuse the stored key. Pairing links expire
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

Private keys stay in this browser's IndexedDB and cannot be exported through
WebCrypto. This is not a hardware-protection or biometric guarantee. Deleted
browser data has no automatic recovery: sign in with another supported method,
revoke the old device and pair again. Do not assume that browser tabs, installed
apps and embedded browsers share storage; pair in the app you will actually use.

The dots menu also offers language, appearance, and installation guidance.
Offline approvals and push delivery are not implemented. Actual camera scanning,
iOS/Safari installation and Android same-device handoff still require device
acceptance before an operator promises those flows to users.
