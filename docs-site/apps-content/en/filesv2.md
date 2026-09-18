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

Choose **List** or **Grid** without losing your selection. Display options change
list density or tile size; the browser remembers these settings. Click an item
to select it and show its details. Double-click or press Enter to open a folder
or a larger preview. Folder action links also support opening in another tab.
On touchscreens, tap to open or enable **Select items** for multiple selection.

Use checkboxes, Ctrl/Cmd-click, or Shift-click to select several entries. Arrow
keys move through entries; Space toggles selection and Escape clears it.
Ctrl/Cmd-A selects the loaded page. Selecting several items shows their file
count and known file sizes; folder contents are not included in that total.
Selection is scoped to the current folder and page. A single selected item's
path is included in the URL and can be bookmarked with its details.

The detail panel shows the full name, location, size, modification time, and
storage area. Images, PDFs, text, and supported audio/video formats have previews.
Unsupported formats retain their metadata and download action. Previews and
thumbnails obtain a short-lived Cloud-authorized lease and load their bytes
directly from Filegate. Retry a failed preview to obtain a fresh lease.

Use **Download** for one or several individual files. Multiple downloads may need
browser permission. Folder downloads and file mutations are not offered in this
browser yet. Listings retain Filegate's name order and explicit pagination.

The CLI provides `filesv2 stat <base-id> <path> --json` for the same current
metadata and `filesv2 thumbnail <base-id> <path> --out <file>` for a direct preview
download. Use `--size small|large` to select the thumbnail size.

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

This version includes browsing, individual downloads, storage configuration,
directory provisioning and reconciliation, and administrator archive, restore,
and permanent deletion. Uploads, user trash and restore actions, version-history
controls, public shares, and public inboxes are planned separately. The reserved
top-level `trash` directory is excluded from ordinary browsing and downloads.

The existing Files application remains independent and uses its older Filegate
API. There is no automatic migration of its settings or storage. Operators map
existing storage to the ordinary root and relative-path configuration.

For the local Filegate test instance, see
[Monorepo development](/en/docs/operations/monorepo-development#test-filegate-locally).
