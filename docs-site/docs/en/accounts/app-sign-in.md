---
title: Set up app sign-in
navTitle: App sign-in
section: Accounts & sign-in
order: 1084
description: Connect Cloud to its trusted authenticator website and prepare a first sign-in.
tags: [accounts, administration, authentication]
updated: 2026-09-09
---

# Set up app sign-in

App sign-in lets people approve a Cloud login in a paired authenticator instead
of entering a password or opening an email link. An administrator chooses the
trusted authenticator website; people [pair their devices](/en/docs/accounts/devices).
Local and FreeIPA accounts can use it when their
[account category](/en/docs/operations/account-categories) is allowed.

## Before you start

You need administrator access and the HTTPS address of the authenticator your
organization uses, for example `https://auth.example.org`. It must be reachable
from users' browsers and devices. If you host it yourself, follow
[Run Cloud Login](/en/docs/operations/cloud-login).

Check that **General → URL** contains the public address of your Cloud.
Keep another working sign-in method available for lost-device recovery.
App sign-in is a Cloud login method, not Linux authentication or automatically
an additional authentication factor.

For FreeIPA accounts, app sign-in checks Cloud's synchronized account state,
not the live directory. Keep synchronization healthy. Do not rely on this
method if directory-side changes must block access immediately.

## Configure the website

1. Open **Administration → Accounts & sign-in → Sign-in**.
2. Turn on **Enable app sign-in**.
3. Enter the authenticator origin: its scheme, host and optional port,
   for example `https://auth.example.org`. Do not include a path, wildcard,
   query or fragment. Use only a website your operator trusts.
4. Leave **Administrator-assisted pairing** off unless administrators should
   be able to issue a device credential for another person.
5. Save. The status should read **Enabled — Cloud configured**.

**Enabled — setup required** means the address is missing or invalid.
A configured status does not check whether the PWA is running or whether a
device can complete sign-in. Enabling it does not remove other sign-in methods.

Administrators can also find setup from **My account → Security** while the
feature is disabled. Other users see it when enabled or when they have device
history. Existing device inspection and revocation remain available if the
PWA address is missing; the Cloud's own address must still be valid.

The Cloud address under **General → URL** identifies this Cloud.
Changing that origin requires pairing again. Changing the trusted PWA origin
does not revoke existing devices: review and revoke credentials separately
when replacing an untrusted authenticator.

## Sign in with the app

1. [Pair a device](/en/docs/accounts/devices#pair-a-device) with your account.
2. On Cloud's login page, choose your account type if a selector is shown,
   choose app sign-in, and enter your username or email.
3. Keep the login page open and open your authenticator.
4. Unlock the app, compare the request with the waiting login page, and approve
   only if the codes match and you started the request.

The waiting page signs you in after approval. Deny requests you do not recognize.
If a request expires, start a new sign-in from Cloud.

Before offering app sign-in to your users, check pairing, approval, denial and
lost-device recovery on the browsers and devices your organization supports.

## Configure from the CLI

Use a CLI profile connected to the Cloud you want to configure, with an
administrator credential:

```bash
cld admin app-sign-in config get --json
cld admin app-sign-in config set --config-file ./app-sign-in.json --yes
```

The file contains all three values:

```json
{
  "enabled": true,
  "origin": "https://auth.example.org",
  "adminPairing": false
}
```

The settings are `user.app_approval.enabled`, `user.app_approval.origin`
and `user.app_approval.admin_pairing`. GUI and CLI use the same save operation.
An empty origin is allowed during setup but cannot authorize pairing or login.

## Maintain the integration

Use stable Cloud and authenticator addresses. Treat authenticator hosting and
updates as part of your sign-in security: the website can use its paired
credentials. Review device access when replacing an authenticator or responding
to a compromise.

For endpoint and SDK details, see the
[App approval API](/en/docs/operations/app-approval).
