---
title: Pair and manage sign-in devices
navTitle: Devices
section: Accounts & sign-in
order: 1085
description: Pair a sign-in app with QR or a copy link, and remove a lost device.
tags: [accounts, administration, authentication]
updated: 2026-09-09
---

# Pair and manage sign-in devices

Pair your authenticator with a Cloud account to approve sign-ins for that account.
Sign in to Cloud using a working login method before pairing. If **Pair a device**
is unavailable, ask your administrator whether app sign-in is enabled for your
installation.

## Pair a device

Choose **Install app** under **My account → Security** to open
the configured authenticator on a phone. On a desktop, this shows a QR code and
a button to copy the app address. Installing the app does not pair an account.

1. Open **My account → Security → Pair a device**. The pairing dialog starts
   immediately. If asked, confirm your identity; pairing reopens after sign-in.
2. Scan the QR with the authenticator or copy the pairing link into it.
   Each method transfers the Cloud address and
   pairing link; no camera is required.
3. In Cloud Login, set up or unlock the app's PIN or passkey protection.
   Check the Cloud address before connecting.
4. Compare the six-digit codes in Cloud and the authenticator.
   Confirm only if they match.
5. Keep both pages open until pairing completes. The device then appears under
   **My account → Security**.

The pairing link is a temporary secret. Do not put it in tickets, screenshots
or messages to other people. It expires after five minutes.
After a reload, an already claimed pairing can resume; if the authenticator
has not received it, close the dialog and start a new pairing.

Pairing, renaming and revoking require a Cloud session created within the last
ten minutes. If prompted, choose **Confirm identity** and sign in with the same
account. You do not need to sign out first.

## Help someone pair a device

When administrator-assisted pairing is enabled, an authorized administrator
opens **Accounts → Users → the user → Pair sign-in app**.
Check the named target account and compare the codes together.
This issues a sign-in credential for that person, not for the administrator.
The action is audited and the user is notified.

## Review or remove a device

Under **My account → Security**, rename devices so you recognize them.
Revoke a lost or unwanted device there. Revocation stops that credential from
approving new sign-ins; it does not sign out Cloud sessions already created.
Revoked devices disappear from the device list.

Removing a Cloud locally from the authenticator and revoking its Cloud
credential are different actions. For a lost device, use Cloud's device list.
If browser data is lost or no configured unlock method works, sign in through
another allowed Cloud method, revoke the old credential and pair again.

See [Cloud Login](/en/docs/operations/cloud-login#protect-the-app) for app-lock
recovery. A synced passkey is not a backup of the authenticator's local vault.
