---
id: accounts-admin
title: Admin workflows
icon: ti ti-settings
description: User maintenance, group membership, service-account keys, notifications, and lifecycle views.
order: 110
---

Admin pages are server-rendered lists with URL-backed search, filters, pagination, and action buttons for account operations.

Global policy and lifecycle backfill controls live in **Administration → Accounts & sign-in**.
Use **Operations** for lifecycle jobs. Individual records, requests and history remain here.
Optional action-dependent follow-up notices are configured under **Registration & requests**.
They appear after successful user, group and membership changes; an empty template adds nothing.
Notices are instructions for the person making the change, not messages sent to users.

## Review duplicate email addresses {icon="users"}

Open **Administration → Duplicate email addresses** to compare accounts sharing an address.
Matching ignores letter case and surrounding spaces. The last Cloud web login is
shown separately for each account; FreeIPA accounts also show the last Kerberos
login and sync time. Kerberos activity can include use outside Cloud. Times are
in UTC. **Not recorded** does not mean the account has never been used.

Open an account to inspect its access before deleting it. Deleting a FreeIPA
account also deletes the user in FreeIPA. Data and permissions are not transferred
to the remaining account. Confirm each deletion separately. Resolved addresses
disappear from the list; you cannot delete your own account.

## User and group management {icon="user-cog"}

:::reference
- **Users:** Search accounts by uid, name, or email. Filter by provider and profile, then open a user to edit profile fields, avatar, roles, provider, expiry, and group membership.
- **Groups:** Open a group to review facts, members, managers, and parent groups. Managers can add or remove users and groups where mutations are available.
- **Linux identities:** While enabled in Administration → Accounts & sign-in → Linux identities, new local full accounts and promoted guests receive Linux attributes automatically. Administrators can assign missing attributes to older accounts and override home and shell. FreeIPA values are read-only. Local groups can receive a GID after global setup. These actions do not enable computer login or sudo.
- **Deleted accounts:** Review accounts removed by manual action, expiry cleanup, FreeIPA demotion, or sync scope changes. Metadata remains available from the row details.
- **Reminder history:** Search account-expiry reminder attempts, including target expiry, threshold days, status, attempts, last attempt, and last error.
:::

## Access and messaging {icon="shield-lock"}

:::reference
- **Service accounts:** List active or revoked API keys, filter by user-bound or resource-bound owner, and revoke active keys when access should end.
- **Notifications:** Create admin notification drafts, preview recipients, finalize the batch, and review delivery counters or failed recipients.
- **Requests:** Create accounts from pending requests or deny requests. A denial reason sends an email when provided. Existing requests remain available when new requests are disabled in Administration.
:::

:::info Audit trail
Account and access changes are recorded in Audit Log. Use the service-account filter when investigating API-key activity.
:::

## POSIX groups {icon="users"}

When creating a local group, select **Create as POSIX group** to assign a stable GID. The option is off by default and requires local Linux identities to be enabled in Administration. Without it, the group remains a logical group. If assignment fails, no group is created.

For an existing group, choose **Convert to POSIX** in its actions. Only administrators can assign a GID, and the assignment cannot be undone. FreeIPA manages its groups independently. No files are created by either action.

## Personal Linux groups {icon="user"}

When a local account gets a Linux identity, Cloud also creates a personal Linux group for it. The group has the account's username and is the account's primary group. Linux needs it, but it is not a team.

The group list hides personal Linux groups. To show them, open **View** and choose **Linux → Personal groups**. The count above the list includes only the groups shown. Each personal group is marked **Personal · of** followed by the owner's name, which links to that account.

A personal Linux group can't be deleted while it is its owner's primary group. Group pickers, such as sharing, permissions and **Add to group**, don't offer personal groups. Choose the person instead.
