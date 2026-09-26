# Files CLI

Files (`cld filesv2`) works with the user's personal and group storage in
Cloud and FreeIPA. Files (legacy) is a separate application with its own
commands. Check `cld apps list --json` and `cld filesv2 help` before using the
commands.

## Address files

A file argument is `<area>:/path` or a file ID:

- `me` is the user's personal area: `me:/Documents/report.pdf`.
- A group area is its exact group name or its group ID: `team:/Shared`.
- A full area ID from `cld filesv2 ls --json` also works:
  `cloud:groups:<uuid>:/Shared`. It is the only way to reach a group area that
  `ls` hides, such as a personal Linux group, or a group named `me`.
- A file ID is the `resourceId` from `stat --json` or the `filesv2.entry` ref
  from the capability catalog. It always resolves and needs no area.
- `me:` and `me:/` are the area root. A trailing `/` names a folder to put
  entries into (`put`, `mv`).

Names are matched exactly. When a name matches more than one area, such as a
Cloud and a FreeIPA group both called `ops`, the command fails with exit code 1,
status 409 in `--json` mode, and lists every candidate as
`storage/kind/name (area-id)`. Retry with one of the IDs. Nothing is guessed.
Arguments that start with `/`, `./`, `../`, or `~` are local paths.

```bash
cld filesv2 ls --json                                  # your areas
cld filesv2 ls me:/Documents --json                    # one folder page
cld filesv2 ls me:/Documents --after '<next>' --json
cld filesv2 tree team:/Projects --depth 2 --json
cld filesv2 stat me:/Documents/report.pdf --json
cld filesv2 cat me:/Notes/todo.md
cld filesv2 search me:/Documents report --json
```

## Commands

| Command | Does | `--json` result |
| --- | --- | --- |
| `ls` | Lists the areas you can use | `{items, issues, editor}`; `items[]` are areas with `id`, `name`, `kind` (`users` is `me`), `area` (storage: `cloud` or `freeipa`), `status`, `reason` |
| `ls <folder>` | Lists one folder page | `{base, path, items, next}` |
| `tree <folder> [--depth 3]` | Lists a folder and its subfolders, following every page | `{base, path, depth, items}`; items carry `depth` |
| `stat <file>` | Shows details | `{base, entry, favorite, resourceId}` |
| `cat <file> [--out <local>]` | Prints a UTF-8 text file | `{baseId, path, bytes, content}`; with `--out`, `{path, bytes}` |
| `get <remote> [<local>]` | Downloads a file, or a folder as ZIP | `{path, bytes}` |
| `zip <remote>... --out <local>` | Downloads several entries of one area as ZIP | `{path, bytes}` |
| `put <local> <remote> [--parents] [--replace]` | Uploads a file | `{base, entry}` |
| `mkdir [-p] <folder>` | Creates a folder | `{base, entry}` |
| `mv <source>... <destination>` | Renames or moves inside one area | `{base, entries, results}` |
| `cp <source>... <folder>` | Copies into a folder of any area | `{base, entries, results}` |
| `rm <entry>... --yes` | Moves entries to the trash | `{entries, results}` |
| `search <folder> <query>` | Searches names below a folder | `{base, path, query, scope, items, next}` |
| `trash list <area>` | Lists the trash | `{entries, next}` |
| `trash restore <area> <trash-id> [--to <path>]` | Restores an entry | `{base, entry}` |
| `versions list <file>` | Lists versions | array of `{id, created, size, pinned, comment, author}` |
| `versions get <file> <version-id> <local>` | Downloads a version | `{path, bytes}` |
| `versions restore <file> <version-id> [--as <name>]` | Restores a version | `{base, entry}` |
| `versions update <file> <version-id> --comment <text>` | Sets a version comment | the version |
| `shares list` | Lists your links | `{items, next}` |
| `shares add <entry>... --title <title>` | Creates a link or inbox | the share, with `url` once |
| `shares rm <share-id> --yes` | Revokes a link | the share, `state: "revoked"` |
| `recent`, `favorites list` | Lists marked entries | array of `{base, entry, markedAt}` |
| `favorites add <entry>`, `favorites remove <entry>` | Marks or unmarks | `{favorite}` |
| `documents create <file> --kind <kind>` | Creates an empty document | `{base, entry}` |
| `edit-url <file>` | Prints the editor address | `{url}` |
| `thumbnail <image> <local> [--size small]` | Saves an image preview | `{path, bytes}` |
| `templates list`, `templates show <id>`, `templates use <id> <file>` | Finds and uses templates | the page, template, or `{base, entry}` |

