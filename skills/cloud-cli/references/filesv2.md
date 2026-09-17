# Filesv2 CLI

Filesv2 combines accessible Cloud and FreeIPA homes and group directories.
Use `cld filesv2`; the older Files application is separate. Check
`cld apps list --json` and `cld filesv2 help` before using the commands.

## Browse and download

```bash
cld filesv2 bases list --json
cld filesv2 list <base-id> --json
cld filesv2 list <base-id> --path Documents --json
cld filesv2 list <base-id> --path Documents --after '<next>' --json
cld filesv2 download <base-id> Documents/report.pdf --out ./report.pdf --json
```

Use a base `id` returned by `bases list`, not a username or an absolute server
path. Paths are relative to that base. `list` returns one page; pass its `next`
unchanged as `--after` until it is null. There is no implicit recursive listing
or automatic pagination.

Prefer `--json` when you need the cursor, area issues, root statistics, or base
metadata. List commands emit one complete item per line with `--jsonl`, without
the surrounding page or cursor. Warnings use
stderr in all modes. Missing, conflicting, or unknown storage must not be
treated as an empty directory; unknown statistics remain null.

Downloads first obtain a short-lived lease through the authenticated Cloud API,
then stream directly from Filegate. The Filegate public URL must be reachable
from the machine running the CLI. The CLI does not send Cloud credentials to
Filegate or print the lease. Success returns `{path, bytes}`. `--out` is required;
existing files and symlinks are never overwritten. Failed or interrupted
transfers leave no completed output file. Retry by running the command again.
Binary content is saved to disk, not stdout.

## Administer storage

These commands require a Cloud administrator account and use the same server
authorization as the administration UI.

```bash
cld filesv2 admin inventory --area cloud --kind users --json
cld filesv2 admin inventory --area freeipa --kind groups --json
cld filesv2 admin inventory --area freeipa --kind groups --after '<next>' --json
cld filesv2 admin inventory --area freeipa --kind groups --status orphaned --search alumni --json
cld filesv2 admin configuration get --json
cld filesv2 admin adopt <identity-uuid> --area cloud --kind users --yes --json
```

`--area` defaults to `cloud`; `--kind` defaults to `users`. Inventory includes
configuration, availability, the current root's capabilities/statistics, one
page of directory entries, `next`, and `issue`. `--search` and `--status` filter
on the server; pass the same filters when following a cursor. Entries include
`uid`, `gid`, and the current allowed `actions`. Statuses are `existing`,
`missing`, `unassigned`, `conflict`, `unknown`, `orphaned`, and `retired`.
Root statistics cover the whole
root, including when a relative prefix is configured. FreeIPA directories
created outside Cloud are recognized through the filesystem. An unknown state
does not prove an identity or directory was deleted.

Before `admin adopt`, inspect the matching inventory entry and verify its
`identityId`, `path`, and `actions.adopt`. This binds an existing directory to its
current eligible identity and leaves its files in place. It does not create
directories. Use it only when the user authorized the assignment; `--yes`
confirms the operation. Read inventory again afterward.

## Create, archive, or retire a directory

```bash
cld filesv2 admin directories create <identity-uuid> --area freeipa --kind groups --yes --json
cld filesv2 admin directories archive alumni --area freeipa --kind groups --archive-path archiv --yes --json
cld filesv2 admin directories retire alumni --area cloud --kind groups --yes --json
```

Use the exact identity UUID or directory name from inventory, and check the
corresponding `actions` flag first. FreeIPA creation uses the identity's actual
UID/GID and configured modes. The Cloud backend checks eligibility and path
boundaries again for every action.

Archiving moves the directory under the chosen archive path, which is relative
to the area's configured prefix. Omit `--archive-path` to use that area's
configured archive. Retirement leaves the data and Unix permissions in place,
blocks user access through Filesv2, and prevents automatic recreation.
Administrators can still browse it.

Lifecycle responses include `{id, state, path}`. `state: "pending"` means the
operation is not complete; keep the returned ID and inspect inventory or the
archive again. Do not report a completed creation, move, or deletion based on
command exit status alone. Inventory can report `operation_pending` with an
`operationId`, and the archive listing includes pending entries.

```bash
cld filesv2 admin operations retry <operation-uuid> --yes --json
```

