---
id: core-profile
title: Profile
icon: ti ti-user-circle
description: Account self-service, FreeIPA requests, API keys, passkeys, groups, and activity history.
order: 110
---

The account area combines local Cloud data, optional FreeIPA data, and self-service actions for the signed-in user.

## Profile sections {icon="paperclip"}

:::reference
- **Identity:** Shows display name, uid, avatar, provider, profile type, supplemental roles, email, phone, address, account expiry, and password expiry when available.
- **Groups:** Shows direct group membership by default. **Show inherited** includes memberships inherited through the group hierarchy.
- **FreeIPA request:** Local users can request FreeIPA access when account requests, the FreeIPA connection and FreeIPA account access are enabled. Pending requests can still be withdrawn when new requests are disabled.
- **Activity:** Shows recent security-relevant account activity for the selected 7-, 30-, or 90-day period.
:::

## Security controls {icon="shield-lock"}

:::reference
- **API keys:** Personal automation credentials that inherit the user's permissions. The full key is shown only once after creation.
- **Passkeys:** WebAuthn passkeys attached to the signed-in user and used for passkey login. Removing one prevents future sign-in with that passkey.
:::
