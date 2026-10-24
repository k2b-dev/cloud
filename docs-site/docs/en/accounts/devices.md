---
title: Pair and manage sign-in devices
navTitle: Devices
section: Accounts & sign-in
order: 1085
description: Pair a sign-in app with QR or a copy link, and remove a lost sign-in device or app device yourself or as an administrator.
tags: [accounts, administration, authentication]
updated: 2026-10-23
---

# Pair and manage sign-in devices

Cloud lists two kinds of paired devices separately:

- **Sign-in devices** approve sign-ins for an account through an
  authenticator such as Cloud Login. Most of this page covers them.
- **App devices** are devices paired with the Cloud app (preview). Each one
  holds its own app session. You pair and remove your own devices under **App**
  in your profile menu (`/me/app`); for administrators, see
  [Pair the Cloud app for someone](#pair-the-cloud-app-for-someone) and
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
On Android, install Cloud Login from Chrome; see
[Install on Android](/en/apps/cloud-login#install-on-android).

1. Open **My account → Security → Pair a device**. The pairing dialog starts
   immediately. If asked, confirm your identity; pairing reopens after sign-in.
2. Scan the QR with the authenticator or copy the pairing link into it.
   Each method transfers the Cloud address and
   pairing link; no camera is required.
3. In Cloud Login, set up or unlock the app's PIN or passkey protection.
   Check the Cloud address before connecting.
4. Compare the six-digit codes in Cloud and the authenticator.
   Confirm only if they match.
5. If this account already has an active paired device on this Cloud, open
   Cloud Login on it and approve the pairing. The request expires after five
   minutes; denial or expiry leaves the new device unpaired. The first device
   pairs as soon as the codes are confirmed.
6. Keep both pages open until pairing completes. The device then appears under
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
   scans it with their device and installs the app from the page that opens.
2. Choose **Next**, or **App is already installed** if the app is already on
   the device. The pairing starts only then, so installing does not use up the
   five-minute pairing link.
3. Check the named target account, pair as described above and compare the
   codes together. If you have to confirm your identity first, the dialog
   reopens at this step.

This issues a sign-in credential for that person, not for the administrator.
Assisted pairing completes after code confirmation, including when the account
already has a paired device. The action is audited. The user is notified by email when their account has an
email address.

## Review or remove a device

Under **My account → Security**, rename devices so you recognize them.
Request removal of a lost or unwanted device there, then approve the request
in Cloud Login on an active paired device. The device being removed can also
approve its own removal, but only another paired device can deny it. Until
approval, it stays active; denial or expiry leaves it unchanged. The request
ends when the browser session that asked for it signs out.

You can also end the browser sign-ins that device approved; this is selected
by default. The requesting session stays signed in, as do sign-ins approved by
other devices and sessions with no device link. Sessions issued before this
update have no device link. Once revoked, the device cannot approve new
sign-ins.

Removing a Cloud locally from the authenticator and revoking its Cloud
credential are different actions. For a lost device, use Cloud's device list.
If browser data is lost or no configured unlock method works, sign in through
another allowed Cloud method. If no paired device is usable, ask an
administrator to revoke the old device and help pair a replacement through
administrator-assisted pairing when enabled. Ask an administrator as well when
a device you do not recognize denies your removal requests. These
administrator actions do not need approval on a paired device.

Cloud also revokes all your paired devices when it signs your account out
everywhere, for example after you reset your FreeIPA password with
**Reset password** on the sign-in page or an administrator changes your
account's provider.
Pair again after signing in.

## Revoke a device for someone

When someone loses a device and cannot sign in, an administrator opens
**Accounts → Users → the user**. **Cloud Login** lists each active device
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

## Pair a device with the Cloud app

> **Preview:** the Cloud app is not released yet.

Open **App** in your profile menu (`/me/app`). The page lists your paired
devices with their platform and last use, and marks the device you are using.

1. Choose **Pair a device**. A dialog opens with a QR code and shows how long
   the code still works: five minutes. **Copy link** copies the same link, for
   example when you pair the device you are reading this on.
2. In the app, tap **Scan code**, or copy the link and tap **Paste link**.
   Without the app, scanning the code with the device's camera opens the page
   that shows how to install it; on the device itself, choose **Install the
   app**. On Android, install it from Chrome. In Samsung Internet, the page
   offers **Open in Chrome** instead, because Android may block an app
   installed from there as built for an older Android version.
3. As soon as the app scans the code or receives the pasted link, the dialog
   moves to code entry on its own. The app shows a six-digit code. Enter it in
   the dialog and choose **Pair**. The third wrong code ends the pairing; start
   again for a new one.
4. The app finishes on its own, and the device appears in the list.

The QR code and the link only start the pairing. A photographed code or a
forwarded link pairs nothing by itself: only the browser that opened the
dialog can confirm the six-digit code, and the link works once. Closing the
dialog before you confirm the code cancels the pairing, so its link stops
working. Pairing needs a sign-in from the last ten minutes; if asked, choose
**Confirm it's you**, and the dialog opens again after sign-in.
To remove a device, choose **Remove** in its row. The app on that device is
signed out at once.

When a device is paired, Cloud sends you a **New device paired** notice with
the device's name, platform and pairing time, and a link to this page. If you
did not pair that device, remove it there and contact your administrator. The
notice goes by email, or as a browser notification when your account has no
email address; choose how it reaches you under **My account → Notifications**
(**Devices paired with the Cloud app**).
You get it once per pairing, also for a device that was removed right away, but
not when the app later renews its sign-in. The notice never contains the
pairing link or code. While do not disturb or your quiet hours are on, a
notice that would go as a browser notification is held back; it then appears
only in your notification history.

## Pair the Cloud app for someone

The **Cloud app** is Cloud installed on a phone or tablet for tasks and chat.
**Cloud Login** is the separate sign-in app; it confirms sign-ins and has no
access to tasks or chat. User details show these in separate sections.

An administrator can prepare the Cloud app for another person, for example on
a shared iPad. Open **Accounts → Users → the person → Cloud app → Pair Cloud
app**. This requires an administrator web sign-in from the last ten minutes.
An app session or API key cannot start it. For a blocked or expired account,
unblock or extend the account first; the disabled action explains why.

1. Check the name in **Pair Cloud app for …**. The device will sign in as that
   person. Open the Cloud app on the device and scan the QR code, or choose
   **Copy link** in the dialog and paste it into the app. The dialog shows the
   remaining validity; the link can be claimed once within five minutes.
2. Enter the six-digit code shown on the device into the administrator dialog.
   A wrong code shows the remaining attempts. The third wrong code ends the
   pairing. The whole pairing expires after ten minutes.
3. On the device, check **Sign in as …?** and **Set up by … (Administration)**.
   Choose **Confirm** only if this is the intended device. The administrator
   dialog waits for this decision and shows the same question under **What the
   device shows**, so you can tell the person what to tap; only the person can
   answer it. **Reject** ends the pairing and grants no access.
4. Keep both screens open until the administrator dialog shows **Paired:** and
   the device name. The device appears in the person's list. The person receives
   the usual paired-device notice, including who set it up, through their
   configured notification channels.

**Cancel**, or closing the administrator dialog, ends an unfinished pairing. After a reload,
the same tab resumes its pairing; if the device has not received the link,
close the dialog and start again. Signing out the initiating administrator,
ending their session, or removing their administrator role prevents completion.
The same per-account limits apply to self-pairing and administrative pairing:
five open pairings and twenty active devices. Your own pairing under **App**
in the profile menu continues to finish after the web code confirmation.

Cloud records administrative start, code confirmation, device acceptance or
rejection, and successful enrollment with both accounts in the audit log. The
administrator can remove the paired device from the person's **Cloud app** list
at any time.

## Remove an app device for someone

> **Preview:** the Cloud app is not released yet.

When someone loses a device that is paired with the Cloud app, an
administrator opens **Accounts → Users → the user**. **Cloud app** lists each
paired device with its name, platform, when it was paired and when it was last
used. An empty section offers **Pair Cloud app**; a failed load shows an error.

1. Find the device by name and last use.
2. Choose the remove button in its row, then **Remove device** to confirm.

Removing a device ends its app sessions at once. At its next request, the app
on that device shows that it was signed out, and nobody can use it for that
account until it is paired again. Web sessions and sign-in devices stay as they
are. Cloud records the removal in the audit log; the person is not notified.

From the terminal, administrators use
`cld accounts users app-devices list <user>` and
`cld accounts users app-devices remove <user> <device-id> --yes`. Both accept
`--json`; repeating a removal answers `revoked: false`.

An administrator cannot do this from the Cloud app: app sessions never carry
the administrator role. For the HTTP routes, see
[Account administration API](/en/docs/reference/account-administration#remove-devices-from-the-cloud-app).
