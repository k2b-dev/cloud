---
title: Set up app sign-in
navTitle: App sign-in
section: Accounts & sign-in
order: 1084
description: Connect Cloud to its trusted authenticator website and prepare a first sign-in.
tags: [accounts, administration, authentication]
updated: 2026-10-19
---

# Set up app sign-in

App sign-in lets people approve a Cloud login in a paired authenticator instead
of entering a password or opening an email link. An administrator chooses the
trusted authenticator website; people [pair their devices](/en/docs/accounts/devices).
Local and FreeIPA accounts can use it when their
[account category](/en/docs/operations/account-categories) is allowed.

## Before you start

You need administrator access and the HTTPS address of the authenticator your
organization uses. For the project-hosted [Cloud Login](/en/apps/cloud-login),
use `https://cloud-login.pwa.k2b.dev`. Self-hosted apps can use another HTTPS origin. It must be reachable
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
2. On Cloud's login page, choose your account type if a selector is shown.
   Login starts with app sign-in. FreeIPA starts with the password and Guest
   with email: choose **Use the app instead** there. Enter your username or an
   email that identifies one account.
3. Keep the login page open and open your authenticator, or tap its
   notification if you turned notifications on.
4. Unlock the app, compare the request with the waiting login page, and approve
   only if the codes match and you started the request. Check the browser,
   start time, and any place or network details shown above the code.

The waiting page signs you in after approval. Deny requests you do not recognize.
If a request expires, start a new sign-in from Cloud.

### Read the request details

For browser sign-ins, Clouds that support sign-in context let Cloud Login
show these rows above the comparison code:

- **{browser} on {os}**, or **Unknown browser**. Safari on an iPad can read
  **Safari on Mac or iPad**.
- **Approximately {city}, {country}**, or only the country; **Location unknown**
  when no place is available. **Network: {operator}**, or **Network unknown**.
  These two rows appear only when Cloud's location database (GeoIP) knows the
  address; without a database, or for an unknown address, both are left out.
  The network line names the operator; Cloud never labels a VPN or data center.
- **Same internet address as this phone**, only when true. Its absence says
  nothing about whether the addresses match.
- **Started at {time}**, in your phone's time zone.
- **Known browser · since {date}** if this browser signed in to this account
  before, or the calm note **Cloud does not know this browser yet**. During
  the first 14 days after the Cloud update, the app makes no known/new claim.

For a known browser in a new country, a calm note says **No sign-in from this
country in the last 90 days**. While Cloud's location history is younger, it
says **since {date}** instead. Only a new browser from a country without a
sign-in in that window, on an account that already has sign-in countries,
shows **Did you start this sign-in?** as a warning. **Deny** becomes the main
button; **Approve anyway** stays in its place. After denial, the sheet says
**Denied · Nobody was signed in.**

Offline, **You are offline. Approve and deny work again once you are connected.**
replaces the comparison hint, and both buttons are disabled. Older Clouds show
the earlier dialog with the start time. A request without context also uses
that dialog. Terminal sign-ins (Cloud CLI) are unchanged.

Known means “signed in here before”, not “safe”. These details help you notice
a request you did not start. They do not make app sign-in phishing-resistant:
a real-time phishing page can relay the code, and a proxy near you can match
place and network. Only passkeys are phishing-resistant. See
[location accuracy](/en/docs/operations/sign-in-locations#privacy-and-accuracy)
and [stored sign-in data](/en/docs/operations/sign-in-locations#where-traces-of-a-sign-in-end-up)
for accuracy and storage limits.

### Continue or use another method

After a FreeIPA sign-in with the app, this browser opens FreeIPA with the app
next time, until someone signs in there with a FreeIPA password again. The
page chooses the method from the account type you select and from this
browser, never from the name you enter, so it does not reveal whether an
account exists or which type it has.

Without a paired device, use the prominent email-link alternative for local
accounts or the password for FreeIPA. Existing passkeys remain
available at the bottom of the page. If your email is shared by multiple
accounts, use your username for app sign-in.

Cloud Login can notify paired phones about new sign-in requests. For that,
Cloud needs outbound HTTPS to the authenticator origin, and the authenticator
must have [push notifications](/en/docs/operations/cloud-login#send-push-notifications)
configured. Notifications contain only the Cloud address and an opaque
request reference.

Before offering app sign-in to your users, check pairing, approval, denial,
notifications and lost-device recovery on the browsers and devices your
organization supports.

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
The default is `https://cloud-login.pwa.k2b.dev`. The same setting supplies
the **Install app** link, its QR code, and pairing links. Override it when you
host the authenticator elsewhere; it is separate from the Cloud address in `app.url`.

## Maintain the integration

Use stable Cloud and authenticator addresses. Treat authenticator hosting and
updates as part of your sign-in security: the website can use its paired
credentials. Review device access when replacing an authenticator or responding
to a compromise.

For endpoint and SDK details, see the
[App approval API](/en/docs/operations/app-approval).
