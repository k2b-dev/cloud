---
id: filesv2-admin
title: Manage storage and directories
icon: ti ti-settings
description: Connect Filegate, inspect directories, and manage their archive and lifecycle.
order: 200
---

Open **File administration** to manage Files v2. Its views separate storage information, current directories, archived directories, public shares, and settings. Filters, folders, and pages remain in the address, including when you use Back or Forward.

## Connect storage in Settings

Enter the Filegate **Backend URL** and **Backend token**. The application must be able to reach the address. Filegate supplies the public addresses for direct browser downloads. An existing token is never shown; leave its field blank to keep it. Use **Save configuration** to save your edits, or **Discard** to restore the saved values. Leaving with unsaved edits asks for confirmation.

Enable Cloud and FreeIPA independently and select their Filegate roots. **Advanced paths** contains the optional base prefix and the home, group, and archive paths relative to that prefix. Keep these paths separate so the areas and reserved directories do not overlap.

Cloud storage requires enabled local Linux identities. Only eligible user accounts and POSIX groups have directories. **Create local directories automatically** is off by default. Automatic archiving is on by default and can be disabled separately; it archives managed directories of deleted local accounts or groups, and groups with POSIX disabled. Files remain recoverable. An unknown identity state never counts as deletion. FreeIPA has no automatic creation or archiving: choose its directory actions explicitly.

**Collabora Online** connects a document editor for text documents, spreadsheets and presentations. Enter the **Collabora address** browsers load the editor from; leaving it empty disables editing. Choose the **format of new documents**: OpenDocument or Microsoft Office. **Advanced** holds two optional addresses for deployments in which this application reaches Collabora, or Collabora reaches this Cloud, under different addresses than browsers use. Collabora must be able to reach this Cloud's address, and this application must reach Collabora.

## Read the Overview

The overview shows capacity, available space, active uploads, counts, and sizes for the selected root. Unknown values stay unknown. Statistics cover the whole root, including paths outside an area's prefix.

Index and version-history settings come from Filegate. **Refresh** requests an updated root summary. **Rebuild index** requires confirmation because it affects the whole root.

## Inspect Directories

Select the area and **Users** or **Groups**. Search by name or filter by state. **Refresh** reads the current filesystem, including directories created manually on the server. Use **Next page** to continue the inventory.

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

## Restore or remove an Archive

The archive view shows original paths and archive dates. Open an archived directory to inspect its contents. **Restore** moves it back to its original path after confirmation; that destination must be available. Permanent deletion of an archive or an individual file requires its exact path. These destructive actions exist only in the administrator interface and the administrator CLI.

## Manage public shares and inboxes

**Shares** lists all public links; ordinary users see only their own. Administrators can revoke a link independently of its creator's remaining access. Links are shown only when created. Existing URLs remain valid after the token-storage upgrade, but neither users nor administrators can recover them from the overview. Internal notes remain private; only the separate public note is visible to visitors.

Inboxes default to 100 MiB per file and 1 GiB cumulative total, including links that existed before this upgrade. Confirmed uploads and pending reservations both count against the total. Deleting received files does not restore this budget. Reconciliation continues after a link expires or is revoked. An unresolved transfer keeps its reservation until there is a reliable outcome; inspect the listed path, error, and session before taking action. Do not treat a missing receipt as proof that no file was written.

## Inspect trash and versions

User trash and restore actions record progress before moving a file. An ambiguous result remains pending instead of being reported as completed. Items discovered directly in `trash` can have an unknown original path or deletion time; restoring them requires an explicit destination. Existing destinations are never replaced. Multi-entry operations can partly succeed; inspect each result before retrying failed items.

Historical versions can be permanently deleted only from the administrator file browser's version action or `admin versions delete`. Confirm the exact file path and version first. Ordinary users can download, comment on, and restore versions, but cannot permanently delete them.

## Use the terminal

`cld filesv2 admin inventory --area freeipa --kind groups --json` reads the same inventory. Pass a returned `next` cursor with `--after`. Read configuration with `cld filesv2 admin configuration get --json`; write a complete edited configuration with `cld filesv2 admin configuration set --input-file ./filesv2.json` or `--stdin`. An omitted or empty `token` preserves the secret.

Use `cld filesv2 admin shares list --json` lists all links; `admin shares revoke <share-id>` revokes one. `cld filesv2 admin uploads list --json` lists unresolved inbox reservations. These lists accept `--after` for further pages.

`cld filesv2 help` for the directory, archive, and inspection commands. CLI actions require the same administrative permissions and confirmations as their interface counterparts.
