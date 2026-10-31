---
title: Code storage
section: Operations
order: 1252
description: Back up Code versions and understand run retention and storage budgets.
tags: [operations, code, postgres]
updated: 2026-10-31
---

# Code storage

Core startup adds the Postgres schema `code`. Include it in the same backup
as `auth` so owner identities, service accounts, grants, versions and run
references remain consistent. The additive migration does not rewrite
Assistant chats, settings or workflow records.

Source files and exact bundles live in Postgres with their immutable versions.
They are not container files or runner caches. Configure their admission
budgets through the `core.code.*` administrator settings documented in the
[Code data model](/en/docs/platform/code-data-model#storage-limits-and-retention).
No Code storage environment variables are required.

Core sweeps at most 1,000 terminal runs per minute per replica, starting at
30 days after the run ends. It deletes their capability-call records with
them and preserves queued or running attempts. A failed sweep is logged and
retried on the next minute. Versions are retained until their Code is deleted.
