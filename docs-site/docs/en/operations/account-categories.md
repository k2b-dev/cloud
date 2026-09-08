---
title: Configure account types and sign-in
navTitle: Account types
section: Operations
order: 1174
description: Configure Guest, local Login and FreeIPA access independently from login-page visibility.
tags: [accounts, authentication, administration, freeipa]
updated: 2026-09-08
---

# Configure account types and sign-in

Open **Administration → Settings → Accounts & sign-in** to choose which
account types are allowed and which appear on the general login page.
Individual accounts and groups remain in **Accounts**.

| Account type | Accounts included | Sign-in today |
| --- | --- | --- |
| Guest | Local guest accounts | Email code or an existing passkey |
| Login | Local full accounts | Email code or an existing passkey |
| FreeIPA | FreeIPA accounts, including internal guest/full profiles | FreeIPA credentials or an existing passkey |

Change **Login account label** to use a name such as **Company account**.
The name appears in sign-in, the account overview and account administration.
An empty label uses **Login**. Provider, profile, roles, account IDs and
resource permissions do not change.

Local accounts remain passwordless. These settings do not enable Linux login,
TOTP, QR login, an offline gateway, sudo or shared storage. See
[Linux identities](/en/docs/operations/linux-identities) for identity assignment.
Passkeys remain available until their replacement is implemented.

## Separate allowed access from visibility

- **Allowed and visible:** offer the account type on the login page.
- **Allowed but hidden:** omit it from the general page. Existing credentials,
  invitations and direct sign-in links still work.
- **Not allowed:** deny new sign-ins and subsequent Cloud requests using that
  category's sessions, user OAuth tokens, personal API keys or user-backed
  cross-application invocations. User-backed background mandates cannot issue
  new authority while the category is disabled.

Disabling does not delete accounts, data, identities or credentials, stop
FreeIPA synchronization, or cancel work already authorized and in flight.
Re-enabling restores access for credentials that are still otherwise valid.
Revoke credentials separately when access must not return on re-enabling.
Independent resource-bound service accounts are unaffected. Third-party apps
that validate an issued OAuth JWT without consulting Cloud cannot observe the
change until their own revalidation or expiry.

Manual account creation and local profile changes cannot select a disabled
target type. FreeIPA synchronization and provider-transition policies continue;
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

FreeIPA password sign-in also requires the existing FreeIPA connection to be
enabled. Category access does not replace that connection's configuration.
All categories default to allowed and visible, preserving existing account
access. Old `method=email` URLs and existing email tokens remain valid for
eligible local full accounts as well as Guests.

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

GUI and CLI use the same atomic settings save. The stored keys are
`user.category.<guest|login|freeipa>.enabled`,
`user.category.<guest|login|freeipa>.visible`, and `user.category.login.label`.
The CLI requires `--yes` because a change can remove the caller's access.
It reports a committed save without another authenticated request.
In the development checkout, use `bun run dev:cld -- admin accounts config get --json`.

## Recover administrator access

Open `/auth/login?method=admin` and use the deployment's `ADMIN_LOGIN_TOKEN`.
When local Login accounts are disabled, recovery requires explicit confirmation
to re-enable access for **all** local Login accounts. Login visibility does not
change. A valid token is required before restoration, which is audited. There
is no automatic bypass for ordinary administrator accounts.

## Display account types in an application

Use the browser-safe `accountCategory(user)` and
`accountCategoryLabel(user, loginLabel)` helpers from
`@valentinkolb/cloud/contracts`. Server-rendered applications obtain the label
from `readAccountCategoryPolicy()` in `@valentinkolb/cloud/services` and pass
only the required presentation data to the browser.

Cloud's authentication layer enforces access automatically. The server-only
`isAccountCategoryAllowed(user)` checks category eligibility for platform-owned
credential flows; it does not replace authentication, expiry checks or resource
authorization. Authorization reads the durable policy without relying on the
settings cache; invalid stored policy fails closed.
