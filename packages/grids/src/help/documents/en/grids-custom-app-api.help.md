---
id: grids-custom-app-api
title: Custom App API reference
icon: ti ti-code
description: Look up definition options, defaults, bindings, validation, and published form payloads.
order: 137
---
For visual authoring, read [Build your first Grids App](/app/grids/help/grids-build-custom-app).

A private app page sends a signed-out visitor to the sign-in page and then back to the same path and query. Public apps, API and download statuses, and the 404 for a signed-in visitor without access stay unchanged. See [Forms](/app/grids/help/grids-forms) for the form layout.

## Read the installed contract {icon="code"}

`cld grids apps reference --json` or `GET /api/grids/apps/reference` returns `definitionSchema`. This generated input JSON Schema lists every property, enum, default, required key, and size limit.

Run `cld grids apps validate BASE --source-file app.yaml --json` for cross-field, query, access, and publication checks. Fix the returned `diagnostics` paths. JSON Schema alone does not prove that you can publish.

## Define identity, pages, and layout {icon="layout-grid"}

The root requires `schemaVersion: 5`, `kind: grids.custom-app`, `id`, `baseId`, `name`, `startPageId`, and `pages`. Optional root keys are `icon` and `sidebar`. Names have 1–200 characters. Icons are Tabler slugs such as `file-invoice`, not CSS class names.

Resource IDs are exactly six case-sensitive letters or digits. Local page, row, column, block, and action IDs start with a lowercase letter. They use lowercase letters, digits, and hyphens, up to 80 characters. Parameter names use underscores instead of hyphens. IDs must be unique within their container. Block IDs are unique across the whole page.

| Object | Required | Optional and defaults |
| --- | --- | --- |
| Page | `id`, `title` (1–200), `rows` (1–24) | `navigation` defaults to `{visible:true}`; `parameters` defaults to `{}`; `record`, `availableWhen` |
| Navigation | none | `visible:true`, `icon` |
| Parameter | `type:record`, `tableId`, `required:true` | no other types or default values |
| Page Record | `tableId`, `id:{source:PARAMS,path:parameter_name}` | none |
| Row | `id`, `columns` (1–12) | none |
| Column | `id`, `span` (integer 1–12), `blocks` (1–24) | none |

An app has 1–12 pages. The column spans of one row total at most 12. The start page has no required parameters.

A Record page has these rules:

- It declares exactly its bound Record parameter.
- It uses the same table in both declarations.
- It sets `navigation.visible:false`.
- It contains a `record` or `html` block.

Other pages with parameters are also route-only. Navigation must supply all target parameters exactly once, with compatible Record types.

## Set every block option {icon="blocks"}

Every block requires `id` and `type`. All blocks accept an optional `title` (1–160 characters), `availableWhen:{query}`, and `disclosure:{label,defaultOpen?}`. Queries have 1–20,000 characters. Omit optional values instead of writing `null`. Only `records`, `referenced_records`, and `record` support `emptyText` (1–240 characters).

| `type` | Additional required keys | Optional keys and defaults |
| --- | --- | --- |
| `markdown` | `markdown` (up to 20,000 characters; empty is allowed) | `disclosure:{label,defaultOpen?}` |
| `records` | `source`, `display` | `emptyText`, `searchable:true`, `pageSize:25` (5–100), `workflowStatus`, `rowNavigate`, `rowActions` (up to 6), `disclosure:{label,defaultOpen?}` |
| `referenced_records` | `sourceTableId`, `relationFieldId`, `fieldIds` (1–30), `display:{kind:table\|cards}` | `emptyText`, `searchable:true`, `pageSize:25` (5–100), `rowActions` (up to 6), `disclosure:{label,defaultOpen?}` |
| `metrics` | `source` | `valueFormat` (common override for all values in this block), `disclosure:{label,defaultOpen?}` |
| `chart` | `source`, `chartType:donut\|bar\|line` | `subtitle` (1–200), `limit:100` (1–100), `valueFormat`, `xAxisLabel`, `yAxisLabel` (each 1–60), `disclosure:{label,defaultOpen?}` |
| `record` | `fieldIds` (1–30) | `emptyText`, `editableFieldIds:[]` (up to 30), `layout:grid\|rows\|compact\|summary\|context`, `relativeDates`, `heading:{fieldId,documentNumber?,title?}`, `documents:{templateIds:[…]}` (1–12), `disclosure:{label,defaultOpen?}` |
| `html` | `fieldId` | `height:normal` (`compact\|normal\|large`), `disclosure:{label,defaultOpen?}` |
| `comments` | none | `disclosure:{label,defaultOpen?}` |
| `form` | `formId` | `mode:create` (`create\|edit`), `fixedValues:{}`, `onSuccessNavigate`, `actionsBlockId`, `workspace:{summaryTitle?,summaryDescription?,helpTitle?,helpText?}`, `presentation:{kind:dialog,label,icon?,variant?}`, `disclosure:{label,defaultOpen?}` |
| `actions` | `actions` (1–12) | `disclosure:{label,defaultOpen?}` |
| `scanner` | `launcherId` | `disclosure:{label,defaultOpen?}` |

