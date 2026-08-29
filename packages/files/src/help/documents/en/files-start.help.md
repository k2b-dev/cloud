---
id: files-start
title: Start
icon: ti ti-folders
description: File bases, folder paths, browsing, upload, and the detail workflow.
order: 100
---

Files browses the home and group file bases your IPA account can access, then lets you upload, move, search, and manage items there. The Files overview already lists every accessible base, so you can choose the correct storage root before opening a folder.

## Overview {icon="layout-grid"}

:::reference
- **File base:** One storage root. Your home base belongs to your IPA user; group bases come from your group memberships.
- **Folder path:** The current directory inside the selected base. Breadcrumbs and URLs keep the path shareable inside the app.
- **Selection:** Selected items enable bulk actions such as move, download, delete, and select all.
- **Detail panel:** Selecting a file opens metadata and actions without leaving the current folder or search results.
:::

## First useful path {icon="route"}

:::reference
- **Choose a base:** Open your home storage or a group storage from the sidebar. Files redirects to the first accessible base when possible.
- **Browse or search:** Use folder search for the current directory or the Search page for glob patterns across selected bases.
- **Upload or create:** Use the plus menu to upload files, upload a folder, or create a new folder in the current path.
- **Open details before changing:** The detail panel shows path, kind, modified time, size, preview actions, and file operations.
:::

:::info Access comes from IPA
Files is available to full IPA users. Home access is tied to your user UID, and group storage is tied to recursive IPA group membership.
:::
