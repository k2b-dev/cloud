---
id: filesv2-admin
title: Manage storage and directories
icon: ti ti-settings
description: Connect Filegate, inspect directories, and manage their archive and lifecycle.
order: 200
---

Open **File administration** to manage Files. Its views separate storage information, current directories, archived directories, public shares, file activity, and settings. Filters, folders, and pages remain in the address, including when you use Back or Forward.

## Connect storage in Settings {icon="plug"}

Enter the Filegate **Backend URL** and **Backend token**. The application must be able to reach the address. Filegate supplies the public addresses for direct browser downloads. Its public host must be outside the scope of Cloud cookies; a different port on the same host is insufficient. Configure the exact Cloud origin for CORS. Cloud uses the backend address for its own transfers. An existing token is never shown; leave its field blank to keep it. Use **Save configuration** to save your edits, or **Discard** to restore the saved values. Leaving with unsaved edits asks for confirmation.

Enable Cloud and FreeIPA independently and select their Filegate roots. **Advanced paths** contains the optional base prefix and the home, group, and archive paths relative to that prefix. Keep these paths separate so the areas and reserved directories do not overlap.

Personal and group Cloud storage requires enabled local Linux identities. Only eligible user accounts and POSIX groups have directories. **Create local directories automatically** (`cloud.autoCreate`) is off by default. Automatic archiving is on by default and can be disabled separately; it archives managed directories of deleted local accounts or groups, and groups with POSIX disabled. Files remain recoverable. An unknown identity state never counts as deletion.

FreeIPA home creation has its own `freeipa.autoCreate` setting, also off by default. Enable it in the Files configuration to create homes for active FreeIPA users with complete POSIX UID and primary GID. These homes use the configured FreeIPA root and paths and the user's Unix ownership. Cloud automatic creation remains independent and uses daemon ownership. FreeIPA group creation and archiving remain explicit actions.

New users and existing eligible users are checked at startup, after configuration changes, and periodically, in pages of up to 50 accounts. Enabling the relevant setting resumes pending homes. Administration can inspect per-user progress through `GET /api/filesv2/admin/provisioning`, including the target `area`. Filter items with `area=cloud|freeipa` and `state`, and continue with the returned `nextCursor` as `after`. The response also includes counts for every state present in each area, independent of those filters, and the reconciliation's last completion time, processed/done/pending/failed totals, and running flag.

`auto_create_off` means that area's automatic creation is disabled; `posix_incomplete` means UID or primary GID is missing and takes precedence for FreeIPA even while automatic creation is off. `not_configured` means the storage connection or required area is unavailable. `done` confirms provisioning; `failed` includes an error code and is retried during reconciliation.

**Collabora Online** connects a document editor for text documents, spreadsheets and presentations. Enter the **Collabora address** browsers load the editor from; leaving it empty disables editing. Choose the **format of new documents**: OpenDocument or Microsoft Office. **Advanced** holds two optional addresses for deployments in which this application reaches Collabora, or Collabora reaches this Cloud, under different addresses than browsers use. Collabora must be able to reach this Cloud's address, and this application must reach Collabora.

## Create machine storage {icon="server"}

In **Settings → Machine storage**, choose an agent or standalone service account and select **Create storage**. Open the new storage row and grant named users, groups or machines access to a **Relative path**. Empty means the whole storage; a narrower grant includes that file or folder and its descendants. Choose **Read**, **Read and write**, or **Read, write and share**. Ownership alone grants no access, including to the owner.

Machine storage uses its own Cloud directory and the existing Files service identity. It needs no local Linux provisioning and never uses a person's Unix identity. FreeIPA machine storage is unavailable without an independently provisioned machine Unix identity. Machine storage is excluded from the human directory lifecycle and automatic archiving.

Use **Revoke** to remove a path grant. The next transfer request or upload commit checks current access again. Disabling a machine account or revoking its public link also denies the next request; a stream already admitted can finish. If creation fails, fix the connection and retry with the same owner. Files resumes the existing binding.

