---
title: Accounts and sign-in
navTitle: Overview
section: Accounts & sign-in
order: 1080
description: Choose account types, configure sign-in and manage account lifecycle.
tags: [accounts, administration, authentication]
updated: 2026-09-27
---

# Accounts and sign-in

An account determines who someone is and what they can access. A sign-in method
determines how they prove it is their account: an email link, FreeIPA credentials,
a passkey or approval in a paired app. An email link can be requested with the
account's email address or its username; it is always sent to the stored email
address. The login page shows the same confirmation whether or not the account
exists or has an email address. If no message arrives, contact an administrator.
The password reset for FreeIPA accounts answers the same way.

Configure installation-wide policy in **Administration → Accounts & sign-in**.
Create and manage individual users, groups and requests in **Accounts**.
People manage their own devices in **My account → Security**.

Use the avatar menu to open **Profile settings** or **Sign out**. Signing out
ends the current browser session.

Choose **Deutsch** or **English** beside the legal links on sign-in and
recovery pages. The choice also applies after sign-in and is saved in this browser.

## Before your first use

After signing in, review and accept this Cloud's terms and acknowledge its
privacy policy. This is required once, regardless of whether you sign in with
an email link, FreeIPA, a passkey or a paired app. Until you confirm, you cannot
open applications or use the new session for API access. You can cancel and
sign out instead. Later sign-ins continue directly to your destination.

Operators configure the documents under **Administration → Legal**. Configure
them before inviting users. Existing sessions remain valid after an upgrade;
accounts without a recorded acceptance are asked at their next sign-in.

## Start with your scenario

- **Cloud-managed accounts only:** allow Login, give it your company label, and
  disable Guest and FreeIPA in [Account types](/en/docs/operations/account-categories).
- **Invited guests:** allow Guest, leave self-registration off, and optionally
  hide Guest from the general login page.
- **Existing FreeIPA directory:** [connect FreeIPA](/en/docs/operations/freeipa),
  review group scope and keep its account category allowed.
- **Use an authenticator app:** [configure app sign-in](/en/docs/accounts/app-sign-in),
  then pair a device. This works for eligible local and FreeIPA accounts.

## Choose a task

| Task | Guide |
| --- | --- |
| Choose allowed accounts and visible login entries | [Account types and sign-in](/en/docs/operations/account-categories) |
| Allow registration or FreeIPA requests | [Registration & requests](/en/docs/accounts/registration) |
| Connect a directory and control synchronization | [FreeIPA](/en/docs/operations/freeipa) |
| Configure the authenticator website | [App sign-in](/en/docs/accounts/app-sign-in) |
| Pair, rename or revoke a device | [Devices](/en/docs/accounts/devices) |
| Assign UID/GID, home and shell | [Linux identities](/en/docs/operations/linux-identities) |
| Configure expiry, reminders or run maintenance | [Account lifecycle](/en/docs/accounts/lifecycle) |
| Show manual follow-up instructions | [Notices after changes](/en/docs/accounts/change-notices) |
| Point help links at your own documentation | [Documentation website](/en/docs/accounts/documentation) |

Linux identities add UID/GID, home and shell attributes to accounts. Assigning
them does not enable computer login, sudo or shared storage.

## Accounts without email

When [allowed](/en/docs/accounts/registration#allow-local-accounts-without-email),
a local full account can exist without an email address. The person signs in with:

- a paired app, entering the account's username;
- a passkey added after a first sign-in;
- a one-time login token that an administrator creates in **Accounts**. It
  works once and expires after five minutes.

An administrator pairs the first device from the account's page with
**Pair sign-in app**; this requires administrator-assisted pairing. The person
cannot request email sign-in links and receives no welcome email, expiry
reminder, email notification or device-pairing email. Pairings remain in the
audit log. Only the person can revoke a paired device, under
**My account → Security**.

Connected apps get no `email` claim for these accounts; see
[OAuth](/en/docs/identity/oauth). [Proxy Auth](/en/apps/proxy-auth) sends an
empty `X-Forwarded-Email` header. Services that identify people by email need
another identifier, such as the OAuth `sub` or the `X-Forwarded-User` username.

Application authors should use [Identity and access](/en/docs/identity).
Authenticator authors should use the [App approval API](/en/docs/operations/app-approval).
