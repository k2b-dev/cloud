---
title: Filesv2
navTitle: Filesv2
section: Work
order: 151
description: Browse Cloud and FreeIPA storage, manage directories, and download files directly through Filegate.
tags: [files, storage, freeipa, filegate]
updated: 2026-09-20
---

# Filesv2

Filesv2 is a separate application for personal and group storage. It presents
Cloud and FreeIPA directories in one file browser. Administrators manage
directory creation, assignments, and archives separately from everyday browsing.
File transfers use short-lived Filegate 6 leases.

The details panel shows five text lines or CSV data rows, followed by the number
of remaining lines. Open the expanded preview to read more; CSV tables paginate
through 200 rows at a time. Existing preview size and column limits still apply.

A readable `README.md` in the current folder appears below the view controls and above list and grid
content, without a frame, with compact headings, tighter paragraph spacing, and a fixed preview height of 20vh.
The preview reserves this space while loading to keep the file listing in place.
Tree view hides this preview and reserves no space; the README remains accessible as a normal file.
Folders without a readable README reserve no space. File-name matching ignores
case and is independent of the visible page and filters. If several variants
exist, `README.md` takes precedence, then `readme.md`, then the remaining names
in lexical order. Detection scans at most 10,000 immediate entries and omits the
README if that scan is incomplete. The file remains in the normal listing;
when the description overflows, a fade and **Show all** action appear at the bottom.
The action opens its full preview with normal-sized headings.

Open `/app/filesv2` to choose an accessible home or group directory from the
workspace sidebar. On mobile, the Cloud menu contains the same storage choices.
Switching storage, opening folders, and changing pages update the workspace
without reloading the whole page. Navigation and pagination stay in the URL,
so reloads and browser Back and Forward preserve your location.
Missing or inaccessible storage appears with its status rather than as an
empty directory.

## Browse, select, and preview

The sidebar is a folder tree per storage location with global file search and
**Shares** at the top; after every navigation exactly the current path is
expanded and each storage location ends with its **Trash** entry. The list is a flat striped list;
folders open on click (the opened folder's icon becomes a spinner, a leading
`..` row goes up), files open the details panel, and every row ends with an
info button. **List**, **Grid**, and **Tree** views and the grid tile size are remembered
per storage location in a cookie. Tree shows the storage from its root with the current
folder highlighted; clicking a folder name makes it current, clicking its icon
expands or collapses it. Moving between folders preserves loaded tree branches.
While ancestors load, or if their request fails, the current folder remains
visible; a failed tree request offers a retry. Sorting, filtering, or changing
the storage location rebuilds the tree with the new context. **Select** next to the entry count switches on
checkboxes in every view. Thumbnails are requested with bounded concurrency and
retried, because Filegate rejects parallel renders beyond its capacity.
Storage, folder, page, single selection, search query, and scope stay in the
URL. The **Sort and filter** icon button beside search groups **Sort by**,
**Order**, and **Type** in one menu. Sort by name, modification date, or size;
filter all entries, files, or folders. The default is name ascending, with folders
before files. **Group folders** is on by default; turn it off to sort files
and folders together. Grouping and sorting are remembered per storage location;
reset restores name ascending, all types, and grouping. The `..` row stays above
the entries regardless of grouping, sorting, or type filter. Sorting and filtering
apply before pagination. With grouping on, all folder pages come before file
pages; each group uses the selected order. These options stay in the URL.
An expired or invalidated cursor restarts at the first page with a notice.
Entries can be dragged onto folders or the
`..` row to move them (resting on a folder opens or expands it), and marked as
favorites. **Recent** and **Favorites** open compact sidebar menus on desktop
and dialogs from mobile navigation. Recent shows the latest entries with relative
times; favorites are alphabetical. Entries are checked against current access
and file existence when the menu opens. The outline star beside Preview and
Download in the details panel turns gold for a favorite; hover or keyboard focus
shows an X for removal. Tapping the selected star removes the favorite too. The current page is polled while the tab is visible so changes by
others appear without a reload. PDF and office files use file-type icons in lists and grids. Images retain
direct Filegate thumbnails; PDF contents remain viewable in the details panel.

Search always covers the subtree below the current folder; hits show their
path relative to it. Filesv2 also answers the universal
search under the `file` tag through the `filesv2.entry` resource type, and
each entry's Cloud reference can be copied from the details panel. A bounded or
failed search is reported explicitly rather than presented as a complete empty
result; narrow the folder or query when its search budget is exceeded.

