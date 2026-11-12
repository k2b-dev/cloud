---
title: Rotate APP_SECRET
navTitle: APP_SECRET rotation
section: Operations
order: 1085
description: Rotate the installation encryption secret while applications keep reading existing data.
tags: [operations, encryption, secrets, rotation]
updated: 2026-11-12
---

# Rotate APP_SECRET

Rotate `APP_SECRET` in two overlapping rollouts. Readers accept the current root
and one previous or next root. Writers always use current. Stored ciphertext and
token formats stay unchanged.

Keep the old root until the data checks pass and old tokens have expired. Losing
it earlier can make stored credentials, settings, and old backups unreadable.
This procedure does not rotate app identity keys or Core's identity KEK; see
[App keys](/en/docs/operations/app-keys) and
[Identity key operations](/en/docs/operations/identity-key-operations).

## Prepare the installation

Use an administrator profile for status commands. Upgrade every application to a
version supporting overlapping roots and owner declarations before rotating.
Include stopped applications and third-party applications in your inventory.

Core and Gateway read the ring from their environment. Gateway never bootstraps
it from Core. Other applications receive the complete ring at startup from
Core. An application with an explicit local `APP_SECRET` uses only its local
ring: update that application's environment in both rollouts too.

`APP_SECRET_NEXT` and `APP_SECRET_PREVIOUS` support `_FILE`, as does
`APP_SECRET`. They are mutually exclusive, must differ from current, and require
an explicit local current when supplied locally. NEXT must contain 64 hexadecimal
characters representing 32 random bytes. Generate the new root through your
secret manager or `openssl rand -hex 32`; store it outside Git and shell history.
If the current `APP_SECRET` is a legacy passphrase or another human-chosen value,
use this procedure to rotate it to a random 64-hex-character root. Keep that
random format for future rotations.

Ensure each application declares its retained ciphertext owners. `[]` means no
application-owned encrypted rows; an omitted declaration is unknown and blocks
strict status. Settings belong to the platform owner under Core, including
settings declared by applications. See
[Declare encrypted data](/en/docs/data/secrets-and-persistent-state#declare-encrypted-data-for-rotation)
for the third-party application contract.

## Roll the new root into service

Call the existing root A and the new root B. The letters below name roots; do not
put these literal letters into the deployment.

1. Keep `APP_SECRET=A`; set `APP_SECRET_NEXT=B` on Core and Gateway, and on
   locally pinned applications. Roll Core, Gateway and all application processes.
   All processes can now read A and B, and still write A. Inspect status and
   confirm every live instance reports the intended ring.
2. Set `APP_SECRET=B`, remove NEXT, and set `APP_SECRET_PREVIOUS=A` on those
   environment consumers. Roll Core, Gateway and all applications again.
   Processes now write B and continue reading A.
3. Leave PREVIOUS configured while the applications automatically rewrap their
   own rows. Work runs in bounded pages during registry maintenance. Rewrap
   preserves plaintext, timestamps, revisions and expiry. A concurrent user
   write or cleared payload wins; conflicts are checked on a later pass.
4. Run `cld --profile operator admin secrets status --strict --expect mail,filesv2 --json`,
   replacing the example inventory with all expected application IDs. Wait for
   exit 0. Inspect per-instance rings and owner counts when the command exits 1.
5. From the last possible A writer, wait 24 hours for Files editor tokens and
   five minutes for Grids file previews. Restart listings that retain Grids or
   Files pagination cursors without expiry. Expire or reissue capability streams
   and third-party sessions according to their owning application's lifetime.
6. Prevent A-current instances, old deployment revisions and scheduled workers
   from returning. Rerun strict status immediately before removal. Remove
   PREVIOUS, then roll Core, Gateway and all applications again. Confirm strict
   status after this rollout too.

A returning A writer delays convergence: its current root differs and strict
status fails. The live registry cannot see dormant deployment templates, future
workers or external token holders. The operator owns those checks and the token
waiting period; exit 0 alone does not certify their retirement.

Connection-test signatures for object storage verify across the overlap. A check
signed only by A becomes **untested** after A is removed; run a fresh connection
test when you need a B-signed result.

## Read status and recover

`cld admin secrets status [--strict] [--expect <apps>] [--json]` reads Core's
administrator-only `GET /api/admin/secrets/status`. OAuth callers need `read` or
`admin`. This command never changes environment values or starts a manual
rotation job.

The inventory is the union of the live registry and comma-separated `--expect`
IDs. Core and Gateway are always included. Every observed replica must report
the same current root. Metadata contains root fingerprints, never roots or
derived signing keys. Per owner, it reports:

| Field | Meaning |
| --- | --- |
| `rows` | Retained rows containing at least one nonempty encrypted value in the completed pass |
| `previousOnly` | Rows still requiring the previous root, including unresolved CAS conflicts |
| `unreadable` | Rows with a value that no configured root can authenticate; they are never overwritten |
| `startedAt` | Start time of the completed owner's pass, or null before a successful pass |
| `checkedAt` | Completion time of the owner's pass, or null while no successful pass is available |

Strict readiness requires every declared owner to have zero previous-only and
unreadable rows. Each completed pass must have started after the latest reported
ring change of any instance plus the three-minute registry instance TTL. This
allows old instance leases to drain before the pass starts; finishing an earlier
pass after that deadline is insufficient. A process restart conservatively starts
a new ring observation. Missing processes,
missing declarations, differing declarations across replicas, invalid registry
records, failed checks and stale checks block readiness.

| Exit | Meaning |
| --- | --- |
| 0 | Status fetched successfully; with `--strict`, all reported instance and data conditions pass |
| 1 | With `--strict`, an instance or data condition is not ready or is unknown |
| 2 | Invalid usage, response schema, authentication or transport failure |

`ready` in JSON always states the strict result, even without `--strict`.
Rewrap retries automatically after an application restart or the next maintenance
heartbeat. A failed cache invalidation is retried even when its database update
already committed. Restore a missing root before investigating unreadable rows;
never replace a credential merely to clear the status.
An owner's maintenance failure is logged with its ID. Other owners continue on
their maintenance turns while the failed owner waits for its next retry.

## Keep recovery roots with backups

Keep A in your recovery secret store for as long as any retained backup contains
A-encrypted data. Removing A from the running deployment does not update old
backups. Restore the database with all roots its ciphertext needs, restart the
applications, and obtain fresh owner checks before removing a recovery root.
Settings caches are bound to the full ring, so changing it cannot reuse a value
decoded under another ring.
