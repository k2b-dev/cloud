---
id: accounts-admin
title: Administration tasks
icon: ti ti-settings
description: Maintain users and groups, resolve duplicate addresses, revoke keys and devices, send notifications, and check lifecycle history.
order: 110
---

The administration pages are server-rendered lists. Search, filters, and pagination are part of the URL, and action buttons run the account operations.

Global policy and the lifecycle backfill controls are in the Cloud administration under **Accounts & sign-in**. Run lifecycle jobs from **Operations**. Single records, requests, and history stay here in Accounts.

In **Registration & requests**, you can set optional follow-up notices that depend on the action. They appear after successful user, group, and membership changes. An empty template adds nothing. A notice is an instruction for the person who makes the change. Cloud does not send it to users.

## Resolve duplicate email addresses {icon="users"}

Open **Admin → Duplicate email addresses** to compare accounts that share an address. The match ignores letter case and spaces at the start or end.

Each account shows its last Cloud web sign-in. FreeIPA accounts also show the last Kerberos sign-in and the sync time. Kerberos activity can include use outside Cloud. All times are in UTC. **Not recorded** does not mean that nobody ever used the account.

:::warning Deleting a FreeIPA account also deletes the user in FreeIPA
Accounts does not move data or access to the remaining account.
:::

:::steps
1. Open an account and check its access.
2. Delete the account.
3. Confirm each deletion separately.
:::

Resolved addresses disappear from the list. You cannot delete your own account.

## Maintain users and groups {icon="user-cog"}

:::reference
- **Users:** Search accounts by uid, name, or email. Filter by provider and profile. Open a user to edit profile fields, avatar, roles, provider, expiry, and group membership.
- **Groups:** Open a group to review its facts, members, managers, and parent groups. Managers can add or remove users and groups where the page offers these changes.
- **Linux identities:** While assignment is on in the Cloud administration under **Accounts & sign-in → Linux identities**, new local full accounts and promoted guests get Linux attributes automatically. Administrators can assign missing attributes to older accounts and override home and shell. FreeIPA values are read-only. Local groups can get a GID after the global setup. These actions do not enable computer sign-in or sudo.
- **Deleted accounts:** Review accounts that were removed by a manual action, expiry cleanup, FreeIPA demotion, or a change of the sync scope. The row details keep their metadata available.
- **Reminder history:** Search the attempts to send account expiry reminders. Each entry shows the target expiry, the threshold days, the status, the attempts, the last attempt, and the last error.
:::

## Run an account without email {icon="user-cog"}

When **Allow local accounts without email** is on in the Cloud administration, you can create a **Login** account without an address. To remove the address of an existing account, clear the field and confirm. The person then signs in with a paired app or a passkey. Accounts hides actions that need email, such as **Notify**, for these accounts.

For the first sign-in, do one of these:

- Share a one-time **Login token**.
- Pair the first device of the person with **Pair sign-in app**, if **Allow administrator-assisted pairing** is on.

If the person loses their only device:

:::steps
1. Revoke the device under **Sign-in devices**.
2. Give the person a new **Login token**.
:::

The person can then sign in and pair a device again.

## Control keys, devices, notifications, and requests {icon="shield-lock"}

:::reference
- **Service accounts:** List active or revoked API keys, and filter by user-bound or resource-bound owner. Revoke an active key when its access must end.
- **Sign-in devices:** The page of a user lists the devices that approve their app sign-ins, with pairing date and last use. Revoke a lost device there. Existing sessions stay signed in, and Cloud notifies the user.
- **Notifications:** Create notification drafts, preview the recipients, and finalize the batch. Then review the delivery counters or the failed recipients.
- **Requests:** Create accounts from pending requests, or deny requests. If you enter a reason for a denial, Cloud sends it by email. Existing requests stay available when new requests are turned off in the Cloud administration.
:::

:::info Trace changes in the audit log
**Audit log** records account and access changes. To investigate API key activity, filter by service account.
:::

## Create a POSIX group {icon="users"}

When you create a local group, select **Create as POSIX group** to assign a stable GID. The option is off by default and needs local Linux identities enabled in the Cloud administration. Without it, the group stays a logical group. If the assignment fails, Accounts creates no group.

:::warning You cannot undo a GID assignment
Only administrators can assign a GID.
:::

To convert an existing group, choose **Convert to POSIX** in its actions.

FreeIPA manages its own groups independently. Neither action creates files.

## Find personal Linux groups {icon="user"}

When a local account gets a Linux identity, Cloud also creates a personal Linux group for it. The group has the username of the account and is its primary group. Linux needs this group, but it is not a team.

The group list hides personal Linux groups. To show them:

:::steps
1. Open **View**.
2. Choose **Linux → Personal groups**.
:::

The count above the list includes only the groups shown. Each personal group shows **Personal · of** and the name of its owner. The name links to the account.

You cannot delete a personal Linux group while it is the primary group of its owner. Group pickers, for example for sharing, access, and **Add to group**, do not offer personal groups. Choose the person instead.
