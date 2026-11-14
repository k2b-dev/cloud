---
title: Retire Studio apps
navTitle: Studio retirement
section: Operations
order: 1259
description: Prepare for the one-way removal of Studio apps while preserving chat code and execution evidence.
tags: [assistant, code, migration, operations]
updated: 2026-11-08
---

# Retire Studio apps

Studio apps and their app data are removed without transfer. They do not become
Code. The standalone UI, revisions, publications, sharing, app KV and files,
RSQL databases, machine execution and credentials, HTML checks and HTML
presentations are no longer available. The `assistant.app` search type,
`assistant.artifact` references, composer `/app`, Studio API routes and
`cld assistant code` / `studio-admin` commands are retired. Old references
report that the resource is unavailable; they never resolve to a Code ID.

Chat `code_run`, `code_inspect`, `code_stop`, `code_export`, `code_secret`,
approvals, chat and Project files, signed file links and native views remain.
For a new lasting program, ask Gustav to build Code and review it before
activation. This does not recover a Studio app or its data.

## Before upgrading

Stop all old Assistant replicas and in-flight Studio work before starting the
new version. Make any backup required by the installation's retention contract
before upgrading. This is the last opportunity to retain Studio source and app
data: the migration deletes them, including mapped external RSQL namespaces
and the cleanup journal's namespaces. A Postgres backup contains namespace
mappings, not the external database contents.

Keep the existing `APP_SECRET`, RSQL URL, API token and network allowlist valid
until startup completes. The migration deletes only namespaces named in Studio's
stored mappings or cleanup journal, in bounded batches. A missing namespace is
already clean. Any other remote error stops startup and rolls back local
changes, preserving mappings and credentials for retry. Some remote deletions
may already have completed; retrying does not restore their contents. Do not
restart an old Assistant after cleanup has begun.

Update Core, Assistant and the Code runner together. The Assistant image no
longer installs Chromium or ships a Playwright runtime. Chat execution uses
workerd; PDF generation uses Gotenberg. Shared browser testing, other
applications' RSQL infrastructure and Gotenberg remain independent.

## Preserved history and chat state

Execution evidence stays in the original `assistant` tables as a read-only
operator archive: `artifact_agent_calls`, `artifact_agent_approvals`,
`artifact_client_calls`, `capability_calls`, `http_calls`,
`artifact_machine_runs`, `artifact_checks` and `chat_presentations`.
The mixed tables keep their rows at upgrade and reject direct writes.
Existing account and chat deletion cascades still apply. This archive introduces
no new retention period: operators apply their existing restricted archive
retention policy using privileged Postgres maintenance, disabling the archive
write trigger only within that maintenance transaction. They have no execution
API. Existing audit and logging records remain subject to the installation's
retention policy. Old transcript text remains readable; retired tools cannot
run again.

Chat transport continues in `code_agent_calls`, `code_agent_approvals`,
`code_client_calls`, `code_capability_calls` and `code_http_calls`, retaining
original call IDs, results, approval links and deduplication state. Chat-scoped
`http_secrets` remain encrypted with their original values and revisions.
Studio resource secrets are deleted. Pending Studio approvals are cancelled;
chat approvals and remembered chat decisions remain intact. Native view files
and chat/Project files are independent of Studio and stay in place.

The migration removes Studio access links, current conversation/Project resource
references and retired settings. Historical transcript and source records may keep
old identifiers; these never grant access or resolve to replacement Code. It detaches only Studio app foreign keys before removing app
records, so app deletion cannot cascade into historical evidence. An empty `assistant.artifacts` view prevents an old binary from
recreating Studio tables. A successful migration can restart safely; rollback
requires restoring the pre-upgrade installation and its external data backups.
