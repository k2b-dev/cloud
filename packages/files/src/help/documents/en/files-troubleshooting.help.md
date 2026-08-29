---
id: files-troubleshooting
title: Troubleshooting
icon: ti ti-lifebuoy
description: Resolve missing bases, empty searches, unavailable previews, slow folders, and failed file operations.
order: 120
---

Start by checking the selected file base and folder path. Most unexpected results come from looking in another base, filtering the current directory, or lacking access to the target path.

## Common symptoms {icon="lifebuoy"}

:::reference
- **A home or group base is missing:** Files only lists bases available through the current IPA user and recursive group memberships. Confirm the account and group access with an administrator.
- **A folder looks empty:** Clear the folder search and, when appropriate, enable hidden files in panel settings.
- **Global search finds nothing:** Check the selected bases and glob pattern. Use `**/*name*` for a broad name search or a pattern such as `**/*.pdf` for one file type.
- **A file has no preview:** Not every file type can be rendered safely in the browser. Download it or open it in a new tab when that action is offered.
- **A folder is slow:** Turn off precise sizes. Calculating exact directory totals requires extra server work.
- **Move or rename fails:** Check that the destination exists, you can write to it, and the target name does not conflict with an existing item.
- **Delete is unavailable in Trash:** Trash is a recovery location; the file browser does not delete items from Trash.
:::

## Before repeating an upload {icon="paperclip"}

:::steps
1. Clear the current filter and check the expected folder.
2. Refresh the directory once.
3. Look for a same-name item or partial folder upload.
4. Repeat the upload only after confirming the first request did not complete.
:::

:::warning Shared storage
Changes in a group base affect everyone using that storage. Confirm the path and selection count before bulk move or delete actions.
:::
