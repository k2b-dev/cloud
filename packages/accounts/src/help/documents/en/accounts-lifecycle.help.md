---
id: accounts-lifecycle
title: Access lifecycle
icon: ti ti-user-shield
description: Read direct and inherited groups, set account expiry, process requests, use service accounts, and change access safely.
order: 115
---

Accounts connects identity records to the access that people and integrations receive. Before you change a user or a group, check its current provider and its group path.

## Tell direct and inherited access apart {icon="shield-lock"}

- **Direct membership** belongs to the user or group itself.
- **Indirect membership** comes through nested parent or child groups. Use **Direct only** to tell the stored membership apart from the effective access.
- **Managers** can maintain the groups in their management scope. Managing a group is not the same as belonging to it.
- **Service-account memberships** stay hidden in normal membership lists until you choose **Show service-account memberships**.
- **Provider badges** tell local records apart from FreeIPA-backed records and other configured profiles.

:::warning Check inherited access before you remove a membership
Removing one direct membership does not guarantee that the effective access ends. The same user or group can still inherit access through another group path.
:::

## Give access for a role {icon="user-cog"}

:::steps
1. Review or approve an account request.
2. Create the account with the intended provider and profile.
3. Add only the direct groups that the role needs.
4. In the account or group details, check the effective group access and the manager scope.
5. If the access is temporary, set or check the expiry.
6. To investigate lifecycle changes, use the reminder history and the deleted-account history.
:::

## Use service-account keys {icon="point"}

- A **user-bound** key acts for its owner, within the effective access of that user.
- A **resource-bound** key is limited to the app resource that owns it.
- Revoking a key ends all future use of it. The record stays available for the audit history.
- Never copy a key into tickets, chat messages, screenshots, or documentation.

## Fix unexpected results {icon="lifebuoy"}

- Switch between **Direct only** and the view of all memberships.
- Choose **Show service-account memberships** when the table count differs from the visible human members.
- Check the provider of the record before you retry a write.
- Open **Audit log** and filter by actor, target, action, or service account.
- Check the deleted-account history or the reminder history when the account changed through expiry or synchronization.
