---
id: notebooks-settings-access
title: "Settings & access"
icon: "ti ti-settings"
description: "Configure notebook details, permissions, exports, feature flags, and destructive actions."
order: 170
---

Open **Settings** from the notebook sidebar. Settings stay in a modal, so your current note remains in place.

**Admin and workspace settings**

## Settings tabs {icon="settings"}

:::reference
- **Notebook — General:** Name, icon, description, default start page, and the Liquid template used to initialize the H1 of empty new notes. Review the footer, then save or discard your changes.
- **Notebook — View & behavior:** Your sidebar layout is stored in this browser and applies immediately. Script blocks are shared notebook behavior and require admin permission.
- **Sharing — Access:** Admin-only permission editor. Permission changes save immediately.
- **Sharing — API keys:** Admin-only resource credentials for integrations. Changes save immediately, and new tokens are shown once.
- **Data — Export & snapshots:** Admin-only portable ZIP exports, S3 snapshot configuration, manual uploads, and recent snapshot runs. Snapshot configuration uses the persistent save footer.
- **Lifecycle — Danger zone:** Admin-only destructive actions such as deleting the notebook and its notes.
:::

**Safety**

## Script feature flag {icon="shield-lock"}

:::warning Enable scripts only for trusted notebooks
Scripts run in each viewer's browser and can perform notebook actions with that viewer's permissions. Keep scripting disabled when editors or note content are not trusted.
:::