`source` is exactly `{kind:view,viewId}` or `{kind:gql,query}`. For `records`, `display` is `{kind:table,columnIds:[…]}` (up to 30) or `{kind:cards}`.

- A table from a saved view needs at least one column.
- An inline GQL table normally uses the selected columns of the query with `columnIds:[]`. A non-empty list narrows the displayed fields and keeps the selected fields for behavior.
- Cards inherit the Cards configuration of a saved view and cannot use inline GQL.
- Metrics require ungrouped scalar aggregates (up to 12). Charts require grouped aggregates (up to 100 groups).
- An app allows at most four Records blocks, 24 insight blocks, and 24 Scanner blocks.

`referenced_records`, `record`, `html`, and `comments` require a bound page Record. Incoming relations must target its table. Across Record and HTML blocks, a page can expose at most 30 distinct fields. Editable fields are an explicit writable subset of the displayed fields. `documents.templateIds` allows reading existing generated documents. It does not allow issuing new ones. An `html` block displays an existing HTML field in an isolated frame.

`documents.preview:true` allows PDF previews of saved drafts, including the queried data of the templates. It does not issue and does not reserve a number. Source interpolation accepts only `{{ record.id }}` or `{{ record.shortId }}`, without Liquid filters or tags. Changes to a template or to the Base schema require a new publication.

`valueFormat` requires `style:number|integer|percent`. Optional keys are `decimalPlaces` (0–20), `unit` (1–20 characters), and `unitPosition:prefix|suffix`. The integer style rejects decimal places. Only the number style accepts a custom unit. A unit position requires a unit. Omitted formatting options use the normal renderer formatting.

## Configure actions and bindings {icon="arrows-right-left"}

Actions in an `actions` block require `id`, `label` (1–120), and `kind`. Both kinds accept `icon` and `availableWhen`.

- `kind:navigate` also requires `pageId` and `params`. `history` defaults to `push` and also accepts `replace`.
- `kind:workflow` also requires `launcherId`. `inputs` defaults to `{}`. `confirm` optionally supplies confirmation text (1–240 characters).
- Row actions use only `kind:workflow`, with the same keys plus `showLabel:true`. `false` requires an icon. The label stays required for accessibility.
- `rowNavigate` has `kind:navigate`, `pageId`, `params`, and an optional `history:push|replace`. It has no label and no action ID.
- `onSuccessNavigate` has `kind:navigate`, `pageId`, and `params`. A successful submission replaces the history entry. There is no `history` option here.

### Ask for workflow inputs

Bind every required workflow input, or ask for it with `prompt: { inputs: ["date", "amount"], description?, successMessage? }`. Prompt names select unbound scalar workflow inputs: text, decimal, number, date, dateTime, boolean, or select. Labels and validation come from the published workflow. These actions open a compact dialog. When the outcome is uncertain, the dialog keeps the submitted values and the operation key. A prompt cannot be combined with `confirm`, `background`, fixed launchers, or row actions. Browser input never overrides server bindings.

A prompt submission that still waits for its outcome stays in this browser tab across reloads. A status action on the original page stays available, even if the original button disappears. Retries keep the original workflow launcher. A new publication of the action never redirects an existing attempt to another workflow. Check the status before you start another submission.

:::warning Local recovery ends with the tab
Closing the tab or clearing the browser storage removes this local recovery handle. Check the existing entries before you submit again.
:::

### Bind values

Bindings are objects, not expressions. The accepted sources depend on the position:

| Position | Accepted binding shapes |
| --- | --- |
| Navigation action `params` | `{source:PARAMS,path:name}`, `{source:RECORD,path:id}` |
| Row navigation `params` | `{source:ROW,path:id}`, `{source:ROW,path:relation,fieldId}`; the latter must be a selected single relation |
| Workflow `inputs` | `{source:LITERAL,value:JSON}`, `PARAMS`, `RECORD`; row actions additionally accept `{source:ROW,path:id}` |
| Form `fixedValues` | `LITERAL`, `PARAMS`, `RECORD`, `{source:AUTH,path:currentUser}` |
| Form success `params` | `PARAMS`, `{source:RESULT,path:recordId}` |
| Sidebar fixed values | `LITERAL`, `AUTH.currentUser` only |
| Sidebar success `params` | `RESULT.recordId` only |

Fixed-value keys are public form field IDs. Workflow input keys are the input names of the launcher. Bindings must match their target types. `AUTH.currentUser` requires a signed-in user and a compatible principal field. Grids removes fixed fields from the submitted inputs and evaluates them again on the server.

