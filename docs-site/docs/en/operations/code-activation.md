---
title: Code activation recovery
navTitle: Code activation recovery
section: Operations
order: 1255
description: Upgrade and recover Code activation while preserving normal shares and version entries.
tags: [code, operations, recovery]
updated: 2026-11-04
---

# Code activation recovery

Core runs activation and old-version drain workers in its normal lifecycle.
Activation checks the owner and version approval, then switches the active
version and its version entry atomically. It never creates, inspects or repairs
target rights. Target managers use the normal share dialog to grant the Code
service account View or Edit by its exact handle.

## Upgrade the access model

Deploy the matching Core, shared Cloud library and capability providers together.
Remove Code rights adapters from provider declarations; keep `access.readable`
and the `code.owners` and `code.pages` contract where the app owns Code.
Third-party apps accept service accounts through ordinary sharing without any
Code declaration. Follow the
[normal grant transaction and lock order](/en/docs/identity/authorization#retain-manager-authority-while-changing-a-grant).
No new service, setting or credential is needed.

The migration preserves ordinary shares and built-in adapter-created shares used by
the active version or by queued/running work, including their exact permission
levels and application junctions. These shares already use normal tables, so
they need no regrant or inferred replacement. Target managers can edit or
remove them through ordinary sharing after the upgrade. Legacy adapter shares
with no active or draining version finish their existing compensation before
the journal is retired. No share is reconstructed from journal metadata.
Shares retained for draining work also become ordinary account shares: they
remain after those runs finish, until a target manager removes them. Target
managers should review their Code service-account shares after the upgrade,
including access used only by superseded versions.
The migration removes target planning, replay and notification metadata; those
records can no longer create or restore access. It also cancels unfinished
legacy activations once. Their previous active version remains unchanged.
Start a fresh activation when ready. Later startup migrations leave new pending
activations intact.

For a third-party provider, verify that its old adapter wrote the same
permission rows its normal share service reads. If it used a separate store,
that provider must migrate its authoritative permissions to normal sharing
before removing the adapter. Core's target journal cannot reconstruct them.

New Code version entries belong to app `runner` and have `policy IS NULL`.
Existing `core`-owned mandates retain their policies until a new version is
explicitly activated. Do not clear those restrictions during an upgrade.
The Mail automation migration and Grids execution accounts are separate
workloads and remain unchanged.

The Cloud administrator's Code policy decides for each actual call which
classifications need an approved version; an approval grants no target access.
Actions that ask a person first (the `ask_*` rows) never run for Code in this
release, even with an approved version or the **Open** preset: the bridge
refuses them with `code_unattended_forbidden`, and sends with
`code_sends_not_yet`. Tell Code authors to use silent Actions.

This migration drops the legacy activation target journal. Roll back only to
an implementation that understands normal sharing, nullable Code policies and
the narrowed owner projection. An older activation worker requires its old
schema and is not a compatible application-only rollback. Keep a database
backup under the installation's normal backup policy and prefer rolling
forward. Never replay old activation plans to reconstruct rights.

## Recover an unfinished activation

Use the [activation status routes](/en/docs/platform/code-activation) with the
original process ID. `waiting` means Core will retry an unavailable owner or
dependency. Restore that dependency or cancel the attempt. If the activating
credential expires or is revoked, sign in again and start a new activation.
A failed or cancelled attempt leaves the previous version and all normal shares
unchanged.

`code.activations` is the durable journal. `code.activation_outbox` records
pending work with `attempts`, `last_error`, `next_attempt_at` and
`claimed_until`. Activation and drain use separate ordered streams. Restarting
Core resumes work; do not delete outbox rows to clear a failure.

Old version entries remain while that version has queued or running runs.
After those runs end, cleanup revokes the old entries. It does not remove target
shares or require a target provider to answer. Pausing Code retains shares.
Owner deletion disables the account and revokes entries before cleanup deletes
the account; existing foreign keys remove its normal shares. See
[Code lifecycle](/en/docs/platform/code-lifecycle).

## Recover a refused target call

A target's 403 or 404 is recorded at the run. Inspect the Code page and the
target's own share dialog and history. A Cloud administrator's version approval
grants no target access. A target manager must explicitly restore a removed
share; restarting, retrying or reactivating Code cannot restore it.

Sharing waits up to five seconds for settings or directory writes and table
maintenance, within the existing request budget. Short maintenance completes
without a retry. If that wait expires, or a concurrent identity change holds
the account row, sharing returns HTTP 409 with `retryable: true`. Retry the
complete share operation after the conflict finishes. Every operation rechecks
the current manager's authority after waiting. Administration repairs recheck
live Cloud-admin authority, including supported delegated credentials; an app
session does not supply that authority.

Code service accounts receive only direct View or Edit, never Manage or
inherited group, signed-in or public access.
