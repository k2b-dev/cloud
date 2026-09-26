# Grids tables, fields, views, and forms

Use this reference to configure schema and record presentation through the
Cloud CLI. For record operations, GQL, Combined tables, permissions, and
finalized captures, return to [Grids](grids.md).

## Contents

- [Discover exact input](#discover-exact-input)
- [Table options](#table-options)
- [History, finalization, and allowed changes](#history-finalization-and-allowed-changes)
- [Audit questions](#audit-questions)
- [Common field options](#common-field-options)
- [Field type catalog](#field-type-catalog)
- [Generated IDs and invoice numbers](#generated-ids-and-invoice-numbers)
- [Typed object lists](#typed-object-lists)
- [Display formats](#display-formats)
- [Views](#views)
- [JSON filters](#json-filters)
- [Forms](#forms)

## Discover exact input

```bash
cld grids fields types --json
cld grids fields type id --json
cld grids fields type object_list --json
cld grids fields list --base Operations --table Invoices --json
cld grids records shape --base Operations --table Invoices --json
cld api-docs show grids POST '/api/grids/tables/by-base/{baseId}' --json
```

`fields type` includes `configSchema`, the machine-readable configuration
schema, as well as value examples and write-policy notes. For an object-list
column's configuration, request the scalar type too, for example
`fields type number --json`. The live schema describes input validation;
the effective runtime defaults below also describe what omitted options do.

Use `--body-file config.json` for nested create/update bodies. Dedicated flags
are convenient shortcuts, not the full configuration surface. Read the exact
command's `--help` before using flags. All Grids resource references in these
bodies use the returned six-character public IDs, including nested field,
table, relation-record, and display references. Cloud user/group IDs and audit
question/option IDs are UUIDs instead. Names resolve in CLI resource arguments,
not in arbitrary JSON properties. Replace example IDs with discovered IDs.

An omitted update property keeps its existing value. A supplied configuration
object is a replacement, not a recursive patch: read it first, modify it, and
send the complete desired object. Use `null` only where documented; it is not
a universal reset value.

## Table options

`tables add` accepts the following body. `tables set` accepts the same
properties except `kind` and adds `auditPolicy` and `disableDirectInsert`.

| Property | Input and behavior |
| --- | --- |
| `name` | Required on create; 1–200 characters. |
| `kind` | Create only: `stored` (default) or `federated` (Combined table). Cannot change an existing table's kind. |
| `description` | Optional string, up to 1,000 characters; `null` clears it. |
| `icon` | Optional icon name, up to 200 characters; `null` clears it. |
| `columns` | Ordered array of `{fieldId, label?, format?}`. `label` is trimmed, 1–120 characters; `format` uses [Display formats](#display-formats). Empty by default. These are presentation columns, not new field definitions. |
| `displayConfig` | [Display configuration](#display-formats); default `{ "mode": "table" }`. |
| `auditPolicy` | Update only; server-enforced questions for update/delete/restore. Default `{}`. See below. |
| `disableDirectInsert` | Update only; default `false`. Removes direct insertion from the table experience. For server-enforced restrictions across clients, configure mutation policy rather than treating this UI option as authorization. |

Create the table, create its fields, then configure columns, card covers, or
calendar dates with those returned field IDs. A new table cannot reference
fields before they exist. Ordinary table columns contain stored field
references only; use a View for presentation-only computed columns.

Example table update, after creating the referenced fields:

```json
{
  "columns": [
    { "fieldId": "Number", "label": "Invoice" },
    { "fieldId": "Amount", "format": { "kind": "decimal", "precision": 2 } }
  ],
  "displayConfig": { "mode": "cards", "cards": { "fieldIds": ["Number", "Amount"] } }
}
```

Combined tables expose published mappings, not writable copied rows. Do not
apply stored-table required/default/index/unique constraints to them. Their
canonical fields cannot use `lookup`, `rollup`, or `html_template`; Formula
fields must compile to SQL. See [Publish Combined tables](grids.md#publish-combined-tables)
for draft tokens, candidates, mappings, publication, and revocation.

## History, finalization, and allowed changes

These are dedicated operations, not properties to add to `tables set`:

```bash
cld grids tables history Operations:Invoices --json
cld grids tables history enable Operations:Invoices --yes
cld grids tables finalization Operations:Invoices --json
cld grids tables finalization enable Operations:Invoices --mode direct --yes
cld grids tables mutation-policy Operations:Invoices --json
cld grids tables mutation-policy impact Operations:Invoices --allow form,workflow --json
cld grids tables mutation-policy set Operations:Invoices --allow form,workflow
```

- **Durable History:** opt-in for stored tables; enabling is irreversible.
  Activation creates an honest baseline, not invented earlier revisions.
  Wait until history is `active` before finalization.
- **Finalization:** CLI `--mode direct` or `--mode four-eyes`; four-eyes also
  requires `--approver-group <Cloud-group-UUID>`. The API policy shape uses
  `{ "mode": "direct" }` or
  `{ "mode": "fourEyes", "approverGroupId": "<Cloud-group-UUID>" }`.
  `tables finalization policy` changes that policy with `--yes`.
  `tables finalization disable --yes` is only available before the first
  finalized record, subject to the server's readiness checks. Inspect
  `canDisable`, `finalizedCount`, `policyRevision`, and `durableHistory` in
  status rather than guessing.
- **Four-eyes:** approval must come from a different current approver-group
  member with Write access. Requests bind record state and policy revision;
  subsequent edits invalidate them. Finalization freezes typed calculated
  values, relations, and files for that record; it does not finalize relation
  targets. See [Record payloads and versions](grids.md#record-payloads-and-versions).
- **Mutation policy:** `--allow all` (default), `direct,form,workflow` or any
  subset, or `none`. API shapes are `{ "mode": "all" }` and
  `{ "mode": "selected", "sources": ["form", "workflow"] }` inside
  `{ "policy": ... }`. An empty source list freezes record changes; the CLI
  requires `--yes`, and the API requires `confirmFreeze: true` alongside the
  policy. Preview impact first. This policy covers record, relation, and file
  changes in every client, not only visible buttons.

Retention floors, preservation holds, destruction, and record trash are
separate controls. See [Bases and tables](grids.md#bases-and-tables).

## Audit questions

Set `auditPolicy.delete`, `.restore`, and/or `.update` in a table update.
Each requirement has `enabled` (default `false`) and `questions` (default
`[]`, maximum 20). Enabled requirements need at least one question.
Update requirements additionally accept `scope: "all" | "selected"`
(default `all`) and `fieldIds` (default `[]`, maximum 200 distinct public
field IDs). Enabled `selected` scope needs at least one field.

Every question has:

- `id`: a stable UUID that you create for this question, not a field ID;
- `label`: trimmed, 1–200 characters;
- `description`: optional, trimmed, up to 1,000 characters;
- `required`: boolean, default `false`;
- `type`: `text`, `longtext`, or `select`;
- for `select`, `options`: 1–100 `{id: <UUID>, label: <1–200 character string>}`.

Question IDs and labels must be unique in the requirement; select option IDs
and labels must be unique within the question. Label comparison ignores case
and surrounding whitespace. These answers become immutable operation metadata,
not record values.

```json
{
  "auditPolicy": {
    "update": {
      "enabled": true,
      "scope": "selected",
      "fieldIds": ["Amount"],
      "questions": [{
        "id": "8bc33718-8b91-4910-86fb-bf460a68d1cc",
        "type": "longtext",
        "label": "Reason for changing the amount",
        "required": true
      }]
    }
  }
}
```

Submit mutation audit answers as
`{"audit":{"answers":{"<question-UUID>":"Corrected receipt amount"}}}`
alongside the operation's ordinary body; select answers contain the option
UUID. Each answer is a string up to 10,000 characters. For the record-update
HTTP API, the body is `{values, audit?}` and the optimistic version is an
`If-Match` header. With `records set`, pass ordinary field values through
`--body`, answers through `--audit`, and the current version through
`--if-version`; the CLI constructs that envelope. Do not put `audit` among
the record's field values.

## Common field options

`fields create` requires `name` and `type`; `fields update` accepts partial
common options but **does not change `type`**. `config` is owned by the type.

| Property | Input/default |
| --- | --- |
| `name` | 1–200 characters; live names are unique within the table ignoring surrounding whitespace and case. |
| `description` | Optional, up to 2,000 characters; `null` clears it. |
| `icon` | Optional, up to 200 characters; `null` clears it. |
| `config` | Object; omitted create config starts as `{}` and is validated/normalized by its type. Not every type accepts an empty config. |
| `position` | Optional integer; use `fields reorder` for an explicit overall order. |
| `required` | Default `false`; checked during record validation, not a display-only hint. |
| `presentable` | Default `false`; contributes to the record label used in lookups, links, and pickers. It is not the record's public ID. |
| `hideInTable` | Default `false`; presentation only, not a secrecy or access boundary. |
| `defaultValue` | Type-specific input, validated like that type; default `null`. New record default, not an expression or backfill. Date fields also accept `{"kind":"now"}`; use the same value on a Form's `user_input` entry for a visible current-date suggestion when opening a creation form. Existing record dates are not replaced. |
| `indexed` | Default `false`; performance setting, not uniqueness. Supports `number`, `percent`, `duration`, `date`, `boolean`, `text`, `longtext`, `id`, and single `select`; unsupported shapes do not gain a nested index. |
| `uniqueConstraint` | Default `false`; supported for `text`, `longtext`, `number`, `percent`, `date`, `boolean`, `id`. Generated `id` always enforces uniqueness on stored tables. Existing conflicting values block activation. |

Read `fields dependents` before deletion: formulas, forms, views, workflows,
and other consumers can block removal. Changing config can also be rejected
when it would invalidate existing data or finalized captures. Do not bypass
these checks by recreating fields with the same name: references use identity.

`required` does not make a Boolean a consent checkbox: `false` is a value.
Optional empty values normally normalize to `null`; use `records shape` and
the catalog below for the type's exact representation. Computed/system/file
fields are not ordinary record write values. `html_template` also rejects
required, default, index, uniqueness, and presentable settings.

## Field type catalog

All 22 current types are listed here. Config properties are optional unless
marked required. Bounds are inclusive. `null` below describes record values,
not permission to put `null` into non-nullable configuration properties.

| Type | Configuration | Record value and behavior |
| --- | --- | --- |
| `text` | `minLength` integer ≥0; `maxLength` integer ≥1; `regex` string; `multiline` boolean (default `false`). | String; single-line input is trimmed. Empty string becomes `null` unless required. Regex must match. Email, URL, phone, slug, barcode, and ISBN are text with optional validation, not separate types. |
| `longtext` | Same as text, plus `markdown` boolean. | Multiline string, preserving whitespace regardless of `multiline`. Empty input becomes `null` unless required. |
| `number` | `min`, `max`: decimal string or number; `precision` integer 1–38; `decimalPlaces` integer 0–20; `integerOnly` boolean; `unit` string 1–20; `unitPosition: "prefix" | "suffix"`. | Input number or exact decimal string; output canonical decimal string. `decimalPlaces` validates, does not round; configured scale is preserved. `integerOnly` requires integers and uses zero places. Precision/scale and min/max must be consistent. Currency is a `number` with a display-only unit, not another type. |
| `boolean` | `{}`. | Boolean; also accepts `"true"`, `"false"`, `1`, `0`, `"1"`, `"0"`. `null` allowed when optional. |
| `date` | `includeTime` boolean (default `false`); `min`, `max` date strings. | Date-only `YYYY-MM-DD`; with `includeTime: true`, send timezone-aware ISO date-time, normalized to UTC. Date-only timestamp input retains its leading calendar date, not a shifted UTC day. Bounds must be valid and ordered. |
| `select` | **Required** `options: [{id, label, color?, description?}]`; `id` nonempty string, other properties strings. `multiple` boolean default `false`; `minSelected` integer ≥0; `maxSelected` integer ≥1. | Always an array of option IDs, including single select, e.g. `["open"]`; duplicates removed. Unknown options rejected. Single mode permits at most one selection; min/max must agree and minimum cannot exceed option count. `[]` clears optional values to `null`. |
| `principal` | `cardinality: "single" | "multiple"`, default `multiple`. | Array of `{type: "user" | "group", id: <Cloud UUID>}` even for single mode. Maximum 100 inputs; deduplicated. An individual reference is also accepted as input. Identities must be discoverable by the writing actor. This is not a Contacts field. |
| `percent` | `range: "percent" | "fraction"`, default `percent`; `decimals` integer 0–8, default 2. | Number in 0–100 or 0–1 respectively. Decimal string input accepted. Rounds half away from zero to configured places; output remains a JSON number. Do not assume all percentages use the same scale. |
| `duration` | `unit: "seconds" | "minutes" | "hours"` for display. | Nonnegative seconds, or `MM:SS` / `HH:MM:SS` input. Plain numeric seconds are rounded to whole seconds. Unit does not reinterpret stored seconds. |
| `resource` | `{}`. | One `{type, id, title?}` Cloud resource reference. Type is namespaced; ID is the owning app's public opaque ID. Discover both; do not invent IDs or URLs. Optional title is a retained display label. Opening resolves the canonical reader with current access. No byte copy, permission grant, external joins, scalar sort/group/index, or recursive finalization. |
| `json` | `{}`. | JSON object, array, or scalar; string input is parsed as serialized JSON. Nested paths are opaque to ordinary filtering/sorting. For validated line items use `object_list`, not arbitrary JSON. |
| `object_list` | **Required** `fields`; `minItems` default 0; `maxItems` default 100. See [Typed object lists](#typed-object-lists). | Array of typed rows keyed by column IDs, replaced atomically. Calculated cells are read-only. |
| `relation` | `targetTableId` public table ID; `cardinality: "single" | "multiple"`, default `multiple`. | Array of public record IDs; a single ID string also accepted. Target may initially be omitted, but then nonempty writes fail. Empty array clears an optional relation. Both modes read as arrays. |
| `lookup` | `relationFieldId`, `targetFieldId` public field IDs; `format` optional display format. | Read-only projection through a relation in this table to a field in its target table. Incomplete configuration can be created, but yields no configured projection. Target access checks still apply. |
| `rollup` | Same references/format as lookup, plus `agg: "count" | "sum" | "avg" | "min" | "max"`. | Read-only relation aggregate. Configure all references and aggregate before relying on the result. |
| `formula` | `expression` string; `format` optional display format. | Read-only typed result. Nonempty expressions are parsed on save. Use [Formula language](grids.md#formula-language-reference); exact numeric results may be decimal strings. |
| `html_template` | `template` and `css` strings, each default `""`. | Read-only Liquid HTML. Roots: `record`, `table`, `app`, `business`, `date`. Template ≤50,000 UTF-8 bytes; CSS ≤32,000 bytes, 200 rules, 1,000 declarations; rendered result ≤300,000 bytes. No arbitrary document/workflow roots. |
| `id` | Seven strategies; see [Generated IDs](#generated-ids-and-invoice-numbers). | Stable server-generated string. Never submit its value in create/update/import payloads. Not the record's separate six-character resource ID. |
| `created_at` | `{}`. | Read-only record creation timestamp. |
| `updated_at` | `{}`. | Read-only last update timestamp. |
| `created_by` | `{}`. | Read-only creating user reference; system-origin records can lack a user. |
| `updated_by` | `{}`. | Read-only last modifying user reference; system-origin changes can lack a user. |
| `file` | `maxFiles` integer 1–100; `accept` up to 100 nonempty strings. | Dedicated `records files` upload/replace/download/delete operations, not JSON record writes. Accept entries support MIME types, MIME wildcards, and filename extensions. Omitted/empty `accept` allows all types; omitted `maxFiles` imposes no field-specific count limit. Service upload limits still apply. |

For money use decimal strings in inputs and decimal arithmetic in consumers.
Number values and bounds must fit the supported numeric range (131,072 integer
digits and 16,383 decimal places), even when exponent notation is used. Field
precision/scale can narrow that range further. Units and display formats do not
change the stored value. See [numeric formula behavior](grids.md#formula-language-reference).

## Generated IDs and invoice numbers

`id` is a configurable generated business identifier. It is not limited to
reflecting a system record ID. All strategies accept `prefix` (up to 32
characters, default empty), and concatenate it as supplied—include your own
separator when wanted.

| `strategy` | Other options and effective defaults | Shape |
| --- | --- | --- |
| `sequence` | `padding` integer 1–16, default 1; `assignment` default `creation`. Omitted `strategy` selects this strategy. | `INV-1`, or `INV-00001` with padding 5. |
| `date_sequence` | `padding` integer 1–16, default 4; `period: "year" | "month" | "day"`, default `year`; `assignment` default `creation`. | Prefix + date scope + `-` + counter, e.g. `INV-2026-0001`, `INV-202609-0001`, or `INV-20260913-0001`. |
| `short_code` | `length` integer 4–12, default 5. | One readable random code, optionally prefixed. |
| `random_code` | `groups` integer 2–4, default 2; `segmentLength` integer 3–6, default 4. | Grouped readable random code, optionally prefixed. |
| `uuid` | No additional options. | UUID string, optionally prefixed. |
| `uuidv7` | No additional options. | Time-ordered UUIDv7 string, optionally prefixed. |
| `ulid` | No additional options. | ULID string, optionally prefixed. |

Only `sequence` and `date_sequence` support
`assignment: "creation" | "finalization"`. At `creation`, insertion assigns
the number. At `finalization`, drafts remain unnumbered and successful
finalization assigns it. **Enable table Finalization first**, or creating or
updating that configuration is rejected. Random/UUID/ULID strategies assign
on creation, not finalization.

```bash
cld grids tables history enable Operations:Invoices --yes
cld grids tables finalization enable Operations:Invoices --mode direct --yes
cld grids fields create Operations Invoices --body '{"name":"Invoice number","type":"id","presentable":true,"config":{"strategy":"date_sequence","prefix":"INV-","padding":5,"period":"year","assignment":"finalization"}}'
```

Sequential fields use durable atomic number series. Allocations are never
reused; technical gaps remain possible. Finalization assignment avoids
allocating numbers merely for discarded unfinalized drafts, but is not a
promise of legally compliant or gapless numbering. Each date scope has its own
counter and uses the configured date context. Existing generated values do not
change when future formatting is edited. Inspect returned `numberSeries`
metadata for state and allocation information; don't calculate the next number
client-side. A generated value is not an editable input/default or a separate
record identifier to use in API routes.

## Typed object lists

Use an `object_list` when items have only their parent's lifecycle, such as
invoice positions. Use related records instead when rows need independent
permissions, identities, links, or workflows.

`config.fields` is required: 1–200 columns. Each column has:

| Property | Input/default |
| --- | --- |
| `id` | Required stable six-character alphanumeric ID, chosen when defining the column. |
| `name` | Required trimmed string, 1–200 characters. |
| `description` | Optional string, up to 2,000 characters. |
| `type` | Required: `text`, `longtext`, `number`, `boolean`, `date`, `select`, `percent`, `duration`. |
| `config` | Scalar type configuration from the catalog; default `{}`. Select columns still need `options`. |
| `required` | Default `false`. |
| `defaultValue` | Optional literal suggestion for newly added entries in the UI, validated and normalized by the scalar type. Selects use option-ID arrays, including single-select (for example `["C62"]`); numbers use decimal strings. Omitted or `null` means no suggestion. Calculated columns cannot have defaults; dynamic defaults such as `{ "kind": "now" }` are not supported for list columns. Existing entries and API write payloads are never filled implicitly. |
| `formula` | Optional `{expression?, format?}`; expression references sibling columns by name or ID. A calculated column keeps its declared scalar type and validation. |
| `width` | Optional `"fullWidth"` (default) or `"compact"`. Applies equally to inputs and calculated columns. Consecutive compact columns share space and wrap; full-width columns start a full row. No automatic type/name heuristics. |
| `detailsOnly` | Optional boolean, default `false`; for optional input columns and calculated helper columns. These appear in the item details instead of the compact summary; keep required inputs visible. |

Columns must have unique IDs and normalized names, without ambiguous name/ID
references. No nested lists, JSON objects, files, principals, or relations.
Calculated select columns and regex-constrained calculated text are unsupported.
Calculation dependencies must be valid and compile to SQL.

`minItems` is integer 0–1,000, default 0; `maxItems` is integer 1–1,000,
default 100; minimum cannot exceed maximum. One value may occupy at most
256 KiB. Required parent fields need a nonempty list. Saving replaces the
entire list, not one row; use the current record version. Omit calculated
cells from writes. Parent finalization freezes inputs, calculated cells, and
parent formula totals together with their types.

Example field body:

```json
{
  "name": "Items",
  "type": "object_list",
  "required": true,
  "config": {
    "maxItems": 100,
    "fields": [
      { "id": "Label1", "name": "Label", "type": "text", "required": true },
      { "id": "Qty001", "name": "Quantity", "type": "number", "config": { "min": "0" }, "required": true, "defaultValue": "1" },
      { "id": "Price1", "name": "Unit price", "type": "number", "config": { "decimalPlaces": 2 }, "required": true },
      { "id": "Total1", "name": "Total", "type": "number", "config": { "decimalPlaces": 2 }, "formula": { "expression": "ROUND(Quantity * \"Unit price\", 2)" } }
    ]
  }
}
```

Value example: `[{"Label1":"Consulting","Qty001":"2","Price1":"42.50"}]`.
Use `LIST_SUM(Items, 'Total')` in a parent Formula field. `LIST_AVG`,
`LIST_MIN`, `LIST_MAX`, and `LIST_COUNT` are also available. See
[Typed rows inside a record](grids.md#typed-rows-inside-a-record) for changes
to populated schemas and GQL usage.

## Display formats

Table `displayConfig` and View `ui.displayConfig` use:

```json
{
  "mode": "table",
  "cards": { "imageFieldId": null, "fieldIds": [] },
  "calendar": { "dateFieldId": null }
}
```

Only `mode` is needed: `table` (default), `cards`, or `calendar`. `cards` and
`calendar` objects are optional. `imageFieldId` and `dateFieldId` are public
field IDs or `null`; card `fieldIds` is an optional ordered list of at most
50 fields. Choose an image File field for a card cover and a Date field for a
calendar. Display settings never change query filters, grouping, or access.

The current calendar configuration has no end-date or color-field option; do not
invent those properties. Custom App Records blocks offer table/Cards display,
not this calendar mode. Check the installed schemas when targeting another
version.

Field-column, computed-column, Formula, Lookup, and Rollup `format` values:

| `kind` | Properties |
| --- | --- |
| `date` | Required `format: "iso" | "short" | "long" | "relative"`; optional `includeTime` boolean. |
| `decimal` | Optional `precision` integer 0–10; optional `thousandsSeparator` boolean. This precision is display decimal places, not `number.config.precision`. |
| `percent` | Optional `precision` integer 0–10. |
| `progress` | Optional `label: "value" | "percent" | "none"`. |
| `barcode` | Required `bcid` string of 1–80 lowercase alphanumeric characters; optional `showText` boolean. Use an installed supported barcode format, e.g. `code128` or `qrcode`. |

Omitting `format` uses the field/default renderer. A format incompatible with
the value type does not convert the stored value. Barcode rendering is a
presentation of text, not a barcode field type or validation rule.

## Views

Use a View for a reusable GQL query, including joins; it is not limited to
one source table's columns. `source` owns filtering, projection, sorting,
grouping, and aggregation. `ui` owns presentation, not a second query.

| Create/update property | Input/default |
| --- | --- |
| `name` | Required on create; 1–200 characters. |
| `description` | Optional, up to 2,000 characters; `null` clears it. |
| `icon` | Optional, up to 200 characters; `null` clears it. |
| `source` | Optional nonempty trimmed GQL, up to 20,000 characters. Create defaults to all records from its table. |
| `shared` | Optional boolean; create defaults to a personal View owned by the signed-in user. `true` creates a shared View. Shared View authoring needs the corresponding Base permission. |
| `ui` | Optional object, default `{}`. Properties listed below. |
| `position` | Update only, optional integer. |

`ui` options:

- `displayConfig`: table/cards/calendar settings above;
- `columns`: ordered ordinary `{fieldId, label?, format?}` columns and/or
  computed columns `{kind: "computed", id, label, expression, format?}`.
  Computed IDs match `computed_[A-Za-z0-9]{5,32}`, labels are 1–120 trimmed
  characters, and expressions are 1–5,000 trimmed characters. These columns
  do not add fields to the table;
- `groupedColumnOrder`: ordered output keys;
- `hiddenGroupedColumns`: output keys to hide.

Read the existing View or query result to obtain grouped-column keys; do not
replace keys with translated labels. Field references inside those keys must
still be public IDs. Keep grouped ordering distinct from record sorting.

For exact query syntax, aliases, grouped result columns, and view compilation,
see [GQL](grids.md#query-data-with-gql). For a published Custom App that consumes
a View, remember publication pins its contract; editing the source View is not
an automatic republish of the App.

## JSON filters

`records query` filters and Form `relationFilter` use the same tree. A leaf is
`{fieldId, op, value?, caseInsensitive?}`. A group is
`{op: "AND" | "OR", filters: [leafOrGroup, ...]}`. Use public Field IDs;
Form selection filters refer to fields of the relation's **target** table.
Limits are 20 levels, 200 total nodes, and 100 children per group.

Read `cld grids fields type <type> --json`: `filterOperators` lists the installed
operators. An empty list means that type has no direct JSON filter operators;
use GQL for computed expressions. Some OpenAPI renderings show recursive filters
as `{}`; this does not mean arbitrary JSON is accepted. Use this tree contract
and the type-specific operators, then validate against the target table.

| Field type | Operators | `value` |
| --- | --- | --- |
| `text`, `longtext`, `id` | `equals`, `notEquals`, `contains`, `notContains`, `startsWith`, `endsWith`, `regex`, `isEmpty`, `isNotEmpty` | String; regex patterns at most 200 characters. Optional `caseInsensitive` changes text matching. |
| `number`, `percent`, `duration` | `=`, `!=`, `<`, `<=`, `>`, `>=`, `between`, `isEmpty`, `isNotEmpty` | Finite JSON number; `between` uses `[lower, upper]` in ascending order. Use GQL typed decimal parameters when an exact decimal cannot be represented as a JSON number. |
| `date` | `=`, `notEquals`, `before`, `after`, `onOrBefore`, `onOrAfter`, `between`, `today`, `thisWeek`, `thisMonth`, `lastNDays`, `isEmpty`, `isNotEmpty` | `YYYY-MM-DD`, or timezone-aware ISO timestamp for includeTime fields; `between` uses `[from, to]`. `lastNDays` takes a non-negative integer. |
| `boolean` | `=`, `isEmpty`, `isNotEmpty` | JSON boolean. |
| `select` | `is`, `isNot`, `isAnyOf`, `isNoneOf`, `isEmpty`, `isNotEmpty` | Option ID string; `isAnyOf` and `isNoneOf` take arrays of option IDs. |
| `relation`, `principal` | `containsAny`, `notContainsAny`, `isEmpty`, `isNotEmpty` | Nonempty array of target Record public IDs for relations, Cloud identity UUIDs for principals. |

Omit `value` for `isEmpty`, `isNotEmpty`, `today`, `thisWeek`, and `thisMonth`.
These operator names differ from Form cross-field validation: use `=` for a
boolean JSON filter, `equals` for text, and `eq` for a Form comparison rule.
For example, a boolean eligibility filter is
`{"fieldId":"Active","op":"=","value":true}`.

## Forms

Forms guide writes to existing fields; they do not define new field types or
grant access to a table. `forms default` reads the virtual default form;
`forms create` creates a named stored form.

| Create/update property | Input/default |
| --- | --- |
| `name` | Required on create; 1–200 characters. |
| `config` | Optional object, default `{ "fields": [] }`. When supplied, `fields` is required. See complete shape below. |
| `isPublic` | Optional boolean; default private. Enabling ensures a public submit token, disabling removes it. Do not log or commit the token. |
| `isActive` | Update only; boolean. Inactive forms cannot accept ordinary submissions. |
| `position` | Update only; integer. |

The complete `config` shape:

| Property | Input |
| --- | --- |
| `title`, `description` | Optional strings. |
| `fields` | Required ordered array of `user_input` or `form_value` entries below; each field may occur once. |
| `computedFields` | Optional ordered array, up to 20 `{fieldId, label?, helpText?, width?}` entries. Read-only formulas using visible form inputs; never submit these as data. Labels up to 200 characters, hints up to 2,000. |
| `validations` | Optional array, at most 20 cross-field rules below. |
| `submitLabel`, `successMessage` | Optional strings shown to the user. |
| `redirectUrl` | Optional string or `null`; use an allowed destination, not a script URL. |
| `titleImage` | Optional image data URL, at most 1,000,000 characters. |

`user_input` entries accept `kind: "user_input"`, `fieldId` (required public
ID), and optional `label`, `helpText`, `width`, `required`, `defaultValue`,
`inlineCreate`, `section`, and `relationFilter`. `required` and `defaultValue` are form overrides; underlying
field validation remains authoritative. Do not use a default as a protected
value that users must not change.

`width` accepts `"fullWidth"` (default) or `"compact"` on `user_input`,
`computedFields`, and inline-create field entries. Consecutive compact fields
share available space and wrap; full-width fields start a full row. Order is
preserved. This is presentation only, not a validation or calculation rule.
For example: `{"kind":"user_input","fieldId":"Start1","width":"compact"}`.

`form_value` entries use `{kind: "form_value", fieldId, value}` with all three
properties required. The server supplies this fixed value rather than trusting
a submitted replacement. Values still use the field's normal representation
(single-select arrays, decimal strings, principal references, and so on).
Only record-writable fields may be configured. Generated IDs, computed/system
fields, and file bytes are not ordinary form JSON entries.

`section` starts a group at that input. Following inputs belong to it until the
next section. Collapsible groups start closed when empty and open when they have
initial values. Invalid inputs open their group before receiving focus. Grouping
does not change validation or submission. Its shape is
`{title, description?, collapsible?}`: title is trimmed,
1–200 characters, and description is at most 2,000 characters. For example:
`{"section":{"title":"Contact","description":"Who should we contact?"},"kind":"user_input","fieldId":"Name01"}`.

`relationFilter` restricts selectable and submitted existing records of a relation.
Use the [JSON filter tree](#json-filters), with target-table Field IDs,
for example `{"fieldId":"State1","op":"equals","value":"available"}` for a text
field. The target must be a stored table in the same Base. Filtered inputs cannot
use inline creation. The server checks the submitted selection again; this is not
just a picker display filter. It does not grant access to target records.

For a relation `user_input`, `inlineCreate` can be
`{enabled: true, fields: [{fieldId, label?, helpText?, width?, required?, defaultValue?}]}`.
Its fields are public IDs on the relation's target table. Enabled inline
creation needs at least one field and a configured target. No duplicate target
fields, computed/system/file fields, or further relations are allowed. It is
one level, not recursive nested forms. Normal target permissions and mutation
policy still apply. Disabled inline configuration is discarded on save.

Each validation is
`{leftFieldId, operator, rightFieldId, message, errorFieldId?}`.
Comparison operators: `eq`, `neq`, `lt`, `lte`, `gt`, `gte`. The two distinct fields must
both be visible `user_input` fields of compatible comparable kinds: number
with number, percent with percent, duration with duration, date-only with
date-only, or date-time with date-time. `message` is trimmed, 1–240 characters.
Optional `errorFieldId` must be one of the two fields. Empty values remain the
responsibility of required/type validation, not cross-field comparison.

`anyPresent` is a separate presence rule for two distinct visible **relation**
inputs: at least one must contain a selection. Both may contain selections.
It does not support arbitrary text or number inputs. Use it for “choose items,
sets, or both”; leave the individual inputs optional. It uses the same rule shape,
including `message` and optional `errorFieldId`.

Example form body with server-enforced date ordering:

```json
{
  "name": "Request equipment",
  "isPublic": false,
  "config": {
    "title": "New request",
    "fields": [
      { "kind": "user_input", "fieldId": "Start1", "required": true },
      { "kind": "user_input", "fieldId": "End001", "required": true },
      { "kind": "form_value", "fieldId": "Status", "value": ["draft"] }
    ],
    "validations": [{
      "leftFieldId": "Start1",
      "operator": "lte",
      "rightFieldId": "End001",
      "message": "End date must not precede start date.",
      "errorFieldId": "End001"
    }],
    "submitLabel": "Create request",
    "successMessage": "Your request was created."
  }
}
```

Create the two Date fields and a Select field containing option `draft` first.
Use their real returned IDs in the body. For edit forms, all-or-nothing related
row edits, idempotency, submitted `data` versus `inlineCreates`, and public
form limitations, see [Form submission contract](grids.md#form-submission-contract).
Custom App form blocks add page, availability, and authenticated fixed-value
rules on top; discover their complete schema with `apps reference --json`.