Use the operation result's `id`, or the `operationId` returned by inventory or
a pending archive entry. Retrying can complete the originally requested creation,
archival, restoration, or permanent deletion; verify that the user still wants
that operation. The server checks current administrator access, identity,
configuration, and the original source before resuming. A failed precondition
does not authorize a different target. Inspect the returned `state` and refresh
inventory or archives afterward; a successful request can remain `pending`.

## Inspect and restore archives

```bash
cld filesv2 admin archives list --area freeipa --json
cld filesv2 admin archives list --area freeipa --search alumni --after '<next>' --json
cld filesv2 admin files list --area freeipa --archive-id <archive-uuid> --json
cld filesv2 admin files list --area freeipa --archive-id <archive-uuid> --path Documents --json
cld filesv2 admin files download Documents/report.pdf --area freeipa --archive-id <archive-uuid> --out ./report.pdf --json
cld filesv2 admin archives restore <archive-uuid> --confirm-path '<originalPath>' --yes --json
```

Archive entries contain `id`, `path`, `originalPath`, `state`, `createdAt`,
`canRestore`, and `canDelete`. Restore requires the exact `originalPath` from
that entry; the server checks the destination before moving anything. Archive
downloads use the same direct Filegate lease and local no-overwrite behavior
as ordinary downloads.

The administrator file browser also accepts current directories:

```bash
cld filesv2 admin files list --area cloud --kind groups --name team --path trash --json
cld filesv2 admin files download trash/old.pdf --area cloud --kind groups --name team --out ./old.pdf --json
```

Choose exactly one target: `--name` with `--kind`, or `--archive-id`. Unlike the
normal user browser, the admin browser can inspect reserved `trash` contents.
It returns `basePath`, the current relative `path`, entries, and `next`. Entries'
paths are relative to `basePath`.

## Permanently delete data

Only perform these commands after an explicit user request to permanently
delete the exact target. They bypass trash and require both `--yes` and
`--confirm-path`:

```bash
cld filesv2 admin files delete trash/old.pdf --area cloud --kind groups --name team --confirm-path '<basePath>/trash/old.pdf' --yes --json
cld filesv2 admin directories delete alumni --area freeipa --kind groups --confirm-path '<inventory-path>' --yes --json
cld filesv2 admin archives delete <archive-uuid> --confirm-path '<archive-path>' --yes --json
```

Use the exact root-relative path, including any configured prefix. For a file
or folder within the admin browser, combine its returned `basePath` with the
entry's relative `path`. Whole-directory deletion uses the inventory `path`;
archive deletion uses the archive entry's current `path`, not `originalPath`.
Never guess a path from a display name. The server validates the confirmation
again. Refresh the relevant listing after the operation.

## Refresh root metadata

```bash
cld filesv2 admin root refresh --area cloud --json
cld filesv2 admin root rebuild --area cloud --yes --json
```

Refresh reads current root statistics. Rebuild is an administrative index
operation and requires an enabled Filegate index. It affects the entire root,
even if the Cloud area uses a prefix. Check the returned capabilities and
statistics; do not replace unknown values with zero.

## Change configuration

Read the current configuration, edit the intended fields, then submit the
complete configuration. `get` exposes `tokenConfigured`, never the backend
token. Each area contains `enabled`, `root`, `prefix`, `homes`, `groups`, and
`archive`; the top-level `url` is the Filegate backend URL. The Cloud area also
contains `autoCreate` (default `false`) and `autoArchive` (default `true`). These
control local directory creation and archival of orphaned local directories.
FreeIPA provisioning remains manual and has no automation switches.

```bash
cld filesv2 admin configuration get --json > ./filesv2.json
# Edit ./filesv2.json before submitting it.
cld filesv2 admin configuration set --input-file ./filesv2.json --json
cld filesv2 admin configuration get --json
```

`set --stdin` is also supported. Inline `--input` is rejected so secrets stay
out of command arguments. Omit `token` or leave it empty to retain the saved
token. A nonempty `token` replaces it; protect any input file containing it and
do not print its contents. `tokenConfigured` from `get` is ignored on input.
Saving replaces both areas' configuration; preserve unrelated settings.

Cloud storage requires local Linux identities. Only POSIX groups have group
storage. FreeIPA storage requires enabled FreeIPA and works independently.
Paths and prerequisites are validated by the server. Uploads, user trash
operations, public sharing, and inbox commands are not implemented yet.
