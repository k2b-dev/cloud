---
id: grids-custom-app-api
title: Custom App API reference
icon: ti ti-code
description: Definition options, defaults, bindings, validation and published Form payloads.
order: 137
---
For visual authoring, read [Build a Custom App](/app/grids/help/grids-build-custom-app). This reference covers App definitions and published Form payloads.

## Read the installed contract {icon="code"}

`cld grids apps reference --json` or `GET /api/grids/apps/reference` returns `definitionSchema`: generated input JSON Schema with every property, enum, default, required key and size limit.

Run `cld grids apps validate BASE --source-file app.yaml --json` for cross-field, query, access and publication checks. Fix the returned `diagnostics` paths; JSON Schema alone does not prove publishability.

## Identity, pages and layout {icon="layout-grid"}

The root requires `schemaVersion: 5`, `kind: grids.custom-app`, `id`, `baseId`, `name`, `startPageId` and `pages`. Optional root keys are `icon` and `sidebar`. Names have 1–200 characters. Icons are Tabler slugs such as `file-invoice`, not CSS class names.

Resource IDs are exactly six case-sensitive letters/digits. Local page, row, column, block and action IDs start with a lowercase letter and use lowercase letters, digits and hyphens, up to 80 characters. Parameter names use underscores instead of hyphens. IDs must be unique within their container; block IDs are unique across the whole page.

| Object | Required | Optional and defaults |
| --- | --- | --- |
| Page | `id`, `title` (1–200), `rows` (1–24) | `navigation` defaults to `{visible:true}`; `parameters` defaults to `{}`; `record`, `availableWhen` |
| Navigation | none | `visible:true`, `icon` |
| Parameter | `type:record`, `tableId`, `required:true` | no other types or default values |
| Page Record | `tableId`, `id:{source:PARAMS,path:parameter_name}` | none |
| Row | `id`, `columns` (1–12) | none |
| Column | `id`, `span` (integer 1–12), `blocks` (1–24) | none |

There are 1–12 pages. Column spans total at most 12 per row. The start page has no required parameters. A Record page declares exactly its bound Record parameter, uses the same table in both declarations, sets `navigation.visible:false`, and contains a `record` or `html` block. Other parameterized pages are also route-only. Navigation must supply all target parameters exactly once with compatible Record types.

## Every block option {icon="blocks"}

Every block requires `id` and `type`; all accept optional `title` (1–160 characters) and `availableWhen:{query}`. Queries have 1–20,000 characters. Omit optional values rather than writing `null`. `emptyText` is supported only by `records`, `referenced_records` and `record` (1–240 characters).

| `type` | Additional required keys | Optional keys and defaults |
| --- | --- | --- |
| `markdown` | `markdown` (up to 20,000 characters; empty is allowed) | none |
| `records` | `source`, `display` | `emptyText`, `searchable:true`, `pageSize:25` (5–100), `rowNavigate`, `rowActions` (up to 6) |
| `referenced_records` | `sourceTableId`, `relationFieldId`, `fieldIds` (1–30), `display:{kind:table\|cards}` | `emptyText`, `searchable:true`, `pageSize:25` (5–100), `rowActions` (up to 6) |
| `metrics` | `source` | none |
| `chart` | `source`, `chartType:donut\|bar\|line` | `subtitle` (1–200), `limit:100` (1–100), `valueFormat`, `xAxisLabel`, `yAxisLabel` (each 1–60) |
| `record` | `fieldIds` (1–30) | `emptyText`, `editableFieldIds:[]` (up to 30), `documents:{templateIds:[…]}` (1–12) |
| `html` | `fieldId` | `height:normal` (`compact\|normal\|large`) |
| `comments` | none | none |
| `form` | `formId` | `mode:create` (`create\|edit`), `fixedValues:{}`, `onSuccessNavigate` |
| `actions` | `actions` (1–12) | none |
| `scanner` | `launcherId` | none |

`source` is exactly `{kind:view,viewId}` or `{kind:gql,query}`. For `records`, `display` is `{kind:table,columnIds:[…]}` (up to 30) or `{kind:cards}`. Saved-view tables need at least one column; inline GQL tables normally use the query's selected columns with `columnIds:[]`; a non-empty list narrows displayed fields while retaining selected fields for behavior. Cards inherit a saved View's Cards configuration and cannot use inline GQL. Metrics require ungrouped scalar aggregates (up to 12); charts require grouped aggregates (up to 100 groups). At most four Records blocks, 24 insight blocks and 24 Scanner blocks are allowed per App.

`referenced_records`, `record`, `html` and `comments` require a bound page Record. Incoming relations must target its table. Across Record/HTML blocks a page may expose at most 30 distinct fields. Editable fields are an explicit writable subset of displayed fields. `documents.templateIds` allows reading existing generated Documents, not issuing new ones. An `html` block displays an existing HTML field in an isolated frame.

`valueFormat` requires `style:number|integer|percent`; optional keys are `decimalPlaces` (0–20), `unit` (1–20 characters) and `unitPosition:prefix|suffix`. Integer style rejects decimal places; only number style accepts a custom unit; unit position requires a unit. Omitted formatting options use the normal renderer formatting.

## Actions and bindings {icon="arrows-right-left"}

Actions in an `actions` block require `id`, `label` (1–120) and `kind`. Both kinds accept `icon` and `availableWhen`.