`--jsonl` prints one item per line for list commands, without the page or
cursor. Warnings go to stderr in every mode. A command exits `0` only when it did
everything; a multi-entry `mv`, `cp`, or `rm` with a failed item exits `1` after
printing all `results`. Successful items are not rolled back; retry only the
failed paths.

## Browse and search

`ls <folder>` returns one page. Pass its `next` unchanged as `--after` until it
is null, keeping the folder, sort, and filters. `ls` and `search` accept
`--sort name|modified|size`, `--order asc|desc`, `--type all|files|directories`,
and `--no-group-folders`. Defaults are name ascending, all entries, and folders
before files across pages. A `cursor_invalid` error means: restart without
`--after`.

`tree` follows every page down to `--depth` levels (default 3). It fails
instead of truncating when the result exceeds 10,000 entries, the server's scan
budget for one listing; choose a narrower folder or a lower depth.

`search <folder> <query>` matches name fragments below the folder, recursively;
`--scope folder` limits hits to its direct entries. Storage without an index is
scanned and fails with `search_limited` when a folder holds too many entries, so
narrow the folder. FreeIPA search uses Unix-scoped live filesystem scans. An
unreadable subtree fails the entire search. Continuations return 403 for revoked
access or 404 for externally removed results; restart without `--after`.

Missing, conflicting, or unknown storage is an error, never an empty folder;
unknown statistics remain null.

## Transfer files

```bash
cld filesv2 get me:/Documents/report.pdf                 # ./report.pdf
cld filesv2 get me:/Documents/report.pdf ./downloads/    # into a local folder
cld filesv2 get team:/Photos ./photos.zip                # a folder as ZIP
cld filesv2 zip me:/Documents me:/Photos/team.jpg --out ./selection.zip
cld filesv2 cat me:/Notes/todo.md
cld filesv2 put ./report.pdf me:/Documents/
cld filesv2 put ./report.pdf team:/2026/Q3/report.pdf --parents
cld filesv2 put ./report.pdf me:/Documents/report.pdf --replace --expected-revision '<revision>'
```

Downloads obtain a short-lived lease through the authenticated Cloud API, then
stream directly from Filegate. The Filegate public URL must be reachable from the
machine running the CLI. The CLI never sends Cloud credentials to Filegate and
never prints the lease. It writes to a new file only: existing files and
symlinks are never overwritten, and a failed, truncated, or interrupted transfer
leaves no output file. Retry by running the command again. Without `<local>`,
`get` uses the remote name (`<folder>.zip` for a folder) in the working
directory.

`cat` prints UTF-8 text up to 50 MiB, the same budget as the `content.read`
capability. It refuses binary content and larger files before printing
anything; use `get` or `cat --out` for those.

`put` opens a Filegate upload session through Cloud, streams disk-backed
segments to the session lease without Cloud credentials, and commits through
Cloud. A remote that ends in `/` or is an area root receives the local file
name. Existing files fail with `path_conflict` unless `--replace` is passed.
`--parents` creates missing parent folders first. For conditional saves, read
`stat --json` and pass its `entry.revision` as `--expected-revision`; a stale
revision is a conflict. Unmanaged observation tokens use `fs:<modified>:<size>`
and are not atomic filesystem preconditions. `idempotency_conflict` means the
upload ID was reused with different parameters; inspect the original operation.
`operation_conflict` and `write_conflict` do not authorize overwriting.
Retries and lease renewal are bounded; interruption before commit requests an
abort. The CLI stores one logical upload ID in its active profile before
requesting a session. Repeating the same command with unchanged local file
metadata, target, and conflict policy reuses it. Terminal receipts last seven
days; after that, an uncertain outcome needs inspection rather than a new ID.

## Organize files

```bash
cld filesv2 mkdir -p me:/Documents/2026/Q3
cld filesv2 mv me:/Documents/draft.txt me:/Documents/final.txt
cld filesv2 mv me:/Documents/a.txt me:/Documents/b.txt me:/Archive/
cld filesv2 cp me:/Documents/report.pdf team:/Shared/
cld filesv2 rm me:/Documents/old.txt --yes
cld filesv2 trash list me --json
cld filesv2 trash restore me <trash-id> --json
cld filesv2 trash restore me <trash-id> --to /Documents/recovered.pdf --json
```

`mkdir` creates one folder below an existing parent and fails on an existing
name. `mkdir -p` (`--parents`) creates every missing folder and accepts an
existing folder, but not an existing file.

