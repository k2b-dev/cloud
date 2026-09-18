---
id: filesv2-start
title: Browse and download files
icon: ti ti-folders
description: Open personal and group storage and download individual files.
order: 100
---

Files v2 brings your accessible Cloud and FreeIPA directories into one view. The label beside each storage name identifies its source.

## Open a folder

Select a storage location in the workspace sidebar, then double-click a folder or use its **Open** action. On mobile, find the same storage choices in the Cloud menu. Use the folder path above the list to return to a parent folder. **Next page** opens more entries; **First page** returns to the beginning of the current folder. Your selected storage, folder, and page remain in the address, so you can reload or bookmark it.

Use **Refresh** to read the current filesystem contents, including directories and files created outside Cloud.

## Select and preview

Switch between **List** and **Grid** using the view control. **Display options** changes list density or preview size. These choices are remembered in this browser.

Click an entry to show its details and available preview. Double-click or press Enter to open a larger preview. On touchscreens, tap to open; use **Select items** or the checkboxes to select entries instead.

Use Ctrl/Cmd-click to add entries, Shift-click to select a range, or the checkboxes. Arrow keys move through the list or grid, Space toggles selection, and Escape clears it. Ctrl/Cmd-A selects the current page. Folder and page changes clear selection. A single selected file remains in the URL for bookmarking.

The detail panel opens beside the list and shows the full name, path, date, size, and storage area. Close it with **Close details**, which also clears the selection. Unsupported formats can still be downloaded. If a preview fails, use **Try again**. Selected folder contents are not counted in the combined file size.

## Download a file

Select **Download** beside a file. Cloud checks your current access and prepares a short-lived download directly from the file server. If preparing the download fails, the error appears above the list and you can try again.

Select several individual files and use **Download** to download them together. Your browser may request permission for multiple downloads. Open folders to download their individual files.

## Use the terminal

After signing in with `cld login --server <Cloud URL>`, use `cld filesv2 bases list --json` to find your base ID. List a folder with `cld filesv2 list <base-id> --path Documents --json`. The result includes `next`; pass it unchanged as `--after` for the next page.

Download a file with `cld filesv2 download <base-id> Documents/report.pdf --out ./report.pdf`. The CLI downloads directly from Filegate to a new local file. Existing paths are never overwritten. Use `--json` for the saved path and byte count, or `cld filesv2 help` for all available commands.

`cld filesv2 stat <base-id> <path> --json` reads current file details. `cld filesv2 thumbnail <base-id> Photos/team.jpg --out ./team.png` saves an image preview.

## When storage is unavailable

An empty folder has a different meaning from a missing or unavailable directory. The page shows whether a directory is missing, needs assignment or cannot currently be reached. Contact your administrator when a directory needs attention.

Cloud storage requires enabled local Linux identities. Only POSIX groups can have group storage. FreeIPA storage is configured independently; a FreeIPA user can also see accessible local Cloud group storage.
