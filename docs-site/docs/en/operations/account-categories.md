---
title: Configure account types and sign-in
navTitle: Account types
section: Accounts & sign-in
order: 1081
description: Configure Guest, local Login and FreeIPA access independently from login-page visibility.
tags: [accounts, authentication, administration, freeipa]
updated: 2026-09-09
---

# Configure account types and sign-in

Open **Administration → Accounts & sign-in → Sign-in** to choose which
account types are allowed and which appear on the general login page.
Individual accounts and groups remain in **Accounts**.

See [Accounts & sign-in](/en/docs/accounts) for registration, FreeIPA, app
sign-in, Linux identities and maintenance.

| Account type | Accounts included | Sign-in methods |
| --- | --- | --- |
| Guest | Local guest accounts | Email link, passkey, or paired app |
| Login | Local full accounts | Email link, passkey, or paired app |
| FreeIPA | Directory-managed accounts | FreeIPA credentials, passkey, or paired app |

Change **Login account label** to use a name such as **Company account**.
The name appears in sign-in, the account overview and account administration.
An empty label uses **Login**. Renaming the entry does not change account access
or permissions.

Local accounts remain passwordless. App sign-in requires
[separate setup and device pairing](/en/docs/accounts/app-sign-in).
Passkeys and apps must be paired with the account before they can be used.

## Separate allowed access from visibility

- **Allowed and visible:** offer the account type on the login page.
- **Allowed but hidden:** omit it from the general page. Existing credentials,
  invitations and direct sign-in links still work.
- **Not allowed:** block sign-ins and further use of Cloud through that account
  type, including existing sessions, personal API keys and user OAuth access.

Disabling does not delete accounts, data, identities or credentials, stop
FreeIPA synchronization, or cancel work already authorized and in flight.
Re-enabling restores access for credentials that are still otherwise valid.
Revoke credentials separately when access must not return on re-enabling.
Independent resource-bound service accounts are unaffected. Third-party apps
that validate an issued OAuth JWT without consulting Cloud cannot observe the
change until their own revalidation or expiry.

You cannot create an account or change a local account to a disabled type.
FreeIPA synchronization and provider-transition policies continue;
any resulting account is subject to its new category's access rule.

Guest self-registration remains separate. Allowing Guests does not enable
registration. Login never creates a full account from an unknown email. The
signup control is hidden while Guest accounts are disabled.

Before disabling your own category, keep another allowed administrator or the
deployment's emergency admin token available. Your next request can be denied,
including the settings-page reload after saving.

## Configure common scenarios

For a company-only entry, allow and show **Login**, set its label to
**Company account**, and disable **Guest** and **FreeIPA**. With one visible
type, Cloud opens its form without a selector.

To allow invited guests without advertising their entry, allow **Guest** but
turn off **Show Guest in login**. Give them an invitation or a direct link to
`/auth/login?method=guest`.

Direct local full-account entry is `/auth/login?method=login`; FreeIPA entry
is `/auth/login?method=ipa`. Hidden categories work through these links only
while allowed. Disabled links show an unavailable state. With no visible type,
the general page offers support and emergency recovery, not a hidden default.
Remembered choices never reveal a currently hidden type.

FreeIPA password sign-in also requires the FreeIPA connection to be
enabled. Category access does not replace that connection's configuration.
All categories default to allowed and visible.

## Configure from the terminal

Use an administrator credential:

```bash
cld admin accounts config get --json
cld admin accounts config set --config-file ./account-types.json --yes
```

The JSON file contains the complete policy:

```json
{
  "guest": { "enabled": false, "visible": false },
  "login": { "enabled": true, "visible": true, "label": "Company account" },
  "freeipa": { "enabled": false, "visible": false }
}
```

The stored keys are
`user.category.<guest|login|freeipa>.enabled`,
`user.category.<guest|login|freeipa>.visible`, and `user.category.login.label`.
The CLI requires `--yes` because a change can remove the caller's access.

## Allow FreeIPA account requests

See [Registration and requests](/en/docs/accounts/registration).

## Show optional follow-up instructions

See [Notices after account changes](/en/docs/accounts/change-notices).

### Configure requests and notices from the terminal

Both options use `cld admin accounts administration get/set`.
See [the complete configuration](/en/docs/accounts/registration#use-the-cli).

## Recover administrator access

Open `/auth/login?method=admin` and use the deployment's `ADMIN_LOGIN_TOKEN`.
When local Login accounts are disabled, recovery requires explicit confirmation
to re-enable access for **all** local Login accounts. Login visibility does not
change. A valid token is required before restoration, which is audited. There
is no automatic bypass for ordinary administrator accounts.

## Display account types in an application

See the [Account administration API](/en/docs/reference/account-administration#display-account-types-in-an-application).
