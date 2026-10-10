---
id: grids-custom-apps
title: Grids Apps
icon: ti ti-app-window
description: Choose a guide to build, publish, or use a focused Grids App.
order: 137
---
A Grids App gives signed-in or public audiences a focused app at `/apps/<id>`. It does not open the full Grids workspace. Each app belongs to one Base and combines existing records, views, forms, documents, and workflow actions.

Apps do not copy data. Publishing freezes the definition and the exact resources that the app can use. Each request checks the current access to the app and the published capability. People who use an app do not need access to the Base. Access to an app never allows arbitrary GQL or raw access to the Base.

## Choose your next step {icon="arrow-right"}

- [Build a Grids App](/app/grids/help/grids-build-custom-app): Create a list, a submission flow, and a record detail page in the visual builder.
- [Pages & blocks](/app/grids/help/grids-custom-app-pages-blocks): Choose blocks, connect record parameters, and configure editable fields, documents, and actions.
- [YAML & CLI](/app/grids/help/grids-custom-app-yaml-cli): Follow the complete definition example. Validate, plan, apply, and export it.
- [Publish a Grids App](/app/grids/help/grids-publish-custom-app): Review access, publish a draft, restore the live version, or unpublish.

You need **Manage** access to the Base to build and publish an app. People who use the app see only what the publication exposes. Public access includes anonymous visitors, but workflow actions require a signed-in account.

## Use an app from the terminal {icon="terminal-2"}

Run `cld grids apps runtime read <app-id> --json` with the ID from the app URL. The result lists the visible pages, block IDs, data, form fields, and available actions. You do not need access to the Base. To open a detail page, add `--page <page-id> --params '{"request_id":"REC001"}'`. Use the parameter name and the record ID from the returned navigation.

The `apps runtime` commands can:

- read paged records;
- submit page or sidebar forms;
- update published editable fields;
- add and remove comments and attachments;
- download stored PDFs;
- run actions or scanners and read their run status.

Run a command with `--help` to see its inputs. Page commands require the same parameters as the discovery command.

:::warning Retry without duplicates
Submissions, updates, scans, and actions require `--yes`. Retry a form submission only with the exact same body and its explicit `idempotencyKey`. A create without a key can run twice. Reuse an operation ID only for the same action. **Queued** means accepted, not finished: inspect the run before you retry.
:::

These commands use the same published app access as the browser. They cannot bypass unavailable blocks. A detail record that is missing, deleted, invalid, unavailable, or not allowed returns a not-found error.

## Keep the draft and the publication separate {icon="versions"}

The builder saves complete edits to the draft automatically. Editing does not change the live app. **Publish changes** validates and publishes the saved draft. If it reports diagnostics, fix them before you try again.

The builder also offers **Publish changes** when the live app uses a form, view, field, template, or workflow that changed and needs a new publication. If the draft has no other changes, the notice reads **Used resources changed**.

**Restore live version** discards pending draft changes. In **App settings → Lifecycle**, you can unpublish or delete the app. Both actions require a confirmation:

- Unpublishing removes the live snapshot but keeps the draft and the access entries.
- Deleting an app removes its route. It does not delete Base data.

An app loads only the active page and its optional record. It does not load hidden detail pages in advance.