The last `mv` argument is the destination. An existing folder, a trailing `/`,
or several sources move the sources into that folder. Otherwise, the single
source is renamed in its folder. `mv` never overwrites and never leaves its
area; combine `cp` and `rm` for that, and move and rename in two steps. `cp`
copies into a folder of the same or another area and keeps the names and the
originals. Cloud-to-FreeIPA and FreeIPA-to-Cloud copies use independent
authorized source and destination execution contexts.

`rm` needs `--yes`. It moves entries to their area's trash and returns the
restorable trash IDs. Permanent deletion is an administrator operation
(`admin files rm`); there is no user-level purge. Trash lists include pending
moves and filesystem entries without Cloud records; an unknown `original` or
`deletedAt` is null. `trash restore --to` takes a full path inside the same
area, including the name, and is required when the original location is
unknown. Restore never overwrites an existing destination.

## Versions

```bash
cld filesv2 versions list me:/Documents/report.pdf --json
cld filesv2 versions get me:/Documents/report.pdf <version-id> ./report-v1.pdf
cld filesv2 versions restore me:/Documents/report.pdf <version-id>
cld filesv2 versions restore me:/Documents/report.pdf <version-id> --as report-v1.pdf
cld filesv2 versions update me:/Documents/report.pdf <version-id> --comment "Sent to the board"
```

`versions restore` without `--as` replaces the current content and keeps the
current state as a new version. `--as <name>` writes the historical bytes next
to the file without changing the original. There is no user-level version
deletion.

## Shares and inboxes

```bash
cld filesv2 shares add me:/Documents/report.pdf --title "Report" --expires-in 7d --json
cld filesv2 shares add team:/Incoming --kind inbox --title "Send files" --expires-in 7d --max-file-size 104857600 --max-total-size 1073741824 --public-note "Send your documents here" --json
cld filesv2 shares add me:/Documents --title "Documents" --password-file ./password.txt --json
cld filesv2 shares list --after '<next>' --json
cld filesv2 shares rm <share-id> --yes --json
```

`--kind download` (default) shares the listed entries of one area; `--kind
inbox` shares exactly one folder as an anonymous upload target. Both print the
public URL once, on creation only; treat that response as a secret. `shares
list` returns only your own links and never returns the URL again (`url` is
null). `shares rm` revokes a link at once; it stays listed with `state:
"revoked"`. Creators can revoke their links after losing file access.

Read a password with `--password-file`. The UTF-8 file must contain 8–256
characters; one trailing line ending is removed. Keep the file private, send the
password separately, and never put a password in an argument. Lists expose only
`passwordProtected`. `--expires-in` accepts `1d`, `7d`, `30d` (default), `90d`,
or `unlimited`. `--note` stays private; `--public-note` is shown to visitors.
Inbox limits are bytes: 100 MiB per file and 1 GiB total by default; total means
confirmed bytes plus pending reservations, and deleting files does not
replenish it. `--show-upload-names` shows visitors only the names of successful
uploads through that inbox. Download shares include later additions to shared
folders. Public actions recheck the creator's current access.

## Recent, favorites, documents, and templates

```bash
cld filesv2 recent --json
cld filesv2 favorites add me:/Documents/report.pdf
cld filesv2 documents create me:/Documents/Minutes --kind text
cld filesv2 documents create me:/Notes/ideas.md --kind markdown
cld filesv2 edit-url me:/Documents/Minutes.odt
cld filesv2 templates list --search Minutes --json
cld filesv2 templates show <template-id> --json
cld filesv2 templates use <template-id> me:/Documents/Minutes.odt
cld filesv2 thumbnail me:/Photos/team.jpg ./team-preview.png --size large
```

`recent` lists entries the user opened or downloaded (newest first, at most
30); favorites are explicit marks. Both resolve their area on every read and
check current access. A favorite can be removed after the file is gone.

`documents create` with `text`, `spreadsheet`, or `presentation` needs Collabora
configured by an administrator and appends the configured format's extension
(`odt`/`ods`/`odp` or `docx`/`xlsx`/`pptx`); `markdown` needs a `.md` path. It
fails with `path_conflict` when the file exists. `edit-url` prints the Cloud
address that opens the browser editor; editing happens in the browser.
`templates use` creates an independent file, never overwrites, and requires
write access to the destination. `thumbnail --size` is `small` (320 px) or
`large` (1024 px); unsupported images return an error.

## Capability lists and on-demand download links

Read the live capability catalog before composing a Studio list or CLI workflow:

```bash
cld capabilities query filesv2 bases.list --input '{}' --json
cld capabilities query filesv2 entry.list --input '{"baseId":"<returned-area-id>","path":"Documents"}' --json
cld capabilities query filesv2 content.download --input '{"id":"<filesv2.entry-ref-id>"}' --json
```

