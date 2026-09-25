---
title: Cloud Login
navTitle: Cloud Login
section: Companion apps
order: 500
description: Approve sign-ins to multiple Clouds from one installable app.
tags: [authentication, pwa, devices]
updated: 2026-09-25
---

# Cloud Login

Cloud Login is an installable web app for approving sign-ins to your Cloud
accounts. Connect accounts from different Clouds and manage them in one place.
It runs separately from the Cloud installations you connect.

[Open Cloud Login](https://cloud-login.pwa.k2b.dev)

## Start using it

Your Cloud administrator must first [enable app sign-in](/en/docs/accounts/app-sign-in)
and choose the authenticator address. Use the app configured by your Cloud.

1. Open Cloud Login and choose **Install app** from its menu, or continue in your browser.
2. Choose **Add Cloud** and set up a six-digit app PIN or choose **Continue without PIN**.
3. On your Cloud profile, open **Security → Pair a device**. Scan the QR code or
   paste its link into Cloud Login, then compare and confirm the codes.
4. When you start a sign-in, open Cloud Login or tap its notification. Compare
   the code shown in the request with the sign-in page, then approve or deny it.

Pair each account separately. You can add another Cloud, edit account labels,
or disconnect an account through **Manage accounts**.

## Protect and recover

An optional six-digit app PIN protects all connected accounts on this device.
Without a PIN, anyone who can open this app can approve sign-ins. Add a PIN
later through **App security** without pairing again. To change an existing PIN,
enter the current one first.

Keep another sign-in method available. If you lose your device or reset the
app, sign in to each Cloud another way, revoke the old device, and pair again.

The app can start offline after its first online visit. Pairing and approvals
need a connection.

## Get notified

Choose **Turn on** on the **Turn on notifications** card, or open
**Notifications** in the menu. You then get a notification such as
“Sign-in request for cloud.example.org” when you start a sign-in. It contains
only the Cloud address, never codes or account details. Tap it to open the
request. **Send test notification** checks that notifications arrive.

On iPhone and iPad, add Cloud Login to your Home Screen first (iOS 16.4 or
later) and open it from there. If you blocked notifications, allow them again
in your system or browser settings; the app shows the steps. Notifications
can be delayed. When none arrives, open Cloud Login to see pending requests.

## Choose a guide

- [Pair and manage sign-in devices](/en/docs/accounts/devices)
- [Enable app sign-in for a Cloud](/en/docs/accounts/app-sign-in)
- [Host Cloud Login and understand app protection](/en/docs/operations/cloud-login)

Cloud Login uses the public app-approval SDK and shared UI components. Each
account has its own device key. The app needs no central account server and
can be hosted at your own stable HTTPS address.
