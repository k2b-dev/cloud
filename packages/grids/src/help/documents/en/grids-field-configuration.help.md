---
id: grids-field-configuration
title: Field configuration reference
icon: ti ti-adjustments
description: Field types, options, generated IDs, defaults, and object-list columns for Base authors.
order: 111
---
Use this reference when configuring a field through the CLI or API. For choosing a field, see [Tables & fields](/app/grids/help/grids-tables-fields). Run `cld grids fields types --json` for the live catalog and `cld grids fields type <type> --json` for one type; do not infer configuration from a field's display label.

## Shared options {icon="settings"}

A field has `name` (1–200 characters), optional `description` (up to 2,000), `icon` (up to 200), integer `position`, and `required`, `presentable`, `hideInTable` flags (false by default). Names are unique within the table, ignoring case and surrounding whitespace. The presentable field supplies the Record label; it does not change permissions.

`type` is fixed after creation. Updating `config` replaces that configuration; it does not merge missing nested options. Use public field and table IDs in APIs. A label in an example is not an ID.

`defaultValue` is a typed default for omitted values on new Records. Explicit `0` and `false` are values, not omissions. `null` means no configured default. Date fields additionally accept `{"kind":"now"}`. Defaults never rewrite existing Records.

`indexed` is available for text, long text, ID, number, percent, duration, date, boolean, and single-select fields. `uniqueConstraint` is supported for text, long text, number, percent, date, boolean, and ID fields. Add indexes for actual query patterns; they add work to writes.

## Entered values {icon="edit"}

| `type` | `config` options and defaults |
| --- | --- |
| `text` | `minLength` ≥ 0, `maxLength` ≥ 1, `regex`, `multiline` (false). Text is trimmed. |
| `longtext` | `minLength`, `maxLength`, `regex`, `markdown`. Preserves whitespace. |
| `number` | `min`, `max` as decimal strings or numbers; `precision` 1–38; `decimalPlaces` 0–20; `integerOnly`; `unit` 1–20 characters; `unitPosition`: `prefix` or `suffix`. Decimal values remain strings. Precision restrictions reject excess digits rather than silently rounding. |
| `boolean` | `{}`. Stores true, false, or null when optional. |
| `date` | `includeTime` (false), `min`, `max`. Date-only values use `YYYY-MM-DD`; date-time values include a timezone. |
| `select` | Required `options: [{id, label, color?, description?}]`; `multiple` (false); `minSelected` ≥ 0; `maxSelected` ≥ 1. Values are arrays of option IDs, even for a single-select field. |
| `principal` | `cardinality: "single" \| "multiple"` (multiple). Values are arrays of typed Cloud user/group UUID references, at most 100. Picker visibility is permission-aware. |
| `percent` | `range: "percent" \| "fraction"` (percent), `decimals` 0–8 (2). Fraction 0.19 and percent 19 both display 19%; stored scale matters in formulas. |
| `duration` | `unit: "seconds" \| "minutes" \| "hours"`. Values represent nonnegative seconds; numeric input is rounded to whole seconds. Also accepts `HH:MM:SS` and `MM:SS`. Display units do not change the storage unit. |
| `json` | `{}`. Any valid JSON value; properties have no declared Grids field schema. A string input is interpreted as JSON text. |
| `file` | `maxFiles` 1–100 when set; `accept` up to 100 MIME types, wildcard MIME types, or extensions. Upload and detach use File operations, not Record JSON writes. |
| `object_list` | See the column contract below. |

For a Principal value, use `[{"type":"user","id":"<user-uuid>"}]` or a `group` reference. An identity in a field is data, **not a grant**. Assigning the current user securely belongs to a published app's configured submission action, not a user-editable input.

## Relations and calculated values {icon="link"}

| `type` | `config` |
| --- | --- |
| `relation` | `targetTableId`, `cardinality: "single" \| "multiple"` (multiple). Values use arrays of public Record IDs. |
| `lookup` | `relationFieldId`, `targetFieldId`, optional `format`. Reads linked values; does not copy them into editable input. |
| `rollup` | `relationFieldId`, `targetFieldId`, `agg: "count" \| "sum" \| "avg" \| "min" \| "max"`, optional `format`. |
| `formula` | `expression`, optional `format`. Use the [formula reference](/app/grids/help/grids-formulas), including exact decimal arithmetic and typed select comparisons. |
| `html_template` | `template` (up to 50 KiB), `css` (up to 32 KiB; 200 rules/1,000 declarations). Liquid roots: `record`, `table`, `app`, `business`, `date`. Output up to 300 KiB, sandboxed and read-only. |

