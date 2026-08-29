---
id: accounts-start
title: Start
icon: ti ti-users-group
description: Accounts, groups, requests, service accounts, notifications, and audit history.
order: 100
---

Accounts shows your own account context and gives admins one place to manage users, groups, account requests, API keys, notification batches, and account history. Its Dashboard and navigation are useful before opening an individual user or group: they show your access, available management scope, and the main administrative queues.

## Overview {icon="layout-grid"}

:::reference
- **Account:** A person record with login provider, profile, roles, expiry data, group memberships, and optional avatar.
- **Group:** A local or FreeIPA group. Groups can contain users or groups and can grant management rights over other groups.
- **Account request:** A submitted access request. Admins can create an account from a pending request or deny it with an optional email reason.
- **Service account key:** An API key owned by a user or resource. Active keys can be revoked; revoked keys stay visible for audit history.
:::

## Common paths {icon="route"}

:::reference
- **Check your access:** Open Dashboard to see your account type, manager scope, login method, expiry date, and group shortcuts.
- **Find a group:** Use Groups to search all visible groups, filter by provider, or switch between groups you manage, belong to, or can view.
- **Review pending requests:** Admins use Requests to filter pending, completed, denied, or all account requests.
- **Trace a change:** Admins use Audit Log to search account events by actor, target, action, outcome, provider, service account, or time range.
:::

:::info FreeIPA boundary
FreeIPA-backed users and groups are written through the Accounts service when FreeIPA is enabled. Local accounts and local groups stay in the Cloud database.
:::
