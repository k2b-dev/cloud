---
id: filesv2-admin
title: Configure and inspect storage
icon: ti ti-settings
description: Connect Filegate, configure storage areas and inspect directory assignments.
order: 200
---

Administrators configure Files v2 under **File administration**.

## Connect storage

Enter the Filegate **Backend URL** and **Backend token**. The address must be reachable by the application. Filegate supplies the public addresses used for direct browser downloads. An existing token is never shown; leave the token field blank to keep it.

Configure Cloud and FreeIPA independently. Each area has a Filegate root and an optional relative base prefix. Home, group, and archive directories are relative to that prefix. Choose separate directory paths so the areas and reserved directories do not overlap.

Cloud files require local Linux identities. FreeIPA files require FreeIPA to be enabled. Save the configuration before inspecting the selected area's inventory.

The root's index and version-history settings come from Filegate. Files v2 does not provide separate switches. Root statistics cover the entire root, even when the area uses a prefix. Unknown counts and sizes are displayed as unknown.

## Inspect the filesystem

Select **Cloud** or **FreeIPA**, then **Users** or **Groups**. **Refresh** checks the current filesystem, including directories an administrator created manually on the server.

- **Present:** the directory is available for its identified account.
- **Missing:** the expected directory is absent.
- **Unassigned:** a directory is not connected to an eligible account.
- **Conflict:** the existing directory or assignment needs review.
- **Unknown:** the application could not establish the current state.

Do not interpret an unknown state as proof that an account or directory was deleted. Check identity availability and the file-server connection first.

Where **Assign directory** is available, verify the account and path before confirming. Assignment keeps the existing files in place. A directory without a matching eligible identity cannot be assigned through this action.

## Administer from the terminal

`cld filesv2 admin inventory --area freeipa --kind groups --json` reads the same inventory and root statistics. Use `cloud` or `freeipa` for the area and `users` or `groups` for the kind. Pass the returned `next` cursor as `--after` to continue.

Read configuration with `cld filesv2 admin configuration get --json`. Submit a complete edited configuration with `cld filesv2 admin configuration set --input-file ./filesv2.json` or `--stdin`. An omitted or empty `token` keeps the saved secret. The read response never contains that secret.

After verifying the inventory entry, use `cld filesv2 admin adopt <identity-uuid> --area cloud --kind users --yes` to assign its existing directory. These commands require the same administrator permissions as the UI. They do not create, archive, or delete directories.
