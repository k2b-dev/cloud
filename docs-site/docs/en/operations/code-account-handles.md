---
title: Code account handle migration
navTitle: Code account handles
section: Operations
order: 1257
description: Apply the additive migration that assigns handles to existing Code accounts without changing their grants.
tags: [code, operations, migration]
updated: 2026-11-03
---

# Code account handle migration

Core's normal auth migration adds nullable `handle` and `title` columns to
`auth.service_accounts`, creates a unique handle index, and assigns handles to
existing `kind = 'code'` accounts in bounded batches. Each handle contains
`code-` followed by ten random symbols from a 32-symbol alphabet: 50 random
bits. A collision draws again. Re-running the migration preserves assigned
handles.

Account UUIDs, grants, credential restrictions, and the constraint keeping Code
account binding columns empty remain unchanged. Owner titles begin as empty
snapshots for existing accounts; Core's next successful owner check or an
owner rename refreshes them. No backfill calls owner applications.

Deploy target applications with the current `resolveDisplayNames` contract
before exposing their Code account rows. They return owner titles only after
checking Manage locally, and no longer request arbitrary account names from
Core. See [Code account handles](/en/docs/identity/code-service-account-handles)
for the search and rename contracts. No new environment setting or worker is
required.

Resource share dialogs use the platform lookup from `target: { type, id }`.
Deploy the target's canonical reader with its checked `data.view.permission`
alongside this UI change. Target managers then add exact handles through the
normal grant operation. Applications do not need a Code declaration or their
own lookup transport. The same checked permission controls access-list names.
