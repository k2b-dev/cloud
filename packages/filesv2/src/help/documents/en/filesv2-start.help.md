---
id: filesv2-start
title: Browse and edit files
icon: ti ti-folders
description: Browse storage, edit documents, use templates, and share files.
order: 100
---

Files brings your accessible Cloud and FreeIPA directories into one view. The label beside each storage name identifies its source.

## Folder descriptions and previews {icon="file-description"}

Add a `README.md` to a folder to explain what belongs there. Uppercase and lowercase spelling both work. Its content appears above the list or grid in a compact area. Tree view hides this preview; you can still open the README as a normal file. Long descriptions fade out at the bottom. Use **Show all** to read the full description. The README stays a normal file that you can edit, move, or delete.

The details panel shows five lines of text or five CSV records plus the header. The **… more lines** button opens the larger preview. In long CSV tables, use **Previous** and **Next** to read further pages. Existing preview size limits still apply; tables show at most 50 columns and tell you when more columns require downloading the file.

## Find your way around {icon="folders"}

The sidebar lists your storage locations and their folders as a tree. Your own storage appears as **My files** with your username beneath it; group storage carries the group name. The current folder is highlighted and a folder you open shows a spinner in place of its icon. Click a folder in the list to open it; the first row **..** leads back to the parent folder. Click a file to open its details panel on the right, or use the small info button at the end of any row for folders too. Close the panel with the X; that also clears the selection.

Choose **List**, **Grid**, or **Tree** above the list. Tree shows the whole storage location from its root with the current folder highlighted; click a folder name to make it the current folder, click its icon to expand or collapse it, several at once. New entries and uploads always go into the current folder, which every name dialog shows. Grid adds a tile size control. The browser remembers view and size per storage location. **Next page** and **First page** move through long folders; storage, folder, page, and a single selected file stay in the address bar so you can reload or bookmark.

## Sort, filter, and drag {icon="filter"}

Open **Sort and filter** using the icon button to the right of search. Its three sections are **Sort by**, **Order**, and **Type**. Choose name, date, or size; ascending or descending order; and all entries, files, or folders. **Group folders** is on by default: folders come before files, each sorted by name. Turn it off to sort both together. The browser remembers grouping per storage location. **Reset** restores name ascending, all types, and grouping. The `..` row stays above the entries even when you change sorting or filter by type. Column headers in the list sort as well. Sorting and filtering apply across pages. With grouping on, all folders appear before files. Options stay in the address bar. If a saved page has expired or changed, the browser returns to the first page and tells you.

Drag an entry onto a folder to move it there; a highlighted or checked selection moves together. The **..** row moves entries to the parent folder. Rest on a folder for a moment and it opens (list and grid) or expands (tree), so you can drop deeper without letting go. Dropping files or folders from your computer uploads them; folder uploads keep their structure. Large selections are bounded and can be cancelled.

Files you open or download appear under **Recent** in the sidebar; **Favorites** collects your marked entries. On desktop these open compact menus on hover, focus, or click; on mobile they open dialogs from navigation. Recent shows relative times and favorites are alphabetical. Choose a folder to open it, or a file to open its details. The outline star beside Preview and Download marks a favorite: a gold outline means it is saved. Hover or keyboard focus shows an X to remove it; tapping the selected star also removes it. Missing or inaccessible entries are omitted when the menu refreshes. PDF and office files use file-type icons in the list and grid. You can still open PDFs to view their contents. Images keep their thumbnails.

## Search {icon="search"}

The search field at the top searches names everywhere below the current folder; results show each hit with its path relative to the folder. Press Enter to search and clear the field to return to the listing. FreeIPA searches always read the current filesystem, even with an index. An unreadable subfolder stops the search; narrow the search to an accessible folder. If access changes or a result disappears while paging, start the search again. Storage without a search index is scanned on demand; if a folder holds too many entries for that, search in a smaller folder. The magnifier at the top of the sidebar opens the global Cloud search restricted to files across all your storage locations; opening a result jumps to its folder with the file selected.

## Select and act {icon="checkbox"}

