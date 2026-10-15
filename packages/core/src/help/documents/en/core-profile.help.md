---
id: core-profile
title: Profile
icon: ti ti-user-circle
description: Review your account, groups, and activity, request FreeIPA access, and use API keys and passkeys.
updated: 2026-10-12
order: 110
---

Your account area combines local Cloud data, optional FreeIPA data, and the actions that you can take for yourself.

## Review your account {icon="paperclip"}

:::reference
- **Profile:** Shows display name, username, avatar, provider, profile type, extra roles, email, phone, and address. **Account facts** also shows account expiry and password expiry when they are available.
- **Groups → Group memberships:** Shows your direct group memberships first. **Show inherited** adds the memberships that come through the group hierarchy.
- **Groups → FreeIPA account:** A local account can request FreeIPA access when account requests, the FreeIPA connection, and FreeIPA accounts are all enabled. You can still withdraw a pending request after new requests are turned off.
- **Approvals:** Shows your waiting Action requests across apps. You can approve or reject them here. Each request links to the chat that waits for it.
- **Sign-in → Account activity:** Shows recent security-relevant account activity for the last 7, 30, or 90 days.
:::

## Protect sign-in and automation {icon="shield-lock"}

:::reference
- **Developer → API keys:** Personal keys for automation. A key with **Full access** has the same access as your account. When your administrator offers the OpenAI-compatible API, you can choose **AI models only** instead: such a key can only call the AI models you may use in Assistant, for example from a dictation app. Cloud shows the full key only once, right after you create it.
- **Sign-in → Passkeys:** WebAuthn passkeys for passkey sign-in to your account. After you remove a passkey, nobody can sign in with it.
:::

## Choose your appearance {icon="palette"}

The profile menu shows your current appearance as one entry. Choose it to
switch to the next: **Automatic**, **Light**, **Dark**, then **Automatic**
again. The menu stays open. Automatic is the default. It follows your
device's light or dark setting.