Selections act through one **Actions** menu: direct download for one file, a
signed Filegate ZIP for several entries or folders, move into a new folder,
move, copy, public share, trash. Moves never leave a base. Copies can cross bases
including Cloud-to-FreeIPA and FreeIPA-to-Cloud copies. Filegate reads the
source under its authorized execution identity and publishes under the
destination identity. Cloud files belong to the service account; FreeIPA
copies receive the authorized Unix ownership and modes. Different execution
contexts require distinct Filegate roots. Deleting moves entries into the reserved
`trash` folder with a restorable record; only administrators empty it.
Renaming, duplicating and moving reuse Filegate transfers.

The details panel shows a preview hero (images enlarge into a dialog),
facts including the storage area, an action list, and, where the root keeps
versions, a versions section with comments (stored as version metadata),
download, restore in place, and restore as a new file. Restoring as a new file
uses Filegate's historical-copy operation and leaves
the original file, modification time, identity, and history unchanged. Permanent
version deletion is available only through the administrator file browser and CLI.

Uploads report progress in one toast and resolve name conflicts once per
batch (replace existing or upload only new). Uploads, folder uploads and new
files open a Filegate upload session per file: Cloud authorizes the target, the browser streams segments to the
session lease and renews it through Cloud, and Cloud commits after re-checking
the target. The client retains one upload ID for a retry, while Cloud records
the bound destination, write options, and execution identity before issuing the
session. Retrying that same upload recovers the existing session or its retained
result instead of publishing a second file. Filegate retains terminal receipts
for seven days; after that, a missing receipt remains an uncertain outcome.
Existing names ask before being replaced.

## Public shares

Both download links and upload inboxes support an optional password of 8–256
characters. Share the password separately from the link. Visitors must unlock
before seeing shared names or obtaining any transfer. Unlocking grants access
for twelve hours in that browser; expiry, revocation and the creator's current
permissions still apply. Reload the page to enter the password again after
access expires. Existing links remain accessible without a password.

Only an Argon2id verifier (including its random salt and parameters) is stored
in Postgres. Neither the password nor the verifier appears in share responses.
Unlock attempts are rate-limited. The browser receives an encrypted, share-scoped
HttpOnly cookie; transfers retain their existing short lease lifetime.


A share is either a download bundle of entries or an upload inbox for one
folder, always inside one base. Download shares show the current contents,
including later additions to shared folders. Visitors can browse those folders,
download individual files, or request a ZIP.

The creator manages their links under **Shares** at
`/app/filesv2?view=shares`; administrators can manage all links separately.
Reading a parent folder does not reveal someone else's shares. Creators can
revoke their own links even after losing access to the files. Before each new
public action, Cloud checks the creator's current account, membership, storage
configuration, binding, and target permissions. Revocation prevents new actions;
already issued leases retain their short remaining lifetime.

Copy the public URL when creating a share: it is shown only once. Cloud stores
a token hash and cannot recover the URL later. Existing URLs survive the token
migration, but cannot be copied again from the overview. Link lifetimes are
1, 7, 30 or 90 days, or **No expiry**; the default is 30 days. An internal note
stays private. A separate public note appears to visitors.

Inbox limits default to **100 MiB per file** and **1 GiB in total**. These defaults
also apply to existing inbox links after upgrade. Total usage is cumulative for
that link: deleting received files does not replenish it. Concurrent transfers
reserve their declared size before starting. Confirmed aborted or expired
sessions release their reservations; an uncertain outcome keeps its reservation
until reconciled. The administrator view lists unresolved transfers, including
after a link expires or is revoked.

Finish active uploads before upgrading. Older open sessions have no stored
backend address, so Cloud cannot safely match them to the currently configured
Filegate server. After upgrade they remain listed as unresolved, and their bytes
stay reserved even when the current server reports no matching session. They
cannot be reconciled automatically without that evidence. Changing the configured
address or deleting files does not release the reservation. If the remaining
budget is insufficient, the owner can revoke the affected link and create a new
inbox link with a fresh budget.

Inboxes hide uploaded names by default and show only the visitor's immediate
confirmation. Creators can opt to show the names of successful uploads through
that inbox. This never exposes pre-existing folder contents or grants download
access. Public uploads use short-lived Filegate sessions and never replace
existing files. Share, trash, and public name lists provide explicit pagination.

