---
id: notebooks-settings-access
title: "Settings & access"
icon: "ti ti-settings"
description: "Choose the default view and change notebook details, access, who can delete and lock notes, and exports."
order: 170
---

You need **Edit** or **Manage** access for these settings. Open **Settings** from the notebook sidebar. Settings open in a dialog, so your current note stays in place. In **Book**, first use the pencil button to edit an unlocked note.

## Choose how the notebook opens {icon="book"}

People with **View** access always see **Book**. Book is a reading view with page navigation and tag filters. It has no editing controls, no detail panel, and no page discussions. The server renders query blocks (`:::query`) and tables of contents (`:::toc`) with the page. Mermaid diagrams render in the browser. Without JavaScript, or if rendering fails, their source stays readable.

In Book, page links, tag filters, search, and pagination update the content without a full reload. **Back** and **Forward** in the browser return to earlier reading positions. Saved changes refresh the page and the query results automatically. Without JavaScript, navigation still works through normal page loads.

In the Book sidebar, select a page to open it. Use the arrow next to a page to show or hide its sub-pages. When Book loads, it shows the current page with its sub-pages. After that, Book keeps your choices and unfolds only the pages that contain the page you open. On a phone, the navigation menu shows the same folded pages. It keeps them when you close and reopen it, and it opens pages in place.

The sidebar lists the start page of the notebook first, with its sub-pages below it. This also applies when the start page is under another page. All other pages follow the notebook order on each level:

- the order that people with **Edit** or **Manage** access arranged by hand;
- otherwise title order, sorted for your language. Numbers count as numbers, so "Chapter 2" comes before "Chapter 10".

The order updates when a title, the start page, or the arranged order changes. Set the start page in **Settings → Notebook → General**. To arrange the order, see **Arrange notes** in **Write & organize**.

When you open the notebook itself in Book, Book shows the start page. Without a start page, it shows the first page in the sidebar. If you last had a page of this notebook open in **Write** or **Read-only**, Book shows that page instead.

With **Edit** or **Manage** access, you can switch between three views:

- **Write:** Edit the note and use the detail panel.
- **Read-only:** Keep the editor workspace and the detail panel without editing the note text.
- **Book:** Read the notebook as a handbook, without the editor workspace.

In **Write**, use the book icon in the bottom toolbar to open Book. The detail panel also offers actions for Book and **Read-only**. In **Read-only**, choose **Edit note** in the detail panel to return to **Write**.

Book and **Read-only** show a round pencil button at the bottom right when you hover over the document. Keyboard focus also shows it. On touch devices, it stays visible. Locked notes show no edit action.

If no note is selected or the note is locked, Book shows **Open workspace** in the sidebar to people with **Edit** or **Manage** access. Use it to open the settings or to create a note. If you hid the navigation, first show it with the button at the bottom left.

You need **Manage** access to change the default view for people with **Edit** or **Manage** access:

:::steps
1. Open **Settings → Notebook → View & behavior**.
2. Change **Default view**.
:::

Notebooks saves the change immediately. The first default is **Write**. A view in the page URL comes before the notebook default.

Locked notes open in **Read-only** instead of **Write**. A lock does not remove access to page discussions in the detail panel.

## Decide who can delete and lock notes {icon="trash"}

:::warning You cannot undo a delete or a lock
By default, everyone with **Edit** access can delete notes and lock them permanently.
:::

With **Manage** access, you can limit both actions:

:::steps
1. Open **Settings → Sharing → Access**.
2. Set **Who can delete and lock notes** to **Admins only**.
:::

Notebooks saves the change immediately.

The setting covers only deleting and locking whole notes. People and agents with **Edit** access still edit notes as before, including removing text. The version history keeps earlier versions.

For these people, **Delete** and **Lock note** in the note menu stay visible but are turned off. They show the reason: this notebook is set to **Admins only**. The API, `cld notebooks rm`, and `cld notebooks lock` refuse with the same reason. A locked note keeps its versions readable. You can no longer edit it or restore it from a version.

## Find the right settings tab {icon="settings"}

:::reference
- **Notebook → General:** Name, icon, description, start page, and the Liquid template for the H1 of empty new notes. Check the footer, then save or discard your changes.
- **Notebook → View & behavior:** People with **Manage** access choose the shared default view. This browser stores your sidebar layout and your Tab key choice, and they apply immediately.
- **Sharing → Access:** Requires **Manage** access. Change who has access, and choose who can delete and lock notes. Changes save immediately.
- **Sharing → API keys:** Requires **Manage** access. API keys for integrations that work only with this notebook. Changes save immediately, and Notebooks shows a new key only once.
- **Data → Export & snapshots:** Requires **Manage** access. Portable ZIP exports, the S3 snapshot setup, manual uploads, and recent snapshot runs. Save the snapshot setup with the footer.
- **Lifecycle → Danger zone:** Requires **Manage** access. Actions that destroy data, such as deleting the notebook and its notes.
:::