- `kind:navigate` also requires `pageId` and `params`; `history` defaults to `push` and also accepts `replace`.
- `kind:workflow` also requires `launcherId`; `inputs` defaults to `{}` and `confirm` optionally supplies confirmation text (1–240 characters). Bind every required workflow input. A prompt launcher does not open a prompt form inside an App.
- Row actions use only `kind:workflow`, with the same keys plus `showLabel:true`. Setting it to `false` requires an icon; the label remains required for accessibility.
- `rowNavigate` has `kind:navigate`, `pageId`, `params` and optional `history:push|replace`. It has no label or action ID.
- `onSuccessNavigate` has `kind:navigate`, `pageId` and `params`. Successful submission uses replacement navigation; there is no `history` option here.

Bindings are objects, not expressions. The accepted sources depend on their position:

| Position | Accepted binding shapes |
| --- | --- |
| Navigation action `params` | `{source:PARAMS,path:name}`, `{source:RECORD,path:id}` |
| Row navigation `params` | `{source:ROW,path:id}`, `{source:ROW,path:relation,fieldId}`; the latter must be a selected single relation |
| Workflow `inputs` | `{source:LITERAL,value:JSON}`, `PARAMS`, `RECORD`; row actions additionally accept `{source:ROW,path:id}` |
| Form `fixedValues` | `LITERAL`, `PARAMS`, `RECORD`, `{source:AUTH,path:currentUser}` |
| Form success `params` | `PARAMS`, `{source:RESULT,path:recordId}` |
| Sidebar fixed values | `LITERAL`, `AUTH.currentUser` only |
| Sidebar success `params` | `RESULT.recordId` only |

Fixed-value keys are Form Field public IDs; workflow input keys are the launcher's input names. Bindings must match their target types. `AUTH.currentUser` requires a signed-in user and a compatible Principal field. Fixed fields are removed from the submitted inputs and evaluated again on the server.

`sidebar.actions` contains up to 12 global Form actions. Each requires `id`, `label`, `kind:form`, `formId`; optional keys are `icon`, `tone:default|success|danger` (default `default`), `availableWhen`, `fixedValues:{}`, and `onSuccessNavigate`. Sidebar Forms always create records. They have no current page/Record context.

## Availability and permissions {icon="shield-lock"}

`availableWhen:{query}` applies to pages, blocks and actions. A result row means available; empty results or errors mean unavailable. The server rechecks reads and writes. Typed context: `@auth`, declared `@params`, `@page`, `@app`, `@base`, `@time`. Global sidebar queries cannot use page/parameter context. See [GQL](/app/grids/help/grids-gql) for syntax.

Authoring requires Base Admin; App readers receive only published scopes, not raw Base access. Workflow actions and scanners require sign-in. All writes retain runtime access, Finalization and mutation-policy checks. Hidden navigation is not authorization.

## Submit and edit Forms through the API {icon="forms"}

Use `cld grids apps runtime read APP --page PAGE --params '{"item_id":"REC001"}' --json` first. Each form block's `form` result contains `form`, `fields`, `inlineTargetFields`, `submitUrl` and, for edit mode, `initialRecord`. Keep the same page parameters when calling `apps runtime submit APP PAGE BLOCK --body-file submission.json --yes`.

Create accepts a field-value object or `{data,inlineCreates?,idempotencyKey?}`. Edit requires `{data,version,idempotencyKey,inlineCreates?,inlineUpdates?}`. IDs in `data` are Field public IDs; relation values are Record public IDs or temporary IDs declared by `inlineCreates`.

An `object_list` is one field value, not a relation: `{"data":{"ITEMS1":[{"Label1":"Consulting","Amount":"19.95"}]}}`. Discover column IDs and rules in `fields[].config`. Send exact decimals as strings and omit calculated cells. Sending the list replaces all its rows; `[]` clears it if allowed. No `inlineCreates` are needed. See [list rules and formulas](/app/grids/help/grids-tables-fields).

```json
{
  "version": 3,
  "idempotencyKey": "edit-invoice-unique-attempt",
  "data": {"TITLE1": "Consulting", "LINES1": ["LINE01", "tmp_new"]},
  "inlineUpdates": {"LINES1": [{"recordId": "LINE01", "version": 2, "data": {"TEXT01": "Consulting day"}}]},
  "inlineCreates": {"LINES1": [{"tempId": "tmp_new", "data": {"TEXT01": "Travel"}}]}
}
```

Use discovered IDs and full Form values, retaining required inputs and explicit empty values for clearing. Related inputs allow only `inlineCreate.fields`, at most 20 creates/updates per relation and 50 total. Edited children must remain linked exclusively to this parent in the same Base. Detaching does not delete children. Finalized records are read-only. All writes commit or roll back together.

`initialRecord` contains root `version`, editable `values` and drafts in `inlineCreates` with `{tempId,data,existing:{id,version}}`. Replace existing temporary references with `existing.id`; send existing edits as `inlineUpdates`, only new drafts as `inlineCreates`. It is not a write payload.

The server chooses the edit target from the bound page Record, never a body `recordId`. For Base writers the equivalent is `cld grids forms submit BASE TABLE FORM --record REC001 --body-file submission.json --yes`, using current versions from `records get`. The HTTP endpoint is `POST /api/grids/forms/FORM/records/REC001`; create uses `POST /api/grids/forms/FORM/submit`.

Keys: nonblank, at most 200 characters, no NUL; scoped to Form/table and actor. Exact retries return the original Record ID without another write. Changed payloads, deleted results or stale versions conflict (`409`). After timeouts, retry the same body/key or inspect the result; unkeyed creates can duplicate. After confirmed stale versions, reload and review before a new attempt. Validation (`400`/`422`) and access failures (`401`/`403`/`404`) are not successful saves. Create returns `201`, edit `200`, with `recordId` and optional App success navigation.