A click on a file only opens its details; nothing counts as selected until you choose **Select** next to the entry count. Checkboxes then appear in every view: a click toggles an entry, Shift-click selects a range, Ctrl/Cmd-A selects the loaded page, and **Done** ends the selection. Arrow keys move the highlight, Space toggles while selecting, Escape clears. With a selection, **n selected** and an **Actions** menu appear below the search field: download (one file directly, several entries or folders as one ZIP), move into a new folder, move to another folder, copy to this or another storage, share publicly, or move to the trash. Right-click a row for the same actions.

Multi-entry actions can partly succeed. Completed items stay completed; the interface keeps failed items available to retry. Moving stays inside one storage location. Copying can target another compatible storage location and keeps the originals. You can copy between Cloud and FreeIPA storage when you can read the source and write to the destination. The target keeps its own ownership rules.

## Edit documents together {icon="users"}

When your administrator has connected Collabora Online, text documents, spreadsheets and presentations (`odt`, `ods`, `odp`, `docx`, `xlsx`, `pptx`) open in an editor that fills the main area: double-click the file or use **Edit** in its details panel. Several people can work in the same document at once and see each other's changes. The document name appears in the top bar; Collabora shows when it last saved, and its close button (X) returns to the folder with the file selected. If you may only read a file, it opens read-only. Cloud checks for changes before saving and coordinates its own writes. If someone changed the file, Collabora offers a conflict dialog; only choose Overwrite if you intend to replace those changes. External NFS writes cannot be fully coordinated. Every save becomes the current file; the file's version history stays in its details panel. Reopen the editor after changing theme to apply the new theme.

The plus menu then also offers **New text document**, **New spreadsheet** and **New presentation**. You enter a name, the file extension is added for you, and the new document opens in the editor.

## Add, upload, and change entries {icon="upload"}

The plus button next to the search field offers **Upload**, **Upload folder**, **New folder**, and **New file**. You can also drop files from your computer onto the list. Each file is transferred directly to the file server after Cloud has checked your access, and it is published only when the whole transfer has arrived. Progress appears in a notification with a progress bar. If names already exist you decide once per upload whether to replace them or upload only the new files. Retrying the same unchanged file to the same destination reuses its upload session. After an uncertain result, check what happened before starting a different upload. Names cannot contain slashes.

The details panel of an entry offers **Open in new tab**, **Rename**, **Duplicate**, **Move to**, **Copy to**, **Share publicly**, and **Move to trash**. Folders additionally offer **Share as upload inbox**. The copy button in the panel header copies a Cloud reference to the clipboard that other apps understand.

## Trash {icon="trash"}

Deleting never removes anything permanently: entries move into the trash of their storage location, which appears as **Trash** at the end of the root folder and in the sidebar. Open it to see what you deleted; **Restore** puts an entry back to its original place. An item without a recorded original location asks for a destination path including its name. Existing files are never overwritten. Pending moves remain visible until their outcome is confirmed. Use pagination for further entries. Only an administrator can empty the trash.

## Versions {icon="history"}

Where the storage keeps versions, the details panel lists earlier versions of a file at the bottom. For each version you can add a comment, download it, restore it in place, or restore it as a new file next to the current one. Restoring as a new file leaves the original file and its history unchanged. Only administrators can permanently delete versions. Restoring in place keeps the current state as a new version.

## Share publicly {icon="share"}

Select entries and choose **Share publicly**, or share a folder as an **upload inbox** from its details. Name the share and choose 1, 7, 30 or 90 days, or no expiry. An internal note stays private; a separate public note is shown to visitors. Copy the link when it appears: it is shown only once and cannot be retrieved later. **Shares** lists your links and lets you revoke them, even if you can no longer access their files. Administrators can revoke any link. Changes in your access also prevent new public actions; already issued transfers can finish during their short lease lifetime.

You can set an optional password when creating either kind of link. Use at least 8 characters and share it separately from the link. Visitors enter it before viewing or uploading. Browser access lasts twelve hours; if it expires, reload the page and enter the password again. You cannot retrieve the password later. Revoke the link and create a new one to change its password.

