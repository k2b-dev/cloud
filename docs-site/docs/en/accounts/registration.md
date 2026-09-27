---
title: Configure registration and account requests
navTitle: Registration & requests
section: Accounts & sign-in
order: 1082
description: Choose whether people can create Guest accounts or request FreeIPA access.
tags: [accounts, administration, authentication]
updated: 2026-09-27
---

# Configure registration and account requests

Open **Administration → Accounts & sign-in → Registration & requests**.
Creating a Guest account and requesting FreeIPA access are separate choices.

## Allow Guest self-registration

Turn on **Allow Self-Registration** only when unknown visitors may create a
local Guest through email sign-in. Guest account access must also be allowed
under **Sign-in**. Self-registration defaults to off and never creates a
local full account.

To invite selected people instead, leave self-registration off and create
their accounts in **Accounts**. Hiding Guest on the login page does not
disable allowed accounts; see [account types](/en/docs/operations/account-categories).

**Username Abbreviation Length** controls generated usernames for new accounts.
It does not rename existing accounts. Expiry and reminders are covered in
[Account lifecycle](/en/docs/accounts/lifecycle).

## Allow local accounts without email

Turn on **Allow local accounts without email** when administrators should be
able to create local full accounts without an email address, or remove the
address from one later. It is off by default. Guests, account requests and
FreeIPA accounts always need an email address.

Such an account signs in with a paired app, using its username, or with a
passkey. Before you create one, enable app sign-in and **Administrator-assisted
pairing** so you can pair its first device. You can also give the person a
one-time login token from the account's actions. See
[Accounts without email](/en/docs/accounts#accounts-without-email) for what
the person can and cannot use.

The setting only affects new accounts and email changes. Turning it off keeps
existing accounts without email working. The emergency `admin` account never
needs an email address. The stored setting is `user.local_email_optional`.

## Allow FreeIPA account requests

Under **Registration & requests**, turn on **Allow account requests** to let
existing local users request FreeIPA access from **My account → Access**.
The FreeIPA connection and FreeIPA account access must also be enabled.
This is separate from Guest self-registration and login-page visibility.

Account requests are off by default. Check the saved setting when taking over
an existing installation.

Turning it off prevents new requests. Users can still view and withdraw existing requests, and
administrators can still process them. Account creation from a request requires
the usual FreeIPA availability and permissions.

## Use the CLI

Read the current request and notice configuration before editing it:

```bash
cld admin accounts administration get --json
cld admin accounts administration set --config-file ./account-administration.json --yes
```

The file contains both values; preserve any existing notice you still need:

```json
{
  "requestsEnabled": false,
  "actionNotice": ""
}
```

The settings are `user.account_requests.enabled` and `user.action_notice`. See
[Follow-up notices](/en/docs/accounts/change-notices) for template examples.
This command does not change Guest self-registration.
