---
title: Build a shared-device visit app
navTitle: Visit example
section: Frontend
order: 837
description: Run a standalone example that pairs a shop iPad and lets a customer sign offered document revisions.
tags: [pwa, example, scanner, signature]
updated: 2026-10-23
---

# Build a shared-device visit app

The [standalone visit example](https://github.com/k2b-dev/cloud/tree/main/packages/cloud/examples/app-pwa)
shows the complete App-PWA flow: an employee pairs a device, opens a visit by
QR, and offers two fictional documents for a customer to sign. It uses public
Cloud imports and can be copied into an application's own repository.

Read [App-PWA installation](/en/docs/frontend/app-pwa) and
[device and visit sessions](/en/docs/identity/app-pwa-sessions) first. The
example's README contains dependency, environment, build, and gateway setup
instructions. Use the package release that includes those APIs; the older
registry package cannot run the new example.

## Run the two screens

Open `/app/visit-demo/devices` in the employee's signed-in browser. Open
`/app/visit-demo/counter/` in a separate iPad browser profile with no employee
sign-in, then install it from the browser's installation menu.

1. On the employee screen, enter a device name and select **Laden-iPad koppeln**.
   Show the QR on that screen; the iPad scans it with **QR scannen**.
2. Wait for **Laden-iPad gekoppelt**, the device name, and the revoke action.
   Select **Besuchs-QR zeigen** and scan that QR on the iPad.
3. Read the offered contract revision. Sign with ink or a typed name, confirm
   consent, and explicitly save. Then read and sign the receipt.
4. The final signature completes the visit in the same transaction. The iPad
   shows a neutral confirmation and can return to the next customer's flow.

The seeded customer is Lea Muster and the example amount is €450. The payment
row is already marked paid; the example does not execute payments. The receipt
is offered only when the application confirms payment. The sample contract
text is fictional, and a captured signature does not establish identity.

## Find each responsibility

| File | Responsibility |
| --- | --- |
| `src/config.ts` | Installation declaration, application access, and gateway prefixes |
| `src/platform.ts` | Staff access and authorization of the example visit subject |
| `src/domain.ts` | Offered document revisions, payment state, validated signatures, and durable domain writes |
| `src/routes.tsx` | Neutral SSR, staff SSR, and mounting the closed protocol router |
| `src/http.ts` | Bounded JSON transport, CSRF bootstrap, strict QR claims, and attempt reconciliation |
| `src/Kiosk.tsx` | Scanner, document review, signature consent, pending states, and recovery |
| `src/Staff.tsx` | Pairing confirmation, visit QR, paginated device list, and revocation |

The scanner and signature control come from `@k2b/ui`. Application code owns
the visit flow, domain validation, and final messages. The device stays a
device actor, even though it belongs to the employee who paired it.

## Keep failures recoverable

The example starts without customer content. It fetches an authorized snapshot
after mounting and clears sensitive display state and unfinished ink when the
page is hidden or loses its connection. Return, reload, and Back revalidate
before displaying documents. A late response cannot restore an abandoned view.

A lost save response displays **Speicherstatus prüfen**. The client checks the
same attempt and uses the server's completion state before announcing success.
A document revision conflict requires reading and signing the new revision.
Ending a visit hides content immediately but remains unconfirmed until the
server responds. The device and visit clocks are never extended by polling.

Tests accompany the example for HTTP adapters, domain input, neutral rendering,
customer and employee flows, camera failure, response loss, stale responses,
and light/dark phone and iPad layouts. Browser automation cannot establish
Safari installation, Apple Pencil behavior, or storage separation on a real
iPad. Check those on the intended device before using the flow with real data.

Inside `authorizeStaff`, resolve the employee with
`accounts.users.get({ id: signIn.userId }, { db: tx })` before calling
`canUseApp(..., { db: tx })`. The optional `db` keeps the account and role-setting
reads on the supplied transaction, including with a one-connection pool.