## Read the Overview {icon="layout-dashboard"}

The overview shows capacity, available space, active uploads, counts, and sizes for the selected root. Unknown values stay unknown. Counts and sizes require a complete observed scan; incomplete totals or totals of unknown freshness are not presented as current counts. Observation metadata describes the source and scan interval, not an atomic quota. Statistics cover the whole root, including paths outside an area's prefix.

Index, version history, managed mode, and Unix execution come from Filegate. FreeIPA requires execution enabled and an explicitly configured daemon that can switch Unix identities. Without it, Files denies access instead of using the service account. Managed mode is only for roots where all writes use Filegate; keep it off when external processes write directly. It enables atomic publication checks between Filegate operations, not protection against external NFS writes. The editor remains available on unmanaged roots with best-effort conflict checks only. **Stable file IDs** is on for roots with both an index and managed mode on Filegate 7 or later. Only there do file references survive rename and move; elsewhere they name a path. **Refresh** requests an updated root summary. **Rebuild index** requires confirmation because it affects the whole root.

## Inspect Directories {icon="folders"}

Select the area and **Users** or **Groups**. Each directory shows the account's display name with the username below it; a directory without a matching account or group is marked **Unknown account** or **Unknown group**. Search by display name, username, or path, or filter by state. **Refresh** reads the current filesystem, including directories created manually on the server. FreeIPA browsing uses live filesystem access even with indexing enabled. Since Filegate 6.1, FreeIPA filename search also reads the current filesystem under the user's Unix identity, independently of the index. Unreadable subtrees fail the search. Use **Next page** to continue the inventory.

- **Present:** the directory is available for its identified account.
- **Missing:** the expected directory is absent.
- **Unassigned:** an existing directory has no confirmed assignment.
- **Orphaned:** the identity is confirmed absent or no longer eligible.
- **Retired:** the directory was explicitly taken out of active use.
- **Conflict:** the path, identity, or Unix ownership needs review.
- **Unknown:** the application could not establish the current state.

Open a directory name to inspect its files and folders. **Trash** opens the directory's top-level trash folder. Files can be downloaded directly from Filegate after a fresh access check. An absent trash folder is reported as missing.

Each row offers only currently available actions:

- **Details** shows the path, source, identity numbers, and state.
- **Create directory** creates a missing eligible home or group directory. FreeIPA uses its UID, GID, and required permissions.
- **Assign directory** associates a matching existing directory without moving its files.
- **Archive** moves a directory out of active use. Enter an archive path relative to the area's base prefix; the saved archive path is suggested.
- **Retire directory** disables active use and prevents automatic recreation while leaving its files in place.
- **Permanently delete** requires typing the exact displayed path. It cannot be undone.

A result of **In progress** means completion has not yet been confirmed. Refresh the inventory and use **Retry operation** where offered. Retrying checks the current identity, permissions, and filesystem again. A conflict requires review before another attempt.

## Restore or remove an Archive {icon="archive"}

The archive view shows original paths and archive dates. Open an archived directory to inspect its contents. **Restore** moves it back to its original path after confirmation; that destination must be available. Permanent deletion of an archive or an individual file requires its exact path. These destructive actions exist only in the administrator interface and the administrator CLI.

## Manage public shares and inboxes {icon="share"}

**Shares** lists all public links; ordinary users see only their own. Administrators can revoke a link independently of its creator's remaining access. Links are shown only when created. Existing URLs remain valid after the token-storage upgrade, but neither users nor administrators can recover them from the overview. Internal notes remain private; only the separate public note is visible to visitors.

Inboxes default to 100 MiB per file and 1 GiB cumulative total, including links that existed before this upgrade. Confirmed uploads and pending reservations both count against the total. Deleting received files does not restore this budget. Reconciliation continues after a link expires or is revoked. An unresolved transfer keeps its reservation until there is a reliable outcome; inspect the listed path, error, and session before taking action. Do not treat a missing receipt as proof that no file was written.