`sidebar.actions` contains up to 12 global form actions. Each requires `id`, `label`, `kind:form`, and `formId`. Optional keys are `icon`, `tone:default|success|danger` (default `default`), `availableWhen`, `fixedValues:{}`, and `onSuccessNavigate`. Sidebar forms always create records. They have no context of the current page or Record.

## Control availability and access {icon="shield-lock"}

`availableWhen:{query}` applies to pages, blocks, and actions. A result row means available. An empty result or an error means unavailable. The server checks reads and writes again. The typed context is `@auth`, the declared `@params`, `@page`, `@app`, `@base`, and `@time`. Global sidebar queries cannot use page or parameter context. See [GQL](/app/grids/help/grids-gql) for the syntax.

Authoring requires **Manage** access to the Base. People who use the app receive only the published scopes, not raw access to the Base. Workflow actions and scanners require sign-in. All writes keep the runtime access, finalization, and mutation-policy checks. Hidden navigation is not authorization.

## Submit and edit forms through the API {icon="forms"}

First run `cld grids apps runtime read APP --page PAGE --params '{"item_id":"REC001"}' --json`. The `form` result of each form block contains `form`, `fields`, `inlineTargetFields`, `submitUrl`, and, in edit mode, `initialRecord`. Keep the same page parameters when you call `apps runtime submit APP PAGE BLOCK --body-file submission.json --yes`.

Create accepts a field-value object or `{data,inlineCreates?,idempotencyKey?}`. Edit requires `{data,version,idempotencyKey,inlineCreates?,inlineUpdates?}`. IDs in `data` are public field IDs. Relation values are public record IDs or temporary IDs that `inlineCreates` declares.

An `object_list` is one field value, not a relation: `{"data":{"ITEMS1":[{"Label1":"Consulting","Amount":"19.95"}]}}`. Find column IDs and rules in `fields[].config`. Send exact decimals as strings and omit calculated cells. Sending the list replaces all its rows. `[]` clears it, if allowed. You need no `inlineCreates`. See [list rules and formulas](/app/grids/help/grids-tables-fields).

```json
{
  "version": 3,
  "idempotencyKey": "edit-invoice-unique-attempt",
  "data": {"TITLE1": "Consulting", "LINES1": ["LINE01", "tmp_new"]},
  "inlineUpdates": {"LINES1": [{"recordId": "LINE01", "version": 2, "data": {"TEXT01": "Consulting day"}}]},
  "inlineCreates": {"LINES1": [{"tempId": "tmp_new", "data": {"TEXT01": "Travel"}}]}
}
```

Use the discovered IDs and full form values. Keep required inputs, and send explicit empty values to clear a value. Related inputs allow only `inlineCreate.fields`, at most 20 creates or updates per relation, and 50 in total. Edited children must stay linked exclusively to this parent in the same Base. Detaching does not delete children. Finalized records are read-only. All writes commit or roll back together.

`initialRecord` contains the root `version`, the editable `values`, and drafts in `inlineCreates` with `{tempId,data,existing:{id,version}}`. Replace existing temporary references with `existing.id`. Send edits of existing records as `inlineUpdates`, and only new drafts as `inlineCreates`. `initialRecord` is not a write payload.

The server chooses the edit target from the bound page Record, never from a `recordId` in the body. For people with **Edit** access to the Base, the equivalent is `cld grids forms submit BASE TABLE FORM --record REC001 --body-file submission.json --yes`, with current versions from `records show`. The HTTP endpoint is `POST /api/grids/forms/FORM/records/REC001`. Create uses `POST /api/grids/forms/FORM/submit`.

### Retry safely

:::reference
- **Keys:** Not blank, at most 200 characters, no NUL. A key applies to the combination of form, table, and actor.
- **Exact retry:** Returns the original record ID and writes nothing again.
- **Conflict (`409`):** A changed payload, a deleted result, or a stale version.
- **Timeout:** Retry the same body with the same key, or inspect the result. A create without a key can run twice.
- **Confirmed stale version:** Reload and review before a new attempt.
- **Not saved:** Validation errors (`400`/`422`) and access errors (`401`/`403`/`404`).
- **Success:** Create returns `201`, edit returns `200`, with `recordId` and the optional success navigation of the app.
:::

### Run document actions in the background

Workflow actions can set `background: { acceptedMessage, documentBlockId, documentTemplateId }`. This requires a Record page and an unconditional Record block that exposes that template. Each page has one background result template. `GET` on the action endpoint recovers the current document status. `POST` returns the acceptance immediately. These actions return the document presentation instead of a run ID. Only people who can currently use the app can read that presentation. `needs_attention` prevents another start. A finished document opens directly. See [Grids App pages & blocks](/app/grids/help/grids-custom-app-pages-blocks).
