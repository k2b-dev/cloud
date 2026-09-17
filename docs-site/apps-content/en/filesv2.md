---
title: Filesv2
navTitle: Filesv2
section: Work
order: 151
description: Browse existing Cloud and FreeIPA storage and download files directly through Filegate.
tags: [files, storage, freeipa, filegate]
updated: 2026-09-17
---

# Filesv2

Filesv2 is a separate application for personal and group storage. It presents
Cloud and FreeIPA directories in one file browser. The first version browses
existing directories and downloads individual files through Filegate leases.

Open `/app/filesv2` to choose an accessible home or group directory from the
workspace sidebar. On mobile, the Cloud menu contains the same storage choices.
Switching storage, opening folders, and changing pages update the workspace
without reloading the whole page. Navigation and pagination stay in the URL,
so reloads and browser Back and Forward preserve your location.
Missing or inaccessible storage appears with its status rather than as an
empty directory.

## Configure storage

Administrators configure the Filegate connection and both storage areas at
`/admin/filesv2`. Each area has its own enabled state, named Filegate root,
optional relative prefix, and home, group, and archive subdirectories. The
backend token stays on the server. Saved credentials are not returned to the
browser.

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

## Current scope

This version includes browsing, individual downloads, storage configuration,
and an administrative inventory. Uploads, directory provisioning, archival,
trash operations, version-history controls, public shares, and public inboxes
are planned separately. The reserved top-level `trash` directory is excluded
from ordinary browsing and downloads.

The existing Files application remains independent and uses its older Filegate
API. There is no automatic migration of its settings or storage. Operators map
existing storage to the ordinary root and relative-path configuration.

For the local Filegate test instance, see
[Monorepo development](/en/docs/operations/monorepo-development#test-filegate-locally).