## Configure storage

Open `/admin/filesv2` for **Overview**, **Directories**, **Archive**,
**Shares**, and **Settings**. Overview shows the selected
root's capabilities and available storage measurements. Directories lists
identities and filesystem entries, with actions appropriate to each state.
Archive keeps removed storage available for inspection and recovery. Settings
contains the connection, storage paths, and local automation policy.
Directory filters and search share one toolbar; the archive has its own area
filter and search. Directory details show the full name, current state, root,
path, and relevant ownership information. Missing directories can also be
created from that dialog. The Overview refresh action updates root statistics
and reloads the view; index rebuilding remains a separate, confirmed action.

Each area has its own enabled state, named Filegate root,
optional relative prefix, and home, group, and archive subdirectories. The
backend token stays on the server. Saved credentials are not returned to the
browser. Settings changes remain a draft until saved. Discard returns to the
saved configuration. Disabling an area does not delete its directories or
assignments.

Filegate reports `managed` and `execution` independently for every root.
**Managed** means that all content and namespace writes use Filegate; it enables
atomic conditional publication against other Filegate operations. Keep it off
when another process or an NFS client writes directly. It does not block external
writers or make their writes atomic. Cloud reads these capabilities; it does not
provide duplicate activation switches.

FreeIPA roots require **execution** so Filegate performs file access using the
Cloud-resolved UID, primary GID, and supplementary groups. Configure the daemon's
privileged execution mode explicitly according to the Filegate operator guide;
an ordinary unprivileged deployment cannot switch identities. Missing execution
support prevents access instead of falling back to the daemon account. Execution
is distinct from ownership, indexing, and versioning. Verify the actual filesystem
and export permissions; numeric identity switching does not bypass them.

Use a dedicated browser-facing Filegate origin outside the scope of Cloud cookies.
Different ports alone do not isolate cookies. Direct ZIP downloads use a native
form that cannot suppress cookies for its destination. Keep the exact Cloud origin
in Filegate's CORS configuration. The SDK uses the configured backend address for
server-side transfers while browser leases retain Filegate's public origin.

Cloud storage requires enabled local Linux identities. FreeIPA storage requires
enabled FreeIPA and valid POSIX identities. The two areas work independently.
Only groups with a GID have file storage; logical groups remain available for
other Cloud features. Effective group memberships include nested groups and
allow FreeIPA users to access local Cloud groups.

Existing Cloud directories require explicit administrator assignment. For
FreeIPA, a directory at the expected configured path is recognized after its
identity and Unix permissions have been checked. It need not have been created
through Cloud. Durable assignments prevent a new account with a reused name
from inheriting a previous account's directory.

## Create and reconcile directories

Use **Create** beside a missing home or POSIX group directory. Cloud directories
belong to the Filegate service account; Filesv2 does not assign local Linux IDs
to those files. Optional automatic creation provisions missing Cloud storage
when an eligible user accesses it. It does not take over an existing unassigned
directory or recreate storage that an administrator has retired or archived.

FreeIPA creation is always explicit. Filesv2 supplies the identity's real UID
and primary GID for homes, or the group's GID for shared directories. Shared
directories use setgid and a default ACL so future subdirectories remain
traversable and ordinary files do not acquire execute permission. An existing
directory is inspected rather than overwritten or recursively chmodded.

The directory inventory can be searched and filtered by state. A directory
without a matching identity is an orphan only after an authoritative check.
For FreeIPA this check queries the upstream identity service independently of
Cloud's synchronization filters. The FreeIPA service account needs visibility
of all relevant identities. A failed check remains **Unknown**. Conflicting
ownership or a reused account name requires investigation before assignment.

## Archive, restore, and delete

Archiving moves a directory within the same Filegate root, into a unique entry
under the configured relative archive path. The archive path must remain inside
the area's prefix and outside its active home and group trees. Its private
container prevents ordinary Unix users from traversing archived data, while
the archived subtree retains its original ownership and ACLs for restoration.

The Archive view lets administrators inspect files, download individual files,
restore to the original path, or delete permanently. Restoration never
overwrites a directory already occupying the original path and requires a
matching, eligible current identity. Archived data remains inspectable when
that identity no longer exists. Permanent deletion
requires confirmation of the exact target path and removes its Filegate
history. The administrator browser can inspect the reserved `trash` directory;
ordinary users cannot perform permanent deletion.

