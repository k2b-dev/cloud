---
id: grids-custom-apps
title: Grids Apps
icon: ti ti-app-window
description: Choose a guide for building, publishing, or using a focused Grids App.
order: 137
---
Grids Apps give authenticated or public audiences a focused app at `/apps/<id>` without exposing the full Grids workspace. Each app belongs to one Base and composes existing records, Views, Forms, documents, and Workflow actions.

Apps do not copy data. Publishing freezes the definition and the exact resources it may use. Each request checks the current App grant and published capability. App readers do not need Base access; an App grant never permits arbitrary GQL or raw Base access.

## Choose your next step {icon="arrow-right"}

- [Build a Grids App](/app/grids/help/grids-build-custom-app): create a list, submission flow, and record detail page with the visual builder.
- [Pages & blocks](/app/grids/help/grids-custom-app-pages-blocks): choose blocks, wire record parameters, configure editable fields, documents, and actions.
- [YAML & CLI](/app/grids/help/grids-custom-app-yaml-cli): follow the complete definition example and validate, plan, apply, and export it.
- [Publish a Grids App](/app/grids/help/grids-publish-custom-app): review access, publish a draft, restore the live version, or unpublish.

You need Base **Admin** access to build and publish. Readers use only what the publication exposes. Public grants include anonymous visitors, but Workflow actions require a signed-in account.

## Use an App from the terminal {icon="terminal-2"}

Run `cld grids apps runtime read <app-id> --json` with the ID from the App URL. It returns visible pages, block IDs, data, Form fields, and available actions. You do not need Base access. Open a detail page with `--page <page-id> --params '{"request_id":"REC001"}'`, using the parameter name and Record ID from the returned navigation.

The `apps runtime` commands read paged records, submit page or sidebar Forms, update published editable fields, manage comments and attachments, download stored PDFs, invoke actions or scanners, and read their run status. Use `--help` for a command's inputs. Page-scoped commands require the same parameters as discovery.

Submissions, updates, scans, and actions require `--yes`. Form submissions are not retry-idempotent. Reuse an action's operation ID only when retrying the same operation. **Queued** means accepted, not finished: read the returned run status before deciding to retry.

These commands use the same published App permissions as the browser. They cannot bypass unavailable blocks. Missing, deleted, invalid, unavailable, or unauthorized detail records return **Not Found**.

## Keep draft and publication separate {icon="versions"}

The builder automatically saves complete edits to the draft. Editing does not change the live App. **Publish changes** validates and publishes the saved draft; fix its diagnostics before retrying.

**Restore live version** discards pending draft changes. Under **App settings → Lifecycle**, unpublishing removes the live snapshot but keeps the draft and grants; deleting an App removes its route without deleting Base data. Both actions require confirmation.

Only the active page and its optional record are loaded. Hidden detail pages are not prefetched.