`entry.list` and `entry.search-in-base` return `data.items` with a qualified
`filesv2.entry` ref next to each entry. Its `id` is the same file ID that the
CLI accepts. Continue with `data.next` as `after` until null. Lists do not
issue download leases. Refs are stable for an area and path, including long
paths; rename or move changes them, replacing content at the same path does
not. They grant no access.

Only request `content.download` when downloading a selected file. The result's
`data` is `{url,method:"GET",expires}`; the bearer URL is valid for 60 seconds.
This explicit capability command prints the private URL, unlike `cld filesv2
get`; do not log it or save it in shared state. For a local file, prefer `cld
filesv2 get`. For code analysis, use `content.read` with the capability stream
commands.

Each new lease rechecks current access, including FreeIPA Unix permissions.
403 is denied; 404 is missing or no longer visible; `not_file` (400) rejects
folders. `identity_changed` (409) requires refreshing access or identity state.
After expiry or a failed transfer, request a fresh lease. If access is denied,
stop. Do not create public shares or construct storage URLs.

## Administer storage

These commands require a Cloud administrator account and use the same server
authorization as the administration UI. `--storage` is `cloud` (default) or
`freeipa`; `--kind` is `users` (default) or `groups`.

```bash
cld filesv2 admin inventory --storage cloud --kind users --json
cld filesv2 admin inventory --storage freeipa --kind groups --status orphaned --search alumni --after '<next>' --json
cld filesv2 admin configuration get --json
cld filesv2 admin adopt <identity-uuid> --storage cloud --kind users --yes --json
```

Inventory includes configuration, availability, the current root's
capabilities and statistics, one page of directory entries, `next`, and
`issue`. `--search` and `--status` filter on the server; pass the same filters
when following a cursor; `--search` matches display names, names, and paths.
Entries include `uid`, `gid`, `displayName` (the account or group display name,
`null` when no identity exists for the directory name), and the currently
allowed `actions`. Statuses are `existing`, `missing`, `unassigned`,
`conflict`, `unknown`, `orphaned`, and `retired`. File and directory counts and
byte totals are known only for complete observed scans; `observation` exposes
`complete`, `freshness`, `source`, `started`, `completed`, and `indexBuilt`.
Root statistics cover the whole root, including when a prefix is configured.
An unknown state does not prove an identity or directory was deleted.

Before `admin adopt`, inspect the inventory entry and verify its `identityId`,
`path`, and `actions.adopt`. Adoption binds an existing directory to its
current eligible identity and leaves its files in place. Read inventory again
afterward.

### Address directories

Administrator file commands address a directory, not an area:

- `<storage>/<users|groups>/<name>` for a current directory, for example
  `cloud/groups/team`, with the exact name from inventory;
- `<storage>/archive/<archive-id>` for an archived directory;
- followed by `:/path` for an entry inside it: `cloud/groups/team:/trash/old.pdf`.

```bash
cld filesv2 admin files ls cloud/groups/team:/trash --json
cld filesv2 admin files ls freeipa/archive/<archive-uuid>:/Documents --after '<next>' --json
cld filesv2 admin files get freeipa/archive/<archive-uuid>:/Documents/report.pdf ./report.pdf --json
```

Unlike `ls`, `admin files ls` shows the reserved `trash` folder. It returns
`basePath`, the current relative `path`, entries, and `next`; entry paths are
relative to `basePath`. Downloads use the same direct lease and no-overwrite
rules as `get`.

### Create, archive, or retire a directory

```bash
cld filesv2 admin directories create <identity-uuid> --storage freeipa --kind groups --yes --json
cld filesv2 admin directories archive freeipa/groups/alumni --archive-path archiv --yes --json
cld filesv2 admin directories retire cloud/groups/alumni --yes --json
```

Check the inventory entry's `actions` first. FreeIPA creation uses the
identity's actual UID and GID and the configured modes. The server checks
eligibility and path boundaries again for every action. Archiving moves the
directory under the archive path, which is relative to the storage's configured
prefix; omit `--archive-path` to use the configured archive. Retirement leaves
the data and Unix permissions in place, blocks access through Files, and
prevents automatic recreation; administrators can still browse it.

Lifecycle responses include `{id, state, path}`. `state: "pending"` means the
operation is not complete; keep the ID and inspect inventory or the archive
again. Do not report completion based on the exit status alone.

```bash
cld filesv2 admin operations retry <operation-uuid> --yes --json
```

Use the operation result's `id`, or the `operationId` from inventory or a
pending archive entry. Retrying can complete the originally requested creation,
archival, restoration, or permanent deletion; confirm that the user still wants
it. The server rechecks administrator access, identity, configuration, and the
original source. A failed precondition does not authorize a different target.