Download shares show the current contents. Visitors can open shared folders, download individual files or get a ZIP. Later changes and newly added files in shared folders become visible.

An inbox accepts files without granting access to the destination's contents. Set a maximum per file and a cumulative total; defaults are 100 MiB and 1 GiB. Deleting received files does not free that total. In-progress uploads reserve space; uncertain transfers may keep space reserved until checked. Existing files are never replaced. By default visitors get only their upload confirmation. Enable the names option to let everyone with the inbox link see names of successful uploads through this inbox; it does not expose other files or offer downloads.

## Download a file {icon="download"}

Select **Download** beside a file. Cloud checks your current access and prepares a short-lived download directly from the file server. If preparing the download fails, the error appears above the list and you can try again.

Select several entries or a folder and use **Download** to receive a ZIP.

## Use the terminal {icon="terminal"}

After signing in with `cld login --server <Cloud URL>`, use `cld filesv2 bases list --json` to find your base ID. List a folder with `cld filesv2 list <base-id> --path Documents --json`. The result includes `next`; pass it unchanged as `--after` for the next page.

Download a file with `cld filesv2 download <base-id> Documents/report.pdf --out ./report.pdf`. The CLI downloads directly from Filegate to a new local file. Existing paths are never overwritten. Use `--json` for the saved path and byte count, or `cld filesv2 help` for all available commands.

`cld filesv2 search <base-id> report --path Documents --json` searches names below a folder and `cld filesv2 mkdir <base-id> Documents/2026` creates a folder. `rename`, `move --to`, `copy --to [--target-base]`, `delete`, `trash list|restore`, `versions list|comment|restore|download`, `shares list|create|revoke`, `archive --out` for a ZIP of several entries, and `documents create --kind` plus `edit-url` for office documents cover the remaining operations. `cld filesv2 upload <base-id> ./report.pdf --to Documents/report.pdf` uploads a file directly to the file server; add `--replace` to replace an existing file. `cld filesv2 stat <base-id> <path> --json` reads current file details. `cld filesv2 thumbnail <base-id> Photos/team.jpg --out ./team.png` saves an image preview.

## When storage is unavailable {icon="alert-circle"}

An empty folder has a different meaning from a missing or unavailable directory. The page shows whether a directory is missing, needs assignment or cannot currently be reached. Contact your administrator when a directory needs attention.

Cloud storage requires enabled local Linux identities. Only POSIX groups can have group storage. FreeIPA storage is configured independently; a FreeIPA user can also see accessible local Cloud group storage.

## Edit Markdown and use templates {icon="markdown"}

Open a `.md` or `.markdown` file in the full workspace editor, or choose **Add → Markdown document**. Markdown editing works without the office editor. UTF-8 files up to 2 MiB are supported. Save with the editor button or Ctrl/Cmd+S. Save and X are on the right of the toolbar. A brief check confirms a successful save; X returns to the folder. Leaving asks about unsaved changes. If saving fails or the file has changed, your draft stays open: reload the file or save a copy under a new name.

**Add → Template** shows the templates available to you. Choose one and a name to create an independent file in the current folder. You need write access there. Existing files are never replaced. A template may be available even when you cannot access its original file. Later changes to the template do not change your copy. If no templates appear, an administrator can grant you or your groups access.

Use `cld filesv2 documents markdown <base-id> Notes.md`, `cld filesv2 templates list --json`, and `cld filesv2 templates use <template-id> <base-id> Notes.md` for the same actions in the terminal. For conditional replacement, add `--replace --expected-revision <revision>` to `upload`; a conflict leaves the current file untouched.

## Use files with Assistant {icon="sparkles"}

Assistant can discover your storage, read files for analysis and save results
back into a folder you can write to. In code mode, files travel as binary
streams; a file can be up to 50 MiB. You can also ask Assistant to create folders,
rename, move or copy entries, or move them to the trash and restore them.

The same access rules apply as in Files. Actions use Assistant's usual approval
flow. New results do not overwrite existing files by default; replacing a file
requires its current revision. If a write is interrupted, Assistant can check
its status before retrying. It cannot permanently delete your files.