## Review and export file activity {icon="activity"}

**Activity** lists recorded changes to files and folders across local Cloud storage, newest first, with time, person, change, item, storage and channel. On narrow screens it shows the same entries as the list in Files. It opens on the last 30 days. Filter by **Storage**, **Who**, **What** and **When**, or search a name or an old path. Filters and search stay in the address.

- **Running:** the change has started and is not confirmed yet.
- **Outcome unclear:** Files could not confirm the result. It keeps looking for proof in the storage.
- **No Cloud entry:** Files noticed a change made outside Cloud, for example on a network drive. Such entries name no person and no cause.

FreeIPA and other POSIX storage have no history or export. Their history view shows a notice because history cannot check their Unix permissions. An operation across storage areas shows only its local Cloud side.

**Export** downloads the entries that match the filters as CSV or JSON Lines. Choose a period of at most one year and, optionally, one storage; the person, change and search filters of the list are kept. The button shows how many rows the export contains. An export holds at most 100,000 rows; for more, narrow the period, the storage or the filters. In CSV, a cell that starts like a spreadsheet formula gets a leading apostrophe. Every export is recorded in the audit log, also when you cancel the download. A download that fails saves nothing; start it again. Settings controls how long the history is kept, from 30 to 3,650 days.

## Inspect trash and versions {icon="history"}

User trash and restore actions record progress before moving a file. An ambiguous result remains pending instead of being reported as completed. Items discovered directly in `trash` can have an unknown original path or deletion time; restoring them requires an explicit destination. Existing destinations are never replaced. Multi-entry operations can partly succeed; inspect each result before retrying failed items.

Historical versions can be permanently deleted only from the administrator file browser's version action or `admin versions delete`. Confirm the exact file path and version first. Ordinary users can download, comment on, and restore versions, but cannot permanently delete them.

## Use the terminal {icon="terminal"}

`cld filesv2 admin inventory --storage freeipa --kind groups --json` reads the same inventory. Pass a returned `next` cursor with `--after`. Read configuration with `cld filesv2 admin configuration get --json`; write a complete edited configuration with `cld filesv2 admin configuration set --input-file ./filesv2.json` or `--stdin`. An omitted or empty `token` preserves the secret.

`cld filesv2 admin shares list --json` lists all links; `admin shares revoke <share-id> --yes` revokes one. `cld filesv2 admin uploads list --json` lists unresolved inbox reservations. These lists accept `--after` for further pages.

Directory and file commands address a directory as `<storage>/<users|groups>/<name>` or an archive as `<storage>/archive/<archive-id>`, followed by `:/path` for an entry, for example `cld filesv2 admin files ls cloud/groups/team:/trash`. `cld filesv2 help` lists the directory, archive, and inspection commands. CLI actions require the same administrative permissions and confirmations as their interface counterparts.

## Manage templates {icon="template"}

The **Templates** tab stores reusable files independently of storage bases. Upload a file or choose an existing file you can read. Each template is a separate snapshot, up to 20 MiB. Name it, optionally describe it, and give **Use** access to users, groups, agents, standalone service accounts or everyone signed in. Without access, only administration lists it. These are Cloud permissions; no POSIX group or access to the original folder is required.

Users choose **Add → Template** in a writable folder. The template access never bypasses write access to the destination. Replacing a template file or deleting the template does not affect files previously created from it. Imported originals can also be changed or removed independently. Template bytes and access entries are stored in PostgreSQL and must be included in database backups.

The CLI offers `admin templates list|upload|import|update|replace|delete` and `admin templates access list|grant|revoke`. Delete requires `--yes`. Use `--help` for arguments and `--input-file` or `--stdin` for an access entry’s JSON principal.
