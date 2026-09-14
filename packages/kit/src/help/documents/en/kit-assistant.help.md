---
id: kit-assistant
title: Program with Assistant
icon: ti ti-code
description: Program with Assistant in Kit
order: 102
---

## Create and update apps {icon="apps"}

Ask Assistant to create a new Kit app, or give it the exact URL or reference of an existing app.
You need Admin permission to have Assistant change its code. Ask for the complete
workflow, including inputs, results, file formats and error handling.

Assistant can find the app, read its revision and files, propose and validate
source changes, and save an atomic batch through Cloud approval. It reads this
Help with search_help and read_help, including the SDK articles; there is no
separate SDK capability. App deletion, database reset and sharing stay in Kit.

`kit.app.create` creates an app with a README page and optional `databaseEnabled`.
`kit.app.update` changes name, description or database activation using the exact
`expectedRevision`. Disabling preserves data. RSQL must be enabled by the operator.
Both return the app identity and current database status; if provisioning is pending,
keep the app and check `kit.database.status` instead of creating another one.
Creation and settings offer **Always allow**. Source and database writes still
require confirmation. Permissions are checked on every call.

Source operations are kit.app.search, kit.app.read, kit.source.read,
kit.source.validate and kit.source.apply. File reads return UTF-16 windows;
continue with nextOffset until complete at the same revision. Changes accept
expectedRevision, upsert (whole files), delete (paths) and edits (one range per
file: path, offset, deleteCount, content). A path appears in only one operation.
Omitted files remain unchanged. Requests including JSON must fit 256 KiB; use
focused edits for large files. Validation checks syntax, imports and tool
entrypoints, without executing source. Invalid final projects cannot be saved.

After saving, open the app and click **Start** to test. Assistant cannot read your
browser's local files or results. Supply suitable sample input or error messages
when needed. A static validation result is not proof that processing works.
On conflicts, reread and reconcile. After an unknown save outcome, check the
current revision and files before retrying.

[Start with the complete CRUD example](/app/kit/help/kit-crud-example) for small shared database apps. Read exact method headings only when adapting the example. Empty row lists always return `data: []`.
