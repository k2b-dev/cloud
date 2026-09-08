---
title: Account administration API
navTitle: Account administration
section: Reference
order: 1276
description: Display account categories and manage Linux identities through supported APIs.
tags: [accounts, api, linux]
updated: 2026-09-09
---

# Account administration API

For application authors integrating account presentation or administrator-only
Linux identity operations. For configuration in Administration, start with
[Accounts & sign-in](/en/docs/accounts).

## Display account types in an application

Use the browser-safe `accountCategory(user)` and
`accountCategoryLabel(user, loginLabel)` helpers from
`@k2b/cloud/contracts`. Server-rendered applications obtain the label
from `readAccountCategoryPolicy()` in `@k2b/cloud/services` and pass
only the required presentation data to the browser.

Cloud's authentication layer enforces access automatically. The server-only
`isAccountCategoryAllowed(user)` checks category eligibility for platform-owned
credential flows; it does not replace authentication, expiry checks or resource
authorization. Authorization reads the durable policy without relying on the
settings cache; invalid stored policy fails closed.

## Linux identity API

The platform service `linuxIdentities`, exported from
`@k2b/cloud/services`, enforces administrator access on every method,
including calls outside HTTP. It owns identity configuration, reads and
mutations; application-owned access grants do not confer this authority.

| Method and path below `/api/admin/core/linux-identities` | Purpose |
| --- | --- |
| `GET /` | Preview a page; optional UUID `after` cursor |
| `PUT /configuration` | Save `{ config, rangeReserved }`; enabled setup requires confirmation |
| `GET /users/:id` | Inspect one account and its identity state |
| `POST /users/:id` | Backfill missing attributes for one eligible local full account |
| `PATCH /users/:id` | Set local `homeDirectory` and `loginShell` |
| `POST /groups/:id` | Assign a GID to an existing local group |

The configuration is one validated value, `linux.identity_config`, in the
existing settings store. Use the dedicated administration API rather than
editing that JSON setting directly. Allocation and the current configuration
are checked inside each database transaction. No partial account or group
allocation is published when a check fails.
