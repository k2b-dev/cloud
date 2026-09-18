---
id: filesv2-start
title: Browse and download files
icon: ti ti-folders
description: Open personal and group storage and download individual files.
order: 100
---

Files v2 brings your accessible Cloud and FreeIPA directories into one view. The label beside each storage name identifies its source.

## Find your way around

The sidebar lists your storage locations and their folders as a tree; the current folder is highlighted and a folder you open shows a spinner in place of its icon. Click a folder in the list to open it; the first row **..** leads back to the parent folder. Click a file to open its details panel on the right, or use the small info button at the end of any row for folders too. Close the panel with the X; that also clears the selection.

Choose **List**, **Grid**, or **Tree** above the list. Tree shows the whole storage location from its root with the current folder highlighted; click a folder name to make it the current folder, click its icon to expand or collapse it, several at once. New entries and uploads always go into the current folder, which every name dialog shows. Grid adds a tile size control. The browser remembers view and size per folder. **Next page** and **First page** move through long folders; storage, folder, page, and a single selected file stay in the address bar so you can reload or bookmark.

## Search

The search field at the top searches names everywhere below the current folder; results show each hit with its path relative to the folder. Press Enter to search and clear the field to return to the listing. Storage without a search index is scanned on demand; if a folder holds too many entries for that, search in a smaller folder. The magnifier at the top of the sidebar opens the global Cloud search restricted to files across all your storage locations; opening a result jumps to its folder with the file selected.

## Select and act

**Select** next to the entry count shows checkboxes in every view; a click then toggles an entry, and **Done** hides them again. Without checkboxes, Ctrl/Cmd-click adds entries, Shift-click selects a range, and Ctrl/Cmd-A selects the loaded page. Arrow keys move, Space toggles, Escape clears. With a selection, **n selected** and an **Actions** menu appear below the search field: download (one file directly, several entries or folders as one ZIP), move into a new folder, move to another folder, copy to this or another storage, share publicly, or move to the trash. Right-click a row for the same actions.

Moving stays inside one storage location. Copying can target another storage location; the originals stay where they are, so a group file can never disappear into a private home by accident.

## Edit documents together

When your administrator has connected Collabora Online, text documents, spreadsheets and presentations (`odt`, `ods`, `odp`, `docx`, `xlsx`, `pptx`) open in an editor that fills the main area: double-click the file or use **Edit** in its details panel. Several people can work in the same document at once and see each other's changes. The header shows the file name and whether Collabora has saved your changes; the arrow on the left returns to the folder with the file selected. If you may only read a file, it opens read-only. Every save becomes the current file; the file's version history stays in its details panel.

The plus menu then also offers **New text document**, **New spreadsheet** and **New presentation**. You enter a name, the file extension is added for you, and the new document opens in the editor.

## Add, upload, and change entries

The plus button next to the search field offers **Upload**, **Upload folder**, **New folder**, and **New file**. You can also drop files from your computer onto the list. Each file is transferred directly to the file server after Cloud has checked your access, and it is published only when the whole transfer has arrived. Progress appears in a notification with a progress bar. If names already exist you decide once per upload whether to replace them or upload only the new files. Names cannot contain slashes.

The details panel of an entry offers **Open in new tab**, **Rename**, **Duplicate**, **Move to**, **Copy to**, **Share publicly**, and **Move to trash**. Folders additionally offer **Share as upload inbox**. The copy button in the panel header copies a Cloud reference to the clipboard that other apps understand.

## Trash

Deleting never removes anything permanently: entries move into the trash of their storage location, which appears as **Trash** at the end of the root folder and in the sidebar. Open it to see what you deleted; **Restore** puts an entry back to its original place. Only an administrator can empty the trash.

## Versions

Where the storage keeps versions, the details panel lists earlier versions of a file at the bottom. For each version you can add a comment, download it, restore it in place, restore it as a new file next to the current one, or delete it. Restoring in place keeps the current state as a new version.

## Share publicly

Select entries and choose **Share publicly**, or share a folder as an **upload inbox** from its details. Give the share a name, choose how long the link stays valid, and optionally add an internal note. Everyone who can open the folder that contains the shared entries sees the share under **Shares** in the sidebar and can copy or revoke the link. A download share lets anyone with the link download the listed entries or everything as a ZIP; an upload inbox lets anyone with the link add files to that folder without seeing its contents. Existing files are never replaced by inbox uploads.

## Download a file

Select **Download** beside a file. Cloud checks your current access and prepares a short-lived download directly from the file server. If preparing the download fails, the error appears above the list and you can try again.

Select several individual files and use **Download** to download them together. Your browser may request permission for multiple downloads. Open folders to download their individual files.

## Use the terminal

After signing in with `cld login --server <Cloud URL>`, use `cld filesv2 bases list --json` to find your base ID. List a folder with `cld filesv2 list <base-id> --path Documents --json`. The result includes `next`; pass it unchanged as `--after` for the next page.

Download a file with `cld filesv2 download <base-id> Documents/report.pdf --out ./report.pdf`. The CLI downloads directly from Filegate to a new local file. Existing paths are never overwritten. Use `--json` for the saved path and byte count, or `cld filesv2 help` for all available commands.

`cld filesv2 search <base-id> report --path Documents --json` searches names below a folder and `cld filesv2 mkdir <base-id> Documents/2026` creates a folder. `rename`, `move --to`, `copy --to [--target-base]`, `delete`, `trash list|restore`, `versions list|comment|restore|delete`, and `shares list|create|revoke` cover the remaining operations. `cld filesv2 upload <base-id> ./report.pdf --to Documents/report.pdf` uploads a file directly to the file server; add `--replace` to replace an existing file. `cld filesv2 stat <base-id> <path> --json` reads current file details. `cld filesv2 thumbnail <base-id> Photos/team.jpg --out ./team.png` saves an image preview.

## When storage is unavailable

An empty folder has a different meaning from a missing or unavailable directory. The page shows whether a directory is missing, needs assignment or cannot currently be reached. Contact your administrator when a directory needs attention.

Cloud storage requires enabled local Linux identities. Only POSIX groups can have group storage. FreeIPA storage is configured independently; a FreeIPA user can also see accessible local Cloud group storage.
