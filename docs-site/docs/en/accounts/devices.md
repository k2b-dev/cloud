---
title: Pair and manage sign-in devices
navTitle: Devices
section: Accounts & sign-in
order: 1085
description: Pair a sign-in app with QR or a copy link, and remove a lost sign-in device or app device yourself or as an administrator.
tags: [accounts, administration, authentication]
updated: 2026-10-04
---

# Pair and manage sign-in devices

Cloud lists two kinds of paired phones separately:

- **Sign-in devices** approve sign-ins for an account through an
  authenticator such as Cloud Login. Most of this page covers them.
- **App devices** are phones paired with the mobile app (preview). Each one
  holds its own app session. You pair and remove your own phones under **App**
  in your profile menu (`/me/app`); for administrators, see
  [Remove an app device for someone](#remove-an-app-device-for-someone).

Removing one kind never affects the other.

Pair your authenticator with a Cloud account to approve sign-ins for that account.
Sign in to Cloud using a working login method before pairing. If **Pair a device**
is unavailable, ask your administrator whether app sign-in is enabled for your
installation.

[Cloud Login](/en/apps/cloud-login) can manage accounts from several Clouds in
one app. Use the authenticator address configured by your administrator.

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

1. The dialog first shows a QR code for the configured sign-in app. The person
   scans it with their phone and installs the app from the page that opens.
2. Choose **Next**, or **App is already installed** if the app is already on
   the phone. The pairing starts only then, so installing does not use up the
   five-minute pairing link.
3. Check the named target account, pair as described above and compare the
   codes together. If you have to confirm your identity first, the dialog
   reopens at this step.

This issues a sign-in credential for that person, not for the administrator.
The action is audited. The user is notified by email when their account has an
email address.

## Review or remove a device

Under **My account → Security**, rename devices so you recognize them.
Revoke a lost or unwanted device there. Revocation stops that credential from
approving new sign-ins; it does not sign out Cloud sessions already created.
Revoked devices disappear from the device list.

Removing a Cloud locally from the authenticator and revoking its Cloud
credential are different actions. For a lost device, use Cloud's device list.
If browser data is lost or no configured unlock method works, sign in through
another allowed Cloud method, revoke the old credential and pair again.
If you cannot sign in at all, ask an administrator to revoke the device.

Cloud also revokes all your paired devices when it signs your account out
everywhere, for example after you reset your FreeIPA password with
**Reset password** on the sign-in page or an administrator changes your
account's provider.
Pair again after signing in.

## Revoke a device for someone

When someone loses a device and cannot sign in, an administrator opens
**Accounts → Users → the user**. **Sign-in devices** lists each active device
with its name, when it was paired and when it was last used.

1. Find the lost device by name and last use.
2. Choose the revoke button in its row, then **Revoke device** to confirm.

The device can no longer approve sign-ins for that account, including a
request it already approved but that has not finished. Sessions it already
approved stay signed in until they expire; Accounts has no action that ends
another account's web sessions. Cloud records the revocation in the audit log and
notifies the person if it can reach them by email or browser notification.
To set up a replacement, use [Help someone pair a device](#help-someone-pair-a-device).

From the terminal, administrators use
`cld accounts users devices list <user>` and
`cld accounts users devices revoke <user> <device-id> --yes`.

See [Cloud Login](/en/docs/operations/cloud-login#protect-the-app) for app-lock
recovery. A synced passkey is not a backup of the authenticator's local vault.

## Pair a phone with the mobile app

> **Preview:** the mobile app is not released yet.

Open **App** in your profile menu (`/me/app`). The page lists your paired
phones with their platform and last use, and marks the phone you are using.

1. Choose **Pair a phone**. A dialog opens with a QR code and a link that
   works for five minutes. On a phone, the dialog offers **Copy link** instead
   of the QR code.
2. In the app, tap **Scan code**, or copy the link and tap **Paste link**.
   Without the app, scanning the code with the phone's camera opens the page
   that shows how to install it; on the phone itself, choose **Install the
   app**.
3. The app shows a six-digit code. Enter it in the dialog and choose **Pair**.
   The third wrong code ends the pairing; start again for a new one.
4. The app finishes on its own, and the phone appears in the list.

Closing the dialog before you confirm the code cancels the pairing, so its
link stops working. Pairing needs a sign-in from the last ten minutes; if
asked, choose **Confirm it's you**, and the dialog opens again after sign-in.
To remove a phone, choose **Remove** in its row. The app on that phone is
signed out at once.

## Remove an app device for someone

> **Preview:** the mobile app is not released yet. Until it is, no account has
> app devices and the section below does not appear.

When someone loses a phone that is paired with the mobile app, an
administrator opens **Accounts → Users → the user**. **App devices** lists each
paired phone with its name, platform, when it was paired and when it was last
used. The section appears only while the account has at least one paired phone,
or with an error when the phones could not be loaded.

1. Find the phone by name and last use.
2. Choose the remove button in its row, then **Remove phone** to confirm.

Removing a phone ends its app sessions at once. At its next request, the app
on that phone shows that it was signed out, and nobody can use it for that
account until it is paired again. Web sessions and sign-in devices stay as they
are. Cloud records the removal in the audit log; the person is not notified.

An administrator cannot do this from the mobile app: app sessions never carry
the administrator role. There is no `cld` command for app devices yet. For the
HTTP routes, see [Account administration API](/en/docs/reference/account-administration#remove-phones-from-the-mobile-app).
