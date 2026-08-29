---
id: accounts-admin
title: Admin workflows
icon: ti ti-settings
description: User maintenance, group membership, service-account keys, notifications, and lifecycle views.
order: 110
---

Admin pages are server-rendered lists with URL-backed search, filters, pagination, and action buttons for account operations.

## User and group management {icon="user-cog"}

:::reference
- **Users:** Search accounts by uid, name, or email. Filter by provider and profile, then open a user to edit profile fields, avatar, roles, provider, expiry, and group membership.
- **Groups:** Open a group to review facts, members, managers, and parent groups. Managers can add or remove users and groups where mutations are available.
- **Deleted accounts:** Review accounts removed by manual action, expiry cleanup, FreeIPA demotion, or sync scope changes. Metadata remains available from the row details.
- **Reminder history:** Search account-expiry reminder attempts, including target expiry, threshold days, status, attempts, last attempt, and last error.
:::

## Access and messaging {icon="shield-lock"}

:::reference
- **Service accounts:** List active or revoked API keys, filter by user-bound or resource-bound owner, and revoke active keys when access should end.
- **Notifications:** Create admin notification drafts, preview recipients, finalize the batch, and review delivery counters or failed recipients.
- **Requests:** Create accounts from pending requests or deny requests. A denial reason sends an email when provided.
:::

:::info Audit trail
Account and access changes are recorded in Audit Log. Use the service-account filter when investigating API-key activity.
:::