### Archives

```bash
cld filesv2 admin archives list --storage freeipa --search alumni --after '<next>' --json
cld filesv2 admin archives restore <archive-uuid> --confirm-path '<originalPath>' --yes --json
```

Archive entries contain `id`, `path`, `originalPath`, `state`, `createdAt`,
`canRestore`, and `canDelete`. Restore requires the exact `originalPath`; the
server checks the destination before moving anything.

### Shares and uploads

```bash
cld filesv2 admin shares list --json
cld filesv2 admin shares rm <share-id> --yes --json
cld filesv2 admin uploads list --json
```

Administrators manage links independently of the creator's file access. Both
lists accept `--after`. `admin uploads list` shows unresolved inbox
reservations with the share ID, path, declared size, state, and error. A missing
session receipt is not proof of an abort; background reconciliation keeps
uncertain bytes reserved. Do not clear reservations manually.

### Permanently delete data

Only run these after an explicit user request to permanently delete the exact
target. They bypass the trash and require both `--yes` and `--confirm-path`:

```bash
cld filesv2 admin files rm cloud/groups/team:/trash/old.pdf --confirm-path '<basePath>/trash/old.pdf' --yes --json
cld filesv2 admin directories delete freeipa/groups/alumni --confirm-path '<inventory-path>' --yes --json
cld filesv2 admin archives delete <archive-uuid> --confirm-path '<archive-path>' --yes --json
cld filesv2 admin versions list cloud/groups/team:/Documents/report.pdf --json
cld filesv2 admin versions delete cloud/groups/team:/Documents/report.pdf <version-id> --confirm-path '<basePath>/Documents/report.pdf' --yes --json
```

Use the exact root-relative path, including any configured prefix. For an entry
in the admin browser, combine its `basePath` with the entry's relative `path`.
Whole-directory deletion uses the inventory `path`; archive deletion uses the
archive entry's current `path`, not `originalPath`. Never guess a path from a
display name. The server validates the confirmation again.

### Root metadata

```bash
cld filesv2 admin root refresh --storage cloud --json
cld filesv2 admin root rebuild --storage cloud --yes --json
```

Rebuild requires an enabled Filegate index and affects the entire root, even
when the storage uses a prefix. Do not replace unknown values with zero.

### Configuration

Read the configuration, edit the intended fields, then submit the complete
configuration. `get` exposes `tokenConfigured`, never the backend token. The
optional `collabora` block holds `url` (empty disables editing), `internalUrl`,
`wopiOrigin`, and `documentFormat` (`odf` or `ooxml`). Each storage block
contains `enabled`, `root`, `prefix`, `homes`, `groups`, and `archive`; the
top-level `url` is the Filegate backend URL. The Cloud block also contains
`autoCreate` (default `false`) and `autoArchive` (default `true`).

```bash
cld filesv2 admin configuration get --json > ./filesv2.json
# Edit ./filesv2.json before submitting it.
cld filesv2 admin configuration set --input-file ./filesv2.json --json
```

`set --stdin` also works. Inline `--input` is rejected so secrets stay out of
arguments. Omit `token` or leave it empty to keep the saved token; a nonempty
`token` replaces it. Saving replaces both storages' configuration; preserve
unrelated settings. Paths and prerequisites are validated by the server.

### Templates

- `cld filesv2 admin templates list --json` lists the complete catalog.
- `cld filesv2 admin templates upload ./Minutes.odt --name Minutes [--description ...]` stores an independent snapshot (one file, up to 20 MiB).
- `cld filesv2 admin templates import me:/Documents/Minutes.odt --name Minutes` snapshots an accessible file.
- `cld filesv2 admin templates update <id> --name Minutes [--description ...] [--file ./replacement.odt]` replaces metadata and optionally the snapshot; an omitted description becomes empty.
- `cld filesv2 admin templates replace <id> ./Minutes.odt` replaces only the snapshot.
- `cld filesv2 admin templates delete <id> --yes` removes the template and its grants.
- `cld filesv2 admin templates access list <id> --json` reads grants.
- `cld filesv2 admin templates access grant <id> --input-file ./grant.json` accepts `{"principal":{"type":"user","userId":"..."}}`, `group` with `groupId`, or `authenticated`; `--stdin` also works.
- `cld filesv2 admin templates access revoke <id> <access-id>` revokes future use.

Template grants are ordinary Cloud read permissions, independent of the
source's storage access. Changing a template never changes files created from
it. Snapshot bytes are in PostgreSQL and belong in database backups.