Optional automatic archival applies only to previously assigned Cloud
directories whose local identity has been deleted or whose group is no longer
POSIX. It does not archive FreeIPA directories. Disabling an account category,
disabling local Linux identities, expiration, and temporary lookup failures do
not prove deletion. The background worker checks bounded batches every minute
and resumes incomplete directory operations. Larger installations can take
several batches to complete a pass. Explicitly disabling automatic archival is
respected when automatic creation is enabled.

Directory operations keep durable progress so a lost response can be reconciled
against the filesystem. An ambiguous or conflicting state remains visible for
administrator investigation instead of overwriting another directory.

User trash and restore operations also record their intent before moving data.
Each trashed entry gets a unique destination. Entries found directly in `trash`
remain visible after access checks even without a Cloud record; an unknown
original location requires an explicit restore path. Restore never overwrites
an existing destination. Pending or ambiguous moves remain visible for review.

Multi-entry moves, copies, and trash actions report results per item. Selecting
a folder and one of its children processes the folder once. Successful items
remain completed when another item fails; retry only the failed items. A batch
is not an atomic transaction.

## Understand the source of truth

The filesystem determines which files and directories exist. Filegate's index
is derived metadata, not a prerequisite for recognizing externally created
directories. An administrator can create a FreeIPA directory directly on the
storage server and then inspect it in Filesv2. A missing Cloud assignment must
not hide a valid directory.

Cloud identities determine who may use storage. Filesv2 checks current access
before each operation or lease. Filegate then enforces the bound FreeIPA Unix
identity during traversal, content reads, mutations, historical reads, and ZIP
streaming; it does not fall back to privileged reads. A denied ZIP entry fails
the archive rather than silently omitting a file.
The admin inventory distinguishes missing directories, unassigned directories,
conflicts, and unavailable checks. An identity missing from Cloud's filtered
FreeIPA mirror is not proof that it was deleted in FreeIPA.
FreeIPA directory listings and filename searches use the current filesystem
under the user's Unix identity, even when the root has an index. A new search
sees external changes without rebuilding the index. An unreadable subtree
fails the search instead of returning partial results. Each continuation
rechecks traversal and parent read permissions: revoked access fails with 403,
and an externally deleted result fails with 404. Restart the search without
a cursor for a fresh observation; never treat those failures as an empty page.
Inventory scans return a cursor when their time budget is exhausted. Slow or
cancelled FreeIPA checks remain unknown; they never authorize archival or
deletion. Use the next page to continue a partial scan.

## Edit office documents

Filesv2 opens text documents, spreadsheets and presentations (`odt`, `ods`,
`odp`, `docx`, `xlsx`, `pptx`) in Collabora Online for collaborative editing.
Administrators enable it in the Files v2 settings by entering the Collabora
address browsers load the editor from. Two optional advanced fields cover
deployments in which this application reaches Collabora under a different
address, or Collabora reaches Cloud under a different address than the public
one. Leaving the Collabora address empty disables editing without touching
existing files.

Once configured, office files open in an editor view that fills the main area,
and the plus menu offers a new text document, spreadsheet or presentation. New
documents start from an empty template in the configured default format:
OpenDocument unless the administrator selects Microsoft Office formats. Users
who may only read a FreeIPA file get the editor in view mode.

Collabora talks to Filesv2 through WOPI under `/api/filesv2/wopi`. The editor
token it receives names one user and one file and carries no rights: every
WOPI call resolves the user and the current permissions again, so revoked
access ends a session at its next call and no instance keeps editor state.
Document bytes move between Filegate and Collabora on the server side through
the configured backend address; the Filegate token never leaves the backend.
Every save replaces the file in Filegate, and the root's versioning policy
decides which saves become versions. On managed roots, saves bind a fresh
revision and Filegate atomically rejects a changed destination at publication.
Cloud serializes document publication, private upload commits, moves, and
version restores with the existing database root lock, shared with trash and
administrative lifecycle operations. Busy publications return a retryable error;
no process-local lock or extra lease state is required. WOPI timestamp checks
retain microsecond precision. Collabora's explicit **Overwrite** choice remains
supported, while changes during that save still conflict. Unmanaged roots also
recheck timestamp and size before writing. External NFS writers do not participate
in the Cloud lock and remain outside its guarantee.

The editor uses the Cloud theme when opened, even if Collabora saved a different
UI preference. An open Collabora editor keeps its initial theme; close and reopen
it after a theme change. It is never reloaded automatically while editing.

