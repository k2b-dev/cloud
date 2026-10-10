---
id: accounts-start
title: Start
icon: ti ti-users-group
description: Find accounts, groups, requests, service accounts, notifications, and the audit history.
order: 100
---

Accounts shows your own account context. Administrators also use it to edit users and groups, process account requests, revoke API keys, send notification batches, and review account history. Before you open a single user or group, check **Dashboard** and the navigation. They show your access, your management scope, and the main administrative queues.

## Know the objects {icon="layout-grid"}

:::reference
- **Account:** A person record with sign-in provider, profile, roles, expiry data, group memberships, and an optional avatar.
- **Group:** A local or FreeIPA group. A group can contain users or groups. It can also be the manager of other groups.
- **Account request:** A submitted request for access. Administrators can create an account from a pending request, or deny it with an optional reason by email.
- **Service account key:** An API key that belongs to a user or a resource. You can revoke an active key. Revoked keys stay visible for the audit history.
:::

## Find the right page {icon="route"}

:::reference
- **Check your access:** Open **Dashboard**. It shows your account type, your manager scope, your sign-in method, your expiry date, and shortcuts to your groups.
- **Find a group:** In **Groups**, search all visible groups, filter by provider, or switch between the groups that you manage, belong to, or can view.
- **Review pending requests:** Administrators filter **Requests** by pending, completed, denied, or all account requests.
- **Trace a change:** Administrators search **Audit log** for account events by actor, target, action, outcome, provider, service account, or time range.
:::

:::info Where FreeIPA changes go
When FreeIPA is enabled, the Accounts service writes the changes to FreeIPA-backed users and groups. Local accounts and local groups stay in the Cloud database.
:::

## Find an account or group {icon="search"}

:::steps
1. Choose the search button, or press **Cmd/Ctrl+Shift+K**. Cloud search opens with an **Accounts** chip.
2. Search for a group that you can view. Administrators can also find users and service accounts.
3. Select a result to open its administration page.
:::

Remove the chip to search other apps.
