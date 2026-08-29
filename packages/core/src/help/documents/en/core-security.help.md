---
id: core-security
title: Sign-in & security
icon: ti ti-shield-lock
description: Login methods, password recovery, passkeys, API keys, sessions, and account safety.
order: 112
---

The available sign-in methods depend on the account provider and platform settings. Use the method offered for your account rather than creating duplicate accounts.

## Sign in and recover access {icon="shield-lock"}

- Use the normal login form for the provider configured for your account.
- Use a passkey when one is already registered and the browser or device supports it.
- Request password recovery only for accounts that use a recoverable password login.
- Follow the link from the most recent recovery message; older or completed links may no longer work.
- Ask an administrator to verify the account provider when the expected login method is missing.

## Protect your account {icon="shield-lock"}

- Register passkeys only on devices you control, give them recognizable names, and remove ones you no longer possess.
- Review recent account activity for unexpected changes or credential use.
- Treat API keys as passwords. Give each integration its own key and revoke it when the integration is retired.
- Confirm the browser and account before approving a sensitive operation.

:::warning Never share recovery links or API keys
Anyone holding a valid recovery link or active API key may be able to act with the attached access. Do not paste them into support messages, screenshots, or documentation.
:::
