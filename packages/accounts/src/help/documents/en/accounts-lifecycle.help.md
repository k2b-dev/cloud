---
id: accounts-lifecycle
title: Access lifecycle
icon: ti ti-user-shield
description: Understand direct and inherited groups, account expiry, requests, service accounts, and safe access changes.
order: 115
---

Accounts connects identity records to the access people and integrations receive. Review the current provider and group path before changing a user or group.

## Read access correctly {icon="shield-lock"}

- **Direct membership** is attached to the user or group itself.
- **Indirect membership** comes through nested parent or child groups. Use the direct-only control when you need to distinguish the stored membership from effective access.
- **Managers** can maintain the groups within their management scope. This is separate from merely belonging to a group.
- **Service-account memberships** are hidden from normal membership lists until you choose to show them.
- **Provider badges** distinguish local records from FreeIPA-backed records and other configured profiles.

## Typical lifecycle {icon="user-cog"}

:::steps
1. Review or approve an account request.
2. Create the account with the intended provider and profile.
3. Add only the direct groups required for the role.
4. Confirm effective group access and manager scope from the account or group detail.
5. Set or review expiry where temporary access is intended.
6. Use reminder history and deleted-account history when investigating lifecycle changes.
:::

## Service-account keys {icon="point"}

- A **user-bound** key acts for its owner within that user's effective access.
- A **resource-bound** key is scoped to the owning app resource.
- Revocation ends future use of the credential; the record remains available for audit history.
- Never copy a key into tickets, chat messages, screenshots, or documentation.

:::warning Check inherited access before removal
Removing one direct membership does not guarantee that effective access disappears. The same user or group may still inherit access through another group path.
:::

## When the result is unexpected {icon="lifebuoy"}

- Switch between direct-only and all membership views.
- Show service-account memberships when the table count and visible human members differ.
- Check the record provider before retrying a write.
- Open Audit Log and filter by actor, target, action, or service account.
- Review deleted-account or reminder history when the account changed through expiry or synchronization.
