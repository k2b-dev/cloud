---
id: grids-field-configuration
title: Field configuration reference
icon: ti ti-adjustments
description: Look up field types, options, generated IDs, defaults, and object-list columns when you configure a Base.
order: 111
---
Use this reference when you configure a field through the CLI or API. To choose a field, read [Tables & fields](/app/grids/help/grids-tables-fields). Run `cld grids fields types --json` for the live catalog and `cld grids fields type <type> --json` for one type. Do not infer the configuration from the display label of a field.

## Set the shared options {icon="settings"}

A field has these options:

- `name`: 1–200 characters;
- `description`: optional, up to 2,000 characters;
- `icon`: up to 200 characters;
- `position`: an integer;
- the flags `required`, `presentable`, and `hideInTable`, which are false by default.

Names are unique within the table. Grids ignores case and surrounding whitespace when it compares them. The presentable field supplies the record label. It does not change access.

`type` is fixed after creation. Updating `config` replaces the whole configuration. It does not merge missing nested options. Use public field and table IDs in APIs. A label in an example is not an ID.

`defaultValue` is a typed default for omitted values on new records. An explicit `0` or `false` is a value, not an omission. `null` means that no default is configured. Date fields also accept `{"kind":"now"}`. Defaults never rewrite existing records.

`indexed` is available for text, long text, ID, number, percent, duration, date, boolean, and single-select fields. `uniqueConstraint` is supported for text, long text, number, percent, date, boolean, and ID fields. Add indexes only for real query patterns, because they add work to every write.

## Configure entered values {icon="edit"}

| `type` | `config` options and defaults |
| --- | --- |
| `text` | `minLength` ≥ 0, `maxLength` ≥ 1, `regex`, `multiline` (false). Grids trims the text. |
| `longtext` | `minLength`, `maxLength`, `regex`, `markdown`. Keeps whitespace. |
| `number` | `min`, `max` as decimal strings or numbers; `precision` 1–38; `decimalPlaces` 0–20; `integerOnly`; `unit` 1–20 characters; `unitPosition`: `prefix` or `suffix`. Decimal values stay strings. Precision limits reject extra digits and never round silently. |
| `boolean` | `{}`. Stores true, false, or null when optional. |
| `date` | `includeTime` (false), `min`, `max`. Date-only values use `YYYY-MM-DD`. Date-time values include a timezone. |
| `select` | Required `options: [{id, label, color?, description?}]`; `multiple` (false); `minSelected` ≥ 0; `maxSelected` ≥ 1. Values are arrays of option IDs, also for a single-select field. |
| `principal` | `cardinality: "single" \| "multiple"` (multiple). Values are arrays of typed Cloud user or group UUID references, at most 100. The picker shows only identities that the person can see. |
| `percent` | `range: "percent" \| "fraction"` (percent), `decimals` 0–8 (2). Fraction 0.19 and percent 19 both display 19%. The stored scale matters in formulas. |
| `duration` | `unit: "seconds" \| "minutes" \| "hours"`. Values are nonnegative seconds. Grids rounds numeric input to whole seconds. Also accepts `HH:MM:SS` and `MM:SS`. The display unit does not change the storage unit. |
| `json` | `{}`. Any valid JSON value. Its properties have no declared Grids field schema. Grids reads a string input as JSON text. |
| `file` | `maxFiles` 1–100 when set; `accept` with up to 100 MIME types, wildcard MIME types, or extensions. Upload and detach use the file operations, not record JSON writes. |
| `object_list` | See the column contract below. |

For a principal value, use `[{"type":"user","id":"<user-uuid>"}]` or a `group` reference. An identity in a field is data. It does not give access. To fill in the current user securely, use the configured submission action of a published app, not an input that the user can edit.

## Configure relations and calculated values {icon="link"}

| `type` | `config` |
| --- | --- |
| `relation` | `targetTableId`, `cardinality: "single" \| "multiple"` (multiple). Values are arrays of public record IDs. |
| `lookup` | `relationFieldId`, `targetFieldId`, optional `format`. Reads linked values. Does not copy them into an editable input. |
| `rollup` | `relationFieldId`, `targetFieldId`, `agg: "count" \| "sum" \| "avg" \| "min" \| "max"`, optional `format`. |
| `formula` | `expression`, optional `format`. Use the [formula reference](/app/grids/help/grids-formulas), including exact decimal arithmetic and typed select comparisons. |
| `html_template` | `template` (up to 50 KiB), `css` (up to 32 KiB; 200 rules and 1,000 declarations). Liquid roots: `record`, `table`, `app`, `business`, `date`. Output up to 300 KiB, sandboxed and read-only. |

