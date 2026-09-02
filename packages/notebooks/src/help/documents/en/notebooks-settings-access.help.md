---
id: notebooks-settings-access
title: "Settings & access"
icon: "ti ti-settings"
description: "Choose the default view and configure notebook details, permissions, exports, and scripts."
order: 170
---

Open **Settings** from the notebook sidebar. Settings stay in a modal, so your current note remains in place.
If you are in **Book**, switch to **Write** or **Read-only** first. These views are available to notebook editors and admins.

## Choose how the notebook opens {icon="book"}

Users with read permission always see **Book**: a reading view with page navigation and tag filters, without editing controls, the detail panel, or page discussions. Query blocks (`:::query`) and tables of contents (`:::toc`) are rendered on the server with the page. Mermaid diagrams render in the browser; their source stays readable without JavaScript or if rendering fails.

Editors and admins can switch between three views:

- **Write:** Edit the note and use the detail panel.
- **Read-only:** Keep the editor workspace and detail panel without editing the note body.
- **Book:** Read the notebook as a handbook, without the editor workspace.

To choose the default for editors and admins, open **Notebook — View & behavior** and change **Default view**. Only notebook admins can change it, and the change saves immediately. The initial default is **Write**. A view chosen explicitly in the page URL takes precedence over the notebook default.

Locked notes open in **Read-only** instead of **Write**. Locking does not remove access to page discussions in the detail panel.

## Settings tabs {icon="settings"}

:::reference
- **Notebook — General:** Name, icon, description, default start page, and the Liquid template used to initialize the H1 of empty new notes. Review the footer, then save or discard your changes.
- **Notebook — View & behavior:** Admins choose the shared default view and whether to enable scripts. Your sidebar layout is stored in this browser and applies immediately.
- **Sharing — Access:** Admin-only permission editor. Permission changes save immediately.
- **Sharing — API keys:** Admin-only resource credentials for integrations. Changes save immediately, and new tokens are shown once.
- **Data — Export & snapshots:** Admin-only portable ZIP exports, S3 snapshot configuration, manual uploads, and recent snapshot runs. Snapshot configuration uses the persistent save footer.
- **Lifecycle — Danger zone:** Admin-only destructive actions such as deleting the notebook and its notes.
:::

## Script feature flag {icon="shield-lock"}

:::warning Enable scripts only for trusted notebooks
Scripts can run in the editor workspace and perform notebook actions with the viewer's permissions. Keep scripting disabled when editors or note content are not trusted. Book shows script source without executing it.
:::
