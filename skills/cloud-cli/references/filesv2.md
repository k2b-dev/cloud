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
cld filesv2 search <base-id> report --path Documents --json
cld filesv2 mkdir <base-id> Documents/2026 --json
cld filesv2 upload <base-id> ./report.pdf --to Documents/report.pdf --json
cld filesv2 rename <base-id> Documents/report.pdf report-2026.pdf --json
cld filesv2 move <base-id> Documents/a.txt Documents/b.txt --to Archive --json
cld filesv2 copy <base-id> Documents/a.txt --to Shared --target-base <other-base-id> --json
cld filesv2 delete <base-id> Documents/old.txt --json
cld filesv2 trash list <base-id> --json
cld filesv2 trash restore <base-id> <trash-id> --json
cld filesv2 versions list <base-id> Documents/report.pdf --json
cld filesv2 versions restore <base-id> Documents/report.pdf <version-id> [--as report-v1.pdf] --json
cld filesv2 shares create <base-id> Documents/report.pdf --title "Report" --expires-in 7d --json
cld filesv2 shares list --json
cld filesv2 shares revoke <share-id> --json
cld filesv2 stat <base-id> Documents/report.pdf --json
cld filesv2 thumbnail <base-id> Photos/team.jpg --size small --out ./team-preview.png --json
cld filesv2 download <base-id> Documents/report.pdf --out ./report.pdf --json
cld filesv2 documents create <base-id> Documents/Minutes --kind text --json
cld filesv2 edit-url <base-id> Documents/Minutes.odt
cld filesv2 archive <base-id> Documents Photos/team.jpg --out ./selection.zip --json
cld filesv2 versions download <base-id> Documents/report.pdf <version-id> --out ./report-v1.pdf --json
cld filesv2 recent --json
cld filesv2 favorites list --json
cld filesv2 favorites add <base-id> Documents/report.pdf --json
cld filesv2 favorites remove <base-id> Documents/report.pdf --json
```

`recent` lists entries the user opened or downloaded (newest first, at most
30); `favorites` are explicit marks. Both resolve their base on every read and
check current file existence and access before returning live metadata. Favorites
can be removed even when the marked file is gone or inaccessible. `search --scope folder` limits hits to
direct children of `--path`.

`documents create` needs Collabora configured by an administrator; it appends
the extension of the configured format (`odt`/`ods`/`odp` or
`docx`/`xlsx`/`pptx`) and fails with `path_conflict` when the file exists.
`edit-url` prints the Cloud address that opens a file in the browser editor;
editing itself happens in a browser, not in the CLI.

Use a base `id` returned by `bases list`, not a username or an absolute server
path. Paths are relative to that base. `list` returns one page; pass its `next`
unchanged as `--after` until it is null. There is no implicit recursive listing
or automatic pagination.

Both `list` and `search` support `--sort name|modified|size`, `--order asc|desc`,
and `--type all|files|directories`. Defaults are name ascending and all entries.
Folders are grouped before files across pages by default; pass
`--no-group-folders` for one mixed order. Keep these options, the path, and any
search query/scope unchanged when following `--after`. A `cursor_invalid` error
means discard the previous pages and restart without `--after`.

```bash
cld filesv2 list <base-id> --path Documents --sort modified --order desc --type files --json
cld filesv2 search <base-id> report --sort size --order desc --no-group-folders --json
```

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

`search` matches name fragments below `--path` (recursively) and pages with
`--after`; storage without an index is scanned and fails with `search_limited`
when a folder holds too many entries, so narrow `--path`. FreeIPA search uses
Unix-scoped live filesystem scans, including on indexed roots. An unreadable
subtree fails the entire search. Continuations return 403 for revoked access
or 404 for externally removed results; restart without `--after` for a fresh
observation.
`mkdir` creates one
folder below an existing parent and never overwrites existing names.
`upload` opens a Filegate upload session through Cloud, streams the file to
the session lease without Cloud credentials, and commits through Cloud; the
result is `{base, entry}`. Existing targets fail with `path_conflict` unless
`--replace` is passed. `idempotency_conflict` means the upload ID was reused
with different parameters; inspect the original operation. Generic
`operation_conflict` and `write_conflict` do not authorize overwriting. The CLI reads disk-backed segments instead of loading the whole file into RAM.
Retries and lease renewal are bounded; interruption before commit requests an
abort. The CLI persists one logical upload ID in its active profile before
requesting a session. Repeating the same command with unchanged local file
metadata, target, and conflict policy reuses that ID; there is no `--upload-id`
flag. Cloud validates the bound write options and execution identity. A retained
completed result needs no further byte transfer. Terminal receipts last seven
days; after that, an uncertain outcome needs inspection rather than a new ID.
Successful completion or confirmed abort clears the local retry record.
`move` stays inside one base; `copy` may target another compatible base with
`--target-base` and keeps the originals. Cloud-to-FreeIPA and FreeIPA-to-Cloud
copies use independent authorized source and destination execution contexts
with Filegate 6.1. Cloud targets remain service-owned; FreeIPA targets receive
their Unix ownership. Different contexts require separate Filegate roots.
`delete` moves entries to the base's
trash and prints restorable trash IDs. Multi-entry mutations return
`results` per item (`path`, `ok`, and either `entry` or `error`) alongside
successful `entries`; partial failure sets a nonzero exit code. Successful
items are not rolled back. Retry only failed paths; a selected folder already
includes its selected descendants. `versions restore` without `--as`
replaces the current content (the current state is kept as a new version);
`--as <name>` copies historical bytes next to the file without changing the
original content, modification time, identity, or history. `shares create --kind
download` shares the listed entries, `--kind inbox` shares one folder as an
anonymous upload target; both print the public URL once, only on creation.
`stat` returns `{base, entry}` after checking current access, even when the entry
is outside the current listing page. `thumbnail` saves a generated image preview;
`--size` accepts `small` (320 px) or `large` (1024 px). It uses the same private
transfer and safe output-file rules as `download`. Unsupported images return an
error rather than an invented preview.

## Shares, inboxes, and trash

`shares list` returns only the caller's own shares and never returns the public
URL again (`url` is null). Creators can revoke their links after losing file
access. A parent-folder read permission does not expose other users' shares.
Existing URLs survive the token-hash migration; they cannot be recovered from
the database. Treat the creation response as a secret-bearing response.

```bash
cld filesv2 shares create <base-id> Incoming --kind inbox --title "Send files" --expires-in 7d --max-file-size 104857600 --max-total-size 1073741824 --public-note "Send your documents here" --json
cld filesv2 shares create <base-id> Documents --title "Documents" --expires-in unlimited --note "Private management note" --json
cld filesv2 shares list --after '<next>' --json
cld filesv2 trash list <base-id> --after '<next>' --json
cld filesv2 trash restore <base-id> <trash-id> --to Documents/recovered.pdf --json
```

`--expires-in` accepts `1d`, `7d`, `30d` (default), `90d`, or `unlimited`.
`--note` stays private; `--public-note` is shown to anonymous visitors. Inbox
limits are bytes: 100 MiB per file and 1 GiB total by default, including existing
inboxes upgraded from the previous schema. Total means cumulative confirmed
bytes plus pending reservations; deleting files does not replenish it.
`--show-upload-names` exposes only names of successful uploads through that
inbox, never existing folder contents or download access. It is off by default.
Download shares include current contents of shared folders, including later
additions. New public actions recheck the creator's current access.

Trash lists include pending moves and filesystem entries without Cloud records.
An unknown `original` or `deletedAt` is null. Use `--to` with a full base-relative
destination including the name when the original location is unknown. Restore
never overwrites an existing destination. An unresolved result requires inspection;
command success alone does not confirm the filesystem move.

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
Root capabilities include `managed` and `executionEnabled`. File/directory
counts and byte totals are known only for complete observed scans. The
`observation` field exposes `complete`, `freshness`, `source`, `started`,
`completed`, and `indexBuilt`; these are scan observations, not atomic quotas.
Root statistics cover the whole root, including when a prefix is configured.
FreeIPA directories
created outside Cloud are recognized through the filesystem. An unknown state
does not prove an identity or directory was deleted.

Before `admin adopt`, inspect the matching inventory entry and verify its
`identityId`, `path`, and `actions.adopt`. This binds an existing directory to its
current eligible identity and leaves its files in place. It does not create
directories. Use it only when the user authorized the assignment; `--yes`
confirms the operation. Read inventory again afterward.

Administrators also manage shares independently of the creator's file access:

```bash
cld filesv2 admin shares list --json
cld filesv2 admin shares revoke <share-id> --json
cld filesv2 admin uploads list --json
```

Both lists accept `--after`. `admin uploads list` exposes unresolved inbox
reservations with the share ID, path, declared size, state, and error. A missing
session receipt is not proof of an abort. The background reconciliation keeps
uncertain bytes reserved and continues after link expiry or revocation; do not
manually clear reservations without establishing what happened to the file.

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
cld filesv2 admin versions list Documents/report.pdf --area cloud --kind groups --name team --json
cld filesv2 admin versions delete Documents/report.pdf <version-id> --area cloud --kind groups --name team --confirm-path '<basePath>/Documents/report.pdf' --yes --json
```

Use the exact root-relative path, including any configured prefix. For a file
or folder within the admin browser, combine its returned `basePath` with the
entry's relative `path`. Whole-directory deletion uses the inventory `path`;
archive deletion uses the archive entry's current `path`, not `originalPath`.
Version deletion also requires the exact file path and version ID. There is no
end-user `versions delete` command. Never guess a path from a display name. The server validates the confirmation
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
token. The optional `collabora` block holds `url` (browser-facing Collabora
address, empty disables editing), `internalUrl`, `wopiOrigin` and
`documentFormat` (`odf` or `ooxml`). Each area contains `enabled`, `root`, `prefix`, `homes`, `groups`, and
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
storage. FreeIPA storage requires enabled FreeIPA and Filegate Unix execution, and works
independently. Managed roots enable atomic publication checks only when every
writer uses Filegate; leave managed mode off with external writers. No Cloud
configuration flag changes these Filegate capabilities.
Paths and prerequisites are validated by the server. Public share and inbox
pages have no CLI: anonymous visitors use the browser links that `shares create` prints.
