---
title: Cloud Login
navTitle: Cloud Login
section: Companion apps
order: 500
description: Approve sign-ins and Actions for multiple Clouds from one installable app.
tags: [authentication, pwa, devices]
updated: 2026-10-19
---

# Cloud Login

Cloud Login is an installable web app for approving sign-ins to your Cloud
accounts and Actions that wait for your approval, such as an email the
Assistant wants to send. Connect accounts from different Clouds and manage
them in one place.
It runs separately from the Cloud installations you connect.

[Open Cloud Login](https://cloud-login.pwa.k2b.dev)

## Start using it

Your Cloud administrator must first [enable app sign-in](/en/docs/accounts/app-sign-in)
and choose the authenticator address. Use the app configured by your Cloud.

1. Open Cloud Login, on Android in Chrome, and choose **Install app** from its menu, or continue in your browser.
2. Choose **Add Cloud**.
3. On your Cloud profile, open **Sign-in → Paired devices → Pair a device**. Scan
   the QR code or paste its link into Cloud Login, then compare and confirm the codes.
4. When you start a sign-in, open Cloud Login or tap its notification. Compare
   the code shown in the request with the sign-in page, then approve or deny it.

A browser sign-in can show the browser and system, approximate place, network
operator, start time in your phone's time zone, and whether the browser signed
in to this account before. Place and network rows appear only when your
Cloud's location database knows the address. **Same internet address as this
phone** appears only when true. During the first 14 days after the Cloud
update, no known/new browser claim appears. Older Clouds, or requests without
these details, show the earlier dialog with the start time.

**Did you start this sign-in?** warns about a new browser in a country without
a sign-in in Cloud's recent history, when your account already has sign-in
countries. **Deny** is then the main button, with **Approve anyway** available.
Known means “signed in here before”, not “safe”. Only passkeys are
phishing-resistant; a phishing page can relay an app comparison code. See
[Read the request details](/en/docs/accounts/app-sign-in#read-the-request-details).

A terminal sign-in shows **Terminal sign-in** with the client name in the
title, the Cloud host, the comparison code, how long the terminal stays signed
in, and its permissions in plain words. Only approve a sign-in you started
yourself with `cld login --user <name>`, where `<name>` is your username or
email, and only when the code matches the one in your terminal. Otherwise,
choose **Deny**.

Approving signs the terminal in with exactly these permissions for the time
shown. To grant fewer permissions, start the sign-in again with fewer scopes,
using `cld login --scope ...`.

Waiting Actions appear on the Cloud card with the app, what it wants to do and
the chat it came from. Choose **Review**, read the request, then choose
**Approve** or **Deny**. Cloud Login decides only this one request. If more are
waiting than the card lists, review them in Cloud under **My account →
Approvals**.

Once your account has a paired device, pairing another device or removing one
waits for approval in Cloud Login. The request shows **Pair a device** or
**Remove a device** with the device name. Approve only a change you started
yourself; otherwise choose **Deny**. The device being removed can approve its
own removal, but only another paired device can deny it.

Pair each account separately. You can add another Cloud, edit account labels,
or disconnect an account through **Manage accounts**.

Forgot which account you paired? Tap the info button on a Cloud card. It shows
your username for that Cloud, your name and email, the device name, when you
paired it and when you last approved a sign-in. Copy the username from there
to sign in. Without a connection, the app shows the details it saved last time.

## Install on Android

Install Cloud Login from Chrome. If the page opens in Samsung Internet, Cloud
Login offers **Open in Chrome** instead of its own install button.

On Samsung phones with Android 14 or later, Android may block an app
installed from Samsung Internet. The dialog may appear under a title such as
“Blocked dangerous app” or “Unsafe app blocked”. In this case, its details
say: “This app was built for an older version of Android and doesn't include
the latest privacy protections”. In German: “Diese App wurde für eine ältere
Android-Version entwickelt und bietet keinen aktuellen Datenschutz”.

That reason is about the app package that Samsung Internet builds for the
web app, not about Cloud Login: Android flags packages built for an older
Android version. Chrome installs the same app without it, so cancel and
install from Chrome. Without Chrome, install from Samsung Internet's menu.
You can then continue through the warning's details, but only if they give
exactly this reason and you opened Cloud Login from the address your Cloud
gave you. Do not bypass a Play Protect block that gives any other reason.

Already installed it from Samsung Internet? Each browser keeps its own
Cloud Login data, so the Chrome copy starts empty. Install Cloud Login from
Chrome and pair each Cloud there. Then disconnect each Cloud in the old copy
through **Manage accounts**, which also revokes that device, and uninstall
it. If the old copy is already gone, remove its device under
**Sign-in → Paired devices** on your profile in that Cloud and approve the
removal in the Chrome copy.

## Protect and recover

Cloud Login has no app PIN: anyone who can open the app on your unlocked
device can approve requests, so protect the device itself with a screen lock.
If you set a PIN in an earlier version, enter it one last time under
**Remove app PIN** to keep your connected Clouds.

Keep another sign-in method available. If you lose your device or reset the
app, sign in to each Cloud another way and remove the old device. Approve the
removal on another paired device; without one, ask an administrator to remove
it. Then pair again.

The app can start offline after its first online visit. Pairing and approvals
need a connection.

## Get notified

Choose **Turn on** on the **Turn on notifications** card, or open
**Notifications** in the menu. You then get a notification such as
“Sign-in request for cloud.example.org” when you start a sign-in, or
“Approval requested on cloud.example.org” when an Action waits for you. It
contains only the Cloud address, never codes, request details or account
details. Tap it to open the request. **Send test notification** checks that notifications arrive.

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
