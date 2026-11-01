---
title: Code storage
navTitle: Code storage
section: Operations
order: 1253
description: Back up Code versions and understand run retention and storage budgets.
tags: [operations, code, postgres]
updated: 2026-11-01
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

Administrators can change any of the six budgets with
`cld admin settings apply --from ./code-limits.json --yes`. For example, this
file sets the source budget to 2 MiB:

```json
{
  "updates": {
    "core.code.source_bytes": 2097152
  }
}
```

The command uses Core's settings API, which validates the declared integer
ranges, saves the update transactionally, records the change and invalidates
cached values. Omitted settings retain their values. Use
`cld admin settings reset core.code.source_bytes --yes` to restore its default.
To explicitly replace an unreadable stored value, add
`"replaceUnreadable": ["core.code.source_bytes"]` alongside `updates` in the
JSON file. This replaces that whole value; include its new value in `updates`.
The Code keys use `settings apply`; `settings list`, `show` and `set` currently
filter Core's catalog to platform-declared settings and exclude these keys.
See [CLI administration](/en/docs/operations/cli-administration) for login.

Core sweeps at most 1,000 terminal runs per minute per replica, starting at
30 days after the run ends. It deletes their capability-call records with
them and preserves queued or running attempts. A failed sweep is logged and
retried on the next minute. Versions are retained until their Code is deleted.