Calculated values cannot be supplied by Record writes. Lookup/rollup access follows the data's permissions. Finalizing a Record freezes supported calculated values with their types; changing a formula later does not recalculate that frozen Record.

HTML template fields are not Documents. They require stored tables and cannot be queried through filters, sorts, groups, aggregates, formulas, or lookups. Other HTML template fields are unavailable to prevent recursion.

## Calculated-value formatting {icon="numbers"}

The optional `format` controls presentation, not stored precision: `{kind:"decimal", precision?:0..10, thousandsSeparator?:boolean}`, `{kind:"percent", precision?:0..10}`, `{kind:"date", format:"iso"|"short"|"long"|"relative", includeTime?:boolean}`, `{kind:"progress", label?:"value"|"percent"|"none"}`, or `{kind:"barcode", bcid:string, showText?:boolean}`. `bcid` is 1–80 lowercase letters/digits naming the barcode format. Use only a format compatible with the result type.

## Generated identifiers {icon="id"}

`id` is a server-generated field, not an ordinary editable text column. Its configuration uses:

| `strategy` | Options |
| --- | --- |
| `sequence` (default) | `prefix` up to 32 characters; `padding` 1–16 (1); `assignment` below |
| `date_sequence` | `prefix`; `padding` 1–16 (4); `period: "year" \| "month" \| "day"` (year); `assignment` below |
| `short_code` | `prefix`; `length` 4–12 (5) |
| `random_code` | `prefix`; `groups` 2–4 (2); `segmentLength` 3–6 (4) |
| `uuid` | `prefix` |
| `uuidv7` | `prefix` |
| `ulid` | `prefix` |

Only the two sequence strategies accept `assignment: "creation" | "finalization"`; creation is the default. Enable table finalization before configuring finalization-time numbering. Drafts then have no assigned number. Values are allocated atomically and never reused; this is not a guarantee of legally gapless accounting.

Example configuration for a yearly document number:

```json
{"strategy":"date_sequence","prefix":"INV-","padding":4,"period":"year","assignment":"finalization"}
```

`created_at`, `updated_at`, `created_by`, and `updated_by` are system types with `config: {}`. They are supplied by Grids and are never writable Form answers.

## Object-list columns {icon="columns"}

`object_list.config` contains `fields` (1–200 columns), `minItems` (0–1,000, default 0), and `maxItems` (1–1,000, default 100). The entire list, including calculated cells, is limited to 256 KiB. No nested lists, relations, files, or arbitrary nested object columns.

Each column has:

| Property | Meaning |
| --- | --- |
| `id` | Six-character alphanumeric column ID; values use this key, not the name |
| `name` | 1–200 characters |
| `description` | Optional hint, up to 2,000 characters |
| `type` | `text`, `longtext`, `number`, `boolean`, `date`, `select`, `percent`, or `duration` |
| `config` | Configuration of that scalar type |
| `required` | Whether an entered cell may be empty; default false |
| `defaultValue` | Valid literal suggested only when adding a row in the editor; not applied to API writes or existing rows; unavailable for calculated columns |
| `formula` | Calculation with `expression` and optional `format`, referencing sibling columns |
| `width` | `fullWidth` (default) or `compact`; consecutive compact fields wrap together |
| `detailsOnly` | Calculated column hidden until calculation details are shown; default false |

Select columns and regex rules are input-only. Calculated columns use the supported scalar formula types. The editor displays calculations read-only and the server recomputes them; submitted computed values are not trusted.

For list reductions use `LIST_SUM(Items, 'Amount')`, `LIST_AVG`, `LIST_MIN`, `LIST_MAX`, and `LIST_COUNT`. Empty lists sum/count to zero; a missing list is not an empty list. See [Formulas](/app/grids/help/grids-formulas) for expressions and [Forms](/app/grids/help/grids-forms) for layout and form-specific defaults.