Several Collabora instances need sticky routing on the `WOPISrc` parameter,
which is a Collabora deployment concern; Filesv2 scales horizontally
unchanged.

## Download files

For each download, the browser requests a short-lived lease from Filesv2.
After authorization, Filegate sends the file directly to the browser. The full
Filegate token never appears in the lease. Disabling an area or removing access
prevents new leases; already issued leases retain their short remaining lifetime.

Filegate owns each root's index, versioning, managed, and execution configuration.
Filesv2 reads those capabilities independently for each root. Root file counts,
directory counts, and sizes are shown only for a complete observed scan;
incomplete totals or totals of unknown freshness remain unknown. Observation metadata identifies the source
and scan interval. These are not live quota measurements, and root totals must
not be interpreted as totals for a configured prefix.

## Use the CLI

The same operations are available through `cld filesv2`. Sign in with
`cld login --server <Cloud URL>`, then use a base ID from `bases list`:

```sh
cld filesv2 bases list --json
cld filesv2 list <base-id> --path Documents --sort modified --order desc --json
cld filesv2 download <base-id> Documents/report.pdf --out ./report.pdf --json
cld filesv2 documents create <base-id> Documents/Minutes --kind text --json
cld filesv2 edit-url <base-id> Documents/Minutes.odt
cld filesv2 recent --json
cld filesv2 favorites add <base-id> Documents --json
cld filesv2 shares list --after <next> --json
cld filesv2 admin shares list --json
cld filesv2 admin shares revoke <share-id> --json
cld filesv2 admin uploads list --json
cld filesv2 admin inventory --area freeipa --kind groups --json
cld filesv2 admin configuration get --json
cld filesv2 admin configuration set --input-file ./filesv2.json --json
cld filesv2 admin adopt <identity-uuid> --area cloud --kind users --yes
cld filesv2 admin directories create <identity-uuid> --area freeipa --kind groups --yes
cld filesv2 admin directories archive editors --area freeipa --kind groups --yes
cld filesv2 admin archives list --area freeipa --json
cld filesv2 admin files list --area freeipa --archive-id <archive-uuid> --json
cld filesv2 admin archives restore <archive-uuid> --confirm-path groups/editors --yes
```

Lists return one page. Use `--json` to preserve metadata and the `next` cursor;
pass that cursor unchanged as `--after` with the same query and sort options.
`list` and `search` accept `--sort name|modified|size`, `--order asc|desc`,
`--type all|files|directories`, and `--no-group-folders`.
`--jsonl` emits one complete item per
line for lists. Downloads stream directly to a new local file and never
overwrite an existing path; their structured result contains only `path` and
`bytes`. The CLI must be able to reach Filegate's public download address.

Administrator commands use the same permissions as the UI. Configuration
updates accept a complete JSON configuration through `--input-file` or
`--stdin`. Omitted or empty `token` keeps the existing secret; a nonempty value
replaces it. The read response contains only `tokenConfigured`. Inspect the
inventory entry before assigning its existing directory with `admin adopt`.
Use `cld filesv2 <command> --help` for the command's arguments.

`admin directories retire` stops Filesv2 access and automatic recreation while
leaving existing files and Unix permissions untouched. Use archival when access
through the filesystem must also be restricted. Administrator file commands
accept either a directory name and kind or an archive ID. They use the same
download leases as the ordinary file browser.

Permanent deletion commands require both `--yes` and `--confirm-path` matching
the complete path returned by the inventory or administrator browser. Do not
derive this confirmation from an unverified directory name. A pending result
means the action has not yet completed; inspect the current state and use
`admin operations retry <operation-id> --yes` to retry after resolving the cause.
Rebuild and statistics commands affect the entire Filegate
root, including paths outside the configured prefix.

Uploads read bounded file segments from disk and send them directly to Filegate,
with bounded retries and lease renewal. Cancellation requests an abort before
commit. Retrying the same command with the unchanged local file and destination
reuses the persisted upload identity within the receipt window. A lost commit
response may already represent a published file; do not switch to a new upload
identity to bypass an uncertain result.

## Current scope

This version includes browsing, uploads, trash and restore, version history,
public shares and inboxes, office editing through Collabora Online, storage
configuration, directory provisioning and reconciliation, and administrator
archive, restore, and permanent deletion. Comments and AI assistance inside the
editor are not part of this version. The reserved top-level `trash` directory
is excluded from ordinary browsing and downloads.

