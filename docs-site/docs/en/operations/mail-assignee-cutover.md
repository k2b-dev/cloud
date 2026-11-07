---
title: Upgrade Mail conversation assignments
navTitle: Mail assignment cutover
section: Operations
order: 1139
description: Stop older Mail processes before upgrading conversation assignments and plan recovery across the schema boundary.
tags: [mail, migration, deployment, rollback]
updated: 2026-10-22
---

# Upgrade Mail conversation assignments

Use a maintenance window when upgrading Mail from people-only conversation
assignments to assignments that also support agents and standalone service
accounts. **Stop every older Mail replica and worker before starting the new
image.** A rolling upgrade across this boundary is unsupported, even if no
account has been assigned yet.

The migration keeps existing human assignments and their timestamps. It adds
account assignments and records `2 (principal_assignees)` alongside
`1 (baseline)` in `mail.schema_migrations`. These are schema markers, not
Cloud release numbers. The previous baseline-only Mail migration refuses the
new marker before it can replace shared database functions. A marker cannot
stop an older process that is already running.

Mail assignee eligibility includes active standalone and agent accounts with
named direct or local-group grants. Deploy Core’s local machine-membership
migration before the updated Mail image; public and authenticated grants do
not make an account assignable.

## Prepare and stop all older Mail processes

1. Record the current image digest and select the complete target release set.
   Pull the required images before downtime. Inventory every Mail replica,
   worker and manual process that uses the database, including old processes
   that an orchestrator could restart automatically.
2. Pause Mail entry points and incoming work. Let active operations drain, then
   stop every older Mail process and prevent its automatic restart. Verify that
   none remains connected to the database. Queued work must remain stored;
   do not purge it as part of the upgrade.
3. Take a consistent pre-upgrade backup using the installation's established
   recovery procedure and verify that it can be restored with the recorded old
   image. Include the required secrets and coordinated persistent state; see
   [Secrets and persistent state](/en/docs/data/secrets-and-persistent-state).
   Because Cloud applications share Postgres, establish the restore scope and
   recovery point before proceeding. Do not start the new Mail image until
   this recovery path is ready.

## Migrate and verify

1. Start one updated Mail process. Its startup migration changes the assignment
   schema, installs the live-update function and records the compatibility
   marker in one transaction. If migration fails, keep older processes stopped
   and inspect the startup error before retrying.
2. Verify the marker with a read-only database query:

   ```sql
   SELECT version, name, applied_at
   FROM mail.schema_migrations
   ORDER BY version;
   ```

   The expected entries are `1 (baseline)` and `2 (principal_assignees)`.
   Rerunning the updated migration preserves their timestamps. The marker is
   required even on an installation that currently assigns only people.
3. Verify that existing human assignments remain present. With test principals,
   grant assigned-only access and assign a conversation to an agent and a
   standalone service account. Verify that each account can read and change
   its assigned conversation within its credential scopes, cannot read an
   unassigned conversation, and loses access when its grant is revoked.
   Verify a conversation update and live refresh as well.
4. Start the remaining updated Mail replicas and workers, verify readiness and
   queued work, then restore Mail traffic. Keep the previous image excluded
   from every replica pool and restart policy.

## Recover after the migration

Prefer fixing forward with a compatible Mail image. Replacing the image with
the previous binary does not undo the schema migration, even when no account
assignments exist.

To return to the previous image, stop the updated Mail processes and restore
the pre-upgrade backup using the recovery scope established above, including
coordinated persistent state. Writes accepted after that backup require an
explicit recovery decision; a database restore can also affect other Cloud
applications. Verify the restored schema and old image before restoring traffic.

Do not delete the compatibility marker, reset the Mail schema, or manually
replace database functions to force an old image to start. A previous image
may print its historical development-only schema-reset advice when it sees
this marker; that advice does not apply to an upgraded installation. The
current image also refuses unknown legacy or newer histories and preserves
the database for recovery.
