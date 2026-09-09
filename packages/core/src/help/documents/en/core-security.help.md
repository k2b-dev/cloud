---
id: core-security
title: Sign-in & security
icon: ti ti-shield-lock
description: Login methods, password recovery, passkeys, API keys, sessions, and account safety.
order: 112
---

The available sign-in methods depend on the account provider and platform settings. Use the method offered for your account rather than creating duplicate accounts.

## Sign in and recover access {icon="shield-lock"}

The account types are **Guest**, **Login** (your organization may use another
name) and **FreeIPA**. Guest starts with an email link. When app sign-in is
configured, Login and FreeIPA start with the app; email and password
alternatives remain available. Local accounts do not use passwords.
An existing passkey still works while the account type is allowed. If your
type is hidden, use your invitation or direct sign-in link. A hidden entry is
not the same as disabled access; ask your administrator if access is disabled.

- Use the normal login form for the provider configured for your account.
- Use a passkey when one is already registered and the browser or device supports it.
- Request password recovery only for accounts that use a recoverable password login.
- Follow the link from the most recent recovery message; older or completed links may no longer work.
- Ask an administrator to verify the account provider when the expected login method is missing.

## Pair and manage a sign-in app {icon="device-mobile"}

If your administrator enables and configures app sign-in, open **My account → Security →
Pair a device**. Scan the QR code or copy the pairing link into the app.
Return to Cloud, compare the six-digit codes and
confirm only if they match. Keep the app open until it confirms completion.
The link expires after five minutes; do not share it outside this setup.

If Security shows **Enabled — setup required**, the administrator must finish
the app configuration first. Use your existing sign-in method meanwhile.

To sign in later, select your account type and, for Guests, the app sign-in alternative,
then enter your email or username and choose **Sign in with app**. Open the paired app and approve only the request
you started, with the matching code. Without the app, local accounts can still
use an email link; FreeIPA accounts can use their password. Existing passkeys
remain available.

After sign-in, Cloud asks you to accept its terms and acknowledge the privacy
policy if you have not done so yet. Confirm to continue, or cancel to sign out.

**Paired devices** shows device names, when they were paired and last used,
and whether an administrator helped with pairing. Rename devices or revoke
ones you no longer control. Revocation prevents new sign-ins but does not end
existing sessions. These controls remain available when app sign-in is disabled.

Pairing, rename, and revoke may ask you to confirm your identity. Sign in with
the same account without signing out first. Pairing reopens automatically afterward.
If a login's final
result is unclear, reload to check your session or start a new request.

## Protect your account {icon="shield-lock"}

- Register passkeys only on devices you control, give them recognizable names, and remove ones you no longer possess.
- Review recent account activity for unexpected changes or credential use.
- Treat API keys as passwords. Give each integration its own key and revoke it when the integration is retired.
- Confirm the browser and account before approving a sensitive operation.

:::warning Never share recovery links or API keys
Anyone holding a valid recovery link or active API key may be able to act with the attached access. Do not paste them into support messages, screenshots, or documentation.
:::
