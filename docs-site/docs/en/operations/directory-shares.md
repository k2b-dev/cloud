---
title: Operate machine directory shares
navTitle: Operate machine directory shares
section: Operations
order: 1450
description: Roll out, inspect and revoke bounded directory access for machine accounts.
tags: [identity, service-accounts, authorization]
updated: 2026-10-23
---

# Operate machine directory shares

Core creates the directory-share table during its normal schema setup.
Existing machine accounts receive no directory access automatically. Upgrade
Core before using the new administrator controls in Accounts.

An installation administrator manages exact entries under **Accounts → Service
accounts → Directory access**. Review the selected account and entries before
adding a share. Group membership and resource grants do not create directory
shares.

Revoke an individual share to hide that entry on subsequent lookups. Disable
the machine account to stop all its credentials, or revoke one credential to
stop that token. Existing resource access remains independent of directory
visibility.

Audit actions `accounts.directory.grant`, `accounts.directory.revoke`, and
`accounts.directory.search` record changes and successful scoped lookups.
Their metadata identifies the machine account. Lookup events do not contain
search strings or directory results.

If a machine sees an empty result, check its current shares and search filters.
HTTP 403 indicates a missing `read` scope, unsupported account kind, or a
relationship query; directory shares do not disclose group relationships.
HTTP 401 requires an active credential and account. See
[Directory shares](/en/docs/identity/directory-shares) for the API contract.