Filegate 6.1 supplies Unix execution, native historical copies, managed-root
preconditions, retained upload results, and sorting/filtering before pagination.
This does not establish production readiness for a particular filesystem or NFS
export. Unmanaged external-writer conflict safety
requires separate acceptance and has no atomic guarantee.

PDF/office thumbnail conversion is deliberately omitted; no conversion proxy
or preview cache is needed. The browser uses polling for updates because Filegate
has no change feed.
Filegate's versioning cooldown determines which automatic saves become versions.

The existing Files application remains independent and uses its older Filegate
API. There is no automatic migration of its settings or storage. Operators map
existing storage to the ordinary root and relative-path configuration.

See [Deployment requirements](/en/docs/operations/deployment-requirements) for
the Filegate and Collabora prerequisites. For the local test instances, see
[Monorepo development](/en/docs/operations/monorepo-development#test-filegate-locally).

## Markdown workspace and file templates

Markdown files (`.md` and `.markdown`, UTF-8, up to 2 MiB) open in the full
workspace using the shared Markdown editor, without a separate header or inner frame.
Save and Close are grouped at the right of the editor toolbar. Successful saves
briefly show a check on the Save button instead of a permanent status label. **Add → Markdown document** creates
an empty file without requiring Collabora. Save explicitly or press Ctrl/Cmd+S.
Unsaved changes are guarded when leaving. A failed save retains the draft;
reload the current file or save a copy under a new name. Managed roots compare
the revision of the downloaded bytes at publication, so a second editor cannot
silently replace a newer revision. Unmanaged roots compare observed metadata;
this is not an atomic filesystem precondition. Direct external NFS editing
remains outside Cloud's coordination guarantees.

**Add → Template** is always present and loads only templates the signed-in
user can use. Select one and a new file name in the current folder. The target
must be writable; an existing file is never overwritten. Editable formats open
in their editor after creation. If a response is lost, inspect the destination
before retrying; the same name cannot create a second copy or replace the first.

Administrators manage the catalog in **File administration → Templates**.
Upload a file or import one from an accessible storage base. Each template stores
an independent binary snapshot in PostgreSQL, with a maximum of 20 MiB per file.
Changing, moving or deleting the original cannot alter that snapshot. Replacing
or deleting a template leaves previously created files unchanged. Catalog lists
load metadata only and use cursor pagination; snapshot bytes belong in the
application database backup. Catalog upload/import is a bounded administrative
operation; ordinary file transfers still use direct Filegate leases.

Template use is granted through Cloud's ordinary `read` permissions to users,
groups (including nested membership), or all authenticated users. These grants
are independent of source and destination storage permissions. No grant means
administration-only visibility. Creating a file additionally checks the current
target's write permissions and applies its Unix execution identity and ownership.
Template permissions do not change permissions on the resulting file.

The CLI exposes `templates list|get|use`,
`admin templates list|upload|import|update|replace|delete`,
`admin templates access list|grant|revoke`, and `documents markdown`.
`upload --replace --expected-revision <revision>` adds a save precondition;
read the revision with `stat`. Keep the same revision and idempotency key when
recovering an uncertain upload. For unmanaged files, the observation token is
`fs:<modified>:<size>` from the stat response.

## Analyze and organize files through capabilities

Assistant code mode can discover accessible storage, list folders, search names,
read file content and save analysis results back to a permitted folder. Binary
streams support CSV, Excel and other formats without embedding the file in a
JSON tool response. Filesv2 capability streams accept files up to 50 MiB, matching the code-mode
file budget. The regular direct upload and download paths keep their own limits.

Folder creation, renaming, moving, copying, moving to trash and restoring are
available through the same capability catalog. Actions follow Assistant's normal
approval flow and recheck current storage access. New uploads default to creating
a file; replacing a file requires its current revision. Permanent deletion is
still an administrative operation, not an Assistant capability.

Use `cld capabilities catalog --json` for current schemas and the generic
`stream-read`, `stream-write`, `stream-status` and `stream-abort` commands for
binary transfers. The existing Filesv2 CLI remains available for direct tasks.

The canonical `entry.read` capability returns a stable `open` link and a resource reference with the current name. Consumers can open a Filesv2 entry through this shared contract without constructing file paths. Reading and opening still require the current user's access.
