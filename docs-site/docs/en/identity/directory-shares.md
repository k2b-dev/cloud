---
title: Directory shares
navTitle: Directory shares
section: Identity and access
order: 650
description: Let an agent or service account find explicitly shared directory entries by name.
tags: [identity, service-accounts, authorization]
updated: 2026-10-23
---

# Directory shares

An administrator can let an agent or standalone service account find selected
people, groups, or service accounts by name. A directory share reveals that
entry's directory information. It grants no access to resources and does not
reveal group membership or management relationships.

Open **Accounts → Service accounts → Directory access**, select the machine
account, then add the exact entries it needs. Each entry has a revoke control.
The account starts with no directory entries. Adding a group shares the group's
name and directory information, not its members. Personal-group owner details
and machine creator, delegation and resource-binding details are omitted.

## Search as the machine

Use the account's own API key or OAuth token with the `read` scope:

```http
GET /api/accounts/entities?search=Release&kinds=user,group,service_account&per_page=20
Authorization: Bearer <machine-token>
```

Search, exact-ID filters, totals and pagination all operate inside the current
shares. An unshared entry produces no result, even if the caller knows its ID.
With no shares, the result is empty. Relationship filters return HTTP 403.
A resource-bound account cannot use this directory path.

Removing a share hides the entry on the next lookup. Disabling the account or
revoking its credential also stops authentication. Resource grants continue to
authorize resource operations independently: directory visibility cannot make
a rejected resource operation succeed.

## Manage shares through the administrator API

The following routes require an installation administrator. OAuth credentials
also need `write` or `admin` for changes:

- `GET /api/admin/identity/directory-shares/<account-id>` lists shares with
  the standard `page` and `per_page` pagination parameters.
- `POST /api/admin/identity/directory-shares/<account-id>` shares one exact
  principal. Send `{"principal":{"type":"user","userId":"<user-id>"}}`,
  or a `group`/`groupId` or `service_account`/`serviceAccountId` principal.
- `DELETE /api/admin/identity/directory-shares/<account-id>/<share-id>`
  revokes that share.

Adding the same entry again keeps one share. Revoking an already absent share
succeeds, so retrying either operation after a lost response is safe.
Broad `authenticated` and `public` principals are rejected.

Administrator changes and machine lookup outcomes are audited. Lookup audit
records identify the account and credential without storing search text or
result contents. See the [operations note](/en/docs/operations/directory-shares).
