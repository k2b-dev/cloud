---
title: Filesv2
navTitle: Filesv2
section: Work
order: 151
description: Browse Cloud and FreeIPA storage, manage directories, and download files directly through Filegate.
tags: [files, storage, freeipa, filegate]
updated: 2026-09-18
---

# Filesv2

Filesv2 is a separate application for personal and group storage. It presents
Cloud and FreeIPA directories in one file browser. Administrators manage
directory creation, assignments, and archives separately from everyday browsing.
Individual downloads use short-lived Filegate leases.

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
expands or collapses it. **Select** next to the entry count switches on
checkboxes in every view. Thumbnails are requested with bounded concurrency and
retried, because Filegate rejects parallel renders beyond its capacity.
Storage, folder, page, single selection, search query, and scope stay in the
URL. Entries can be sorted by name, date, size or type and filtered by type
within the loaded page (Filegate lists by name), dragged onto folders or the
`..` row to move them (resting on a folder opens or expands it), and marked as
favorites; recently opened entries and favorites have their own sidebar
views. The current page is polled while the tab is visible so changes by
others appear without a reload. With Collabora configured, PDF and office
files get first-page previews rendered through Collabora's convert-to
endpoint and cached briefly in the application.

Search always covers the subtree below the current folder; hits show their
path relative to it. Filesv2 also answers the universal
search under the `file` tag through the `filesv2.entry` resource type, and
each entry's Cloud reference can be copied from the details panel.

Selections act through one **Actions** menu: direct download for one file, a
signed Filegate ZIP for several entries or folders, move into a new folder,
move, copy, public share, trash. Moves never leave a base; copies may cross
bases with the target's ownership. Deleting moves entries into the reserved
`trash` folder with a restorable record; only administrators empty it.
Renaming, duplicating and moving reuse Filegate transfers.

The details panel shows a preview hero (images enlarge into a dialog),
facts including the storage area, an action list, and, where the root keeps
versions, a versions section with comments (stored as version metadata),
download, restore in place, restore as a new file, and delete.

Uploads report progress in one toast and resolve name conflicts once per
batch (replace existing or upload only new). Uploads, folder uploads and new
files open a Filegate upload session per file: Cloud authorizes the target, the browser streams segments to the
session lease and renews it through Cloud, and Cloud commits after re-checking
the target. Existing names ask before being replaced.

## Public shares

A share is either a download bundle of entries or an upload inbox for one
folder, always inside one base. Its scope is the common ancestor of the
entries; everyone who can read that folder sees the share under **Shares** and
may revoke it, so shares never cross a rights boundary. The overview lives inside the workspace at
`/app/filesv2?view=shares`, the trash at `/app/filesv2?view=trash`. Links live under
`/share/filesv2/s/<token>` and `/share/filesv2/inbox/<token>`, expire after
1, 7, 30 or 90 days, and are served token-only with rate limiting. Visitors
download through short leases or one signed archive; inbox uploads open
sessions owned by the share creator and never replace existing files.

## Configure storage

Open `/admin/filesv2` for four administration views: **Overview**,
**Directories**, **Archive**, and **Settings**. Overview shows the selected
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

## Understand the source of truth

The filesystem determines which files and directories exist. Filegate's index
is derived metadata, not a prerequisite for recognizing externally created
directories. An administrator can create a FreeIPA directory directly on the
storage server and then inspect it in Filesv2. A missing Cloud assignment must
not hide a valid directory.

Cloud identities determine who may use storage. Filesv2 checks current access
and FreeIPA Unix permissions before listing files or issuing a download lease.
The admin inventory distinguishes missing directories, unassigned directories,
conflicts, and unavailable checks. An identity missing from Cloud's filtered
FreeIPA mirror is not proof that it was deleted in FreeIPA.
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
decides which saves become versions. A save whose base timestamp no longer
matches the stored file is refused so Collabora can show its conflict dialog.

Several Collabora instances need sticky routing on the `WOPISrc` parameter,
which is a Collabora deployment concern; Filesv2 scales horizontally
unchanged.

## Download files

For each download, the browser requests a short-lived lease from Filesv2.
After authorization, Filegate sends the file directly to the browser. The full
Filegate token never appears in the lease. Disabling an area or removing access
prevents new leases; already issued leases retain their short remaining lifetime.

Filegate owns each root's index and versioning configuration. Filesv2 reads
those capabilities independently for each root. Unknown statistics remain
unknown. Root totals must not be interpreted as totals for a configured prefix.

## Use the CLI

The same operations are available through `cld filesv2`. Sign in with
`cld login --server <Cloud URL>`, then use a base ID from `bases list`:

```sh
cld filesv2 bases list --json
cld filesv2 list <base-id> --path Documents --json
cld filesv2 download <base-id> Documents/report.pdf --out ./report.pdf --json
cld filesv2 documents create <base-id> Documents/Minutes --kind text --json
cld filesv2 edit-url <base-id> Documents/Minutes.odt
cld filesv2 recent --json
cld filesv2 favorites add <base-id> Documents --json
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
pass that cursor unchanged as `--after`. `--jsonl` emits one complete item per
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

## Current scope

This version includes browsing, uploads, trash and restore, version history,
public shares and inboxes, office editing through Collabora Online, storage
configuration, directory provisioning and reconciliation, and administrator
archive, restore, and permanent deletion. Comments and AI assistance inside the
editor are not part of this version. The reserved top-level `trash` directory
is excluded from ordinary browsing and downloads.

The existing Files application remains independent and uses its older Filegate
API. There is no automatic migration of its settings or storage. Operators map
existing storage to the ordinary root and relative-path configuration.

See [Deployment requirements](/en/docs/operations/deployment-requirements) for
the Filegate and Collabora prerequisites. For the local test instances, see
[Monorepo development](/en/docs/operations/monorepo-development#test-filegate-locally).