Record writes cannot supply calculated values. Lookups and rollups follow the access to the data. Finalizing a record freezes the supported calculated values with their types. A later formula change does not recalculate that frozen record.

HTML template fields are not documents. They require stored tables. You cannot use them in filters, sorts, groups, aggregates, formulas, or lookups. Other HTML template fields are unavailable inside them, which prevents recursion.

## Format calculated values {icon="numbers"}

The optional `format` controls the display, not the stored precision. Use one of these:

- `{kind:"decimal", precision?:0..10, thousandsSeparator?:boolean}`
- `{kind:"percent", precision?:0..10}`
- `{kind:"date", format:"iso"|"short"|"long"|"relative", includeTime?:boolean}`
- `{kind:"progress", label?:"value"|"percent"|"none"}`
- `{kind:"barcode", bcid:string, showText?:boolean}`

`bcid` names the barcode format with 1–80 lowercase letters or digits. Use only a format that fits the result type.

## Configure generated identifiers {icon="id"}

`id` is a field that the server generates. It is not an ordinary editable text column. Its configuration uses:

| `strategy` | Options |
| --- | --- |
| `sequence` (default) | `prefix` up to 32 characters; `padding` 1–16 (1); `assignment` below |
| `date_sequence` | `prefix`; `padding` 1–16 (4); `period: "year" \| "month" \| "day"` (year); `assignment` below |
| `short_code` | `prefix`; `length` 4–12 (5) |
| `random_code` | `prefix`; `groups` 2–4 (2); `segmentLength` 3–6 (4) |
| `uuid` | `prefix` |
| `uuidv7` | `prefix` |
| `ulid` | `prefix` |

Only the two sequence strategies accept `assignment: "creation" | "finalization"`. The default is creation. Enable table finalization before you configure numbering at finalization. Drafts then have no number. Grids allocates values atomically and never reuses them. This does not guarantee legally gapless accounting.

Example configuration for a yearly document number:

```json
{"strategy":"date_sequence","prefix":"INV-","padding":4,"period":"year","assignment":"finalization"}
```

`created_at`, `updated_at`, `created_by`, and `updated_by` are system types with `config: {}`. Grids supplies their values. They are never writable form answers.

## Configure object-list columns {icon="columns"}

`object_list.config` contains `fields` (1–200 columns), `minItems` (0–1,000, default 0), and `maxItems` (1–1,000, default 100). The whole list, including calculated cells, is limited to 256 KiB. Nested lists, relations, files, and arbitrary nested object columns are not allowed.

Each column has:

| Property | Meaning |
| --- | --- |
| `id` | Six-character alphanumeric column ID. Values use this key, not the name. |
| `name` | 1–200 characters |
| `description` | Optional hint, up to 2,000 characters |
| `type` | `text`, `longtext`, `number`, `boolean`, `date`, `select`, `percent`, or `duration` |
| `config` | Configuration of that scalar type |
| `required` | Whether an entered cell must have a value. Default false. |
| `defaultValue` | A valid literal that the editor suggests only when someone adds a row. Not applied to API writes or existing rows. Not available for calculated columns. |
| `formula` | Calculation with `expression` and an optional `format`. It references sibling columns. |
| `width` | `fullWidth` (default) or `compact`. Consecutive compact fields wrap together. |
| `detailsOnly` | Hides a calculated column until someone shows the calculation details. Default false. |

Select columns and regex rules apply only to input. Calculated columns use the supported scalar formula types. The editor shows calculations read-only, and the server recomputes them. The server does not trust submitted computed values.

For list reductions, use `LIST_SUM(Items, 'Amount')`, `LIST_AVG`, `LIST_MIN`, `LIST_MAX`, and `LIST_COUNT`. An empty list sums and counts to zero. A missing list is not an empty list. [Formulas](/app/grids/help/grids-formulas) describes expressions. [Forms](/app/grids/help/grids-forms) describes layout and defaults for forms.

## Link a Cloud resource {icon="link"}

Use `resource` with config `{}` to select one resource with the Cloud picker. It stores `{type, id, title?}`. The optional title is kept as text. Opening the resource uses its current canonical reader and its current access rules. The field stores no URL, no token, and no access. Use a file field for uploads that Grids owns, and a relation for links between Grids records.
