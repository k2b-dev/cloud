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
