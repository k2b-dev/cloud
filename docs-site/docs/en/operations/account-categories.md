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

Open **Administration → Accounts & sign-in → Sign-in** to choose which
account types are allowed and which appear on the general login page.
Individual accounts and groups remain in **Accounts**.

The other pages in this group have separate responsibilities:

- **Registration & requests:** Guest self-registration, FreeIPA access requests,
  account defaults, expiry, reminders and optional follow-up notices.
- **Linux identities:** Local UID/GID assignment, home and shell defaults, and
  backfill for existing accounts. This does not enable computer login.
- **Operations:** Open filtered account-lifecycle logs, FreeIPA sync logs and
  scheduled jobs. Explicit maintenance actions repair account expiry dates;
  they do not assign Linux identities. They can extend expired accounts and
  restore access. A toast confirms that a job was queued, not completed;
  use its permanent log link to check the result. These actions no longer live
  on the Accounts dashboard.
- **FreeIPA:** Connection, synchronization and group mapping.

Existing Sign-in, FreeIPA and Linux settings URLs remain valid. Settings keys,
permission checks, job execution and lifecycle history are unchanged.

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

## Allow FreeIPA account requests

Under **Registration & requests**, turn on **Allow account requests** to let
existing local users request FreeIPA access from **My account → Access**.
The FreeIPA connection and FreeIPA account access must also be enabled.
This is separate from Guest self-registration and login-page visibility.

New installations default to off. A one-time upgrade migration preserves the
previously enabled request feature on existing installations without replacing
an explicit setting. After that migration, resetting the setting returns to
the off default; restarting does not enable it again.

Turning it off hides the new-request form and rejects new submissions at the
service boundary. Users can still view and withdraw existing requests, and
administrators can still process them. Account creation from a request requires
the usual FreeIPA availability and permissions.

## Show optional follow-up instructions

Edit **Notice after account or group changes** under **Registration & requests**.
The Liquid-Markdown template is empty by default. An empty template or empty
result adds no notice. The editor offers sample data and a rendered preview;
unknown variables and invalid Liquid are rejected on save through both GUI and CLI.

Use `action` to show instructions only when they are relevant:

```liquid
{% if action == "user.create" and category == "freeipa" %}
Confirm workstation setup with {{ uid }} before handing over access.
{% elsif action == "group.delete" %}
Review shared-folder permissions for {{ name }}.
{% endif %}
```

Notices appear after successful changes in Accounts. They are for the person
performing the action, not an email or notification to the affected user.
Administrators can receive user and group notices; group managers receive group
notices. A notice failure does not undo the change or report the change itself
as failed. There is no automatic command execution or storage provisioning.

Supported actions are:

| Area | `action` values |
| --- | --- |
| Users | `user.create`, `user.update`, `user.delete`, `user.profile`, `user.admin`, `user.provider`, `user.expiry`, `user.password_reset`, `user.login_token`, `user.linux` |
| Groups | `group.create`, `group.update`, `group.delete`, `group.posix` |
| Membership and management | `group.member.add`, `group.member.remove`, `group.manager.add`, `group.manager.remove` |

The bounded context contains only `action`, `id`, `uid`, `name`, `email`,
`firstName`, `lastName`, `provider`, `profile`, `category` and `relatedId`.
User actions provide person and category fields; group actions provide the name
and provider. Existing records supply their current display data; deleted records
use the action's snapshot. Fields that do not apply are empty strings.
`id` identifies the changed account or group; membership actions put
the added or removed principal's ID in `relatedId`. Provider values are `local`
and `ipa`; profiles are `guest` and `user`; categories are `guest`, `login` and
`freeipa`. Interpolated values are escaped as Markdown text, including when the
template uses Liquid's `raw` filter. Do not treat the
notice as an audit record or a shell-command generator. Passwords, tokens and
other credentials are never included in this context.

Avatar changes, notification sending, background jobs and changes made outside
the Accounts UI do not open follow-up dialogs. The old built-in NFS instructions
have been removed. If an installation needs them, configure its template before
deploying this change; they are no longer a global default.

### Configure requests and notices from the terminal

```bash
cld admin accounts administration get --json
cld admin accounts administration set --config-file ./account-administration.json --yes
```

The file contains both options:

```json
{
  "requestsEnabled": false,
  "actionNotice": ""
}
```

This uses the same atomic settings API as Administration and writes
`user.account_requests.enabled` and `user.action_notice`. Account-category policy
remains under `cld admin accounts config`; Linux defaults remain under
`cld admin linux config`.

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
