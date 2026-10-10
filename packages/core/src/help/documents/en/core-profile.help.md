---
id: core-profile
title: Profile
icon: ti ti-user-circle
description: Review your account, groups, and activity, request FreeIPA access, and use API keys and passkeys.
order: 110
---

Your account area combines local Cloud data, optional FreeIPA data, and the actions that you can take for yourself.

## Review your account {icon="paperclip"}

:::reference
- **Profile:** Shows display name, username, avatar, provider, profile type, extra roles, email, phone, and address. **Account facts** also shows account expiry and password expiry when they are available.
- **Groups → Group memberships:** Shows your direct group memberships first. **Show inherited** adds the memberships that come through the group hierarchy.
- **Groups → FreeIPA account:** A local account can request FreeIPA access when account requests, the FreeIPA connection, and FreeIPA accounts are all enabled. You can still withdraw a pending request after new requests are turned off.
- **Sign-in → Account activity:** Shows recent security-relevant account activity for the last 7, 30, or 90 days.
:::

## Protect sign-in and automation {icon="shield-lock"}

:::reference
- **Developer → API keys:** Personal keys for automation. A key has the same access as your account. Cloud shows the full key only once, right after you create it.
- **Sign-in → Passkeys:** WebAuthn passkeys for passkey sign-in to your account. After you remove a passkey, nobody can sign in with it.
:::
