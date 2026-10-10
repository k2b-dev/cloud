---
id: notebooks-structured-blocks
title: "Structured blocks"
icon: "ti ti-braces"
description: "Define your own data and build filtered page lists and tables of contents."
order: 130
---

Use named data for facts next to your text, queries for automatic page lists, and a table of contents for the headings of one page. You do not need a predefined metadata schema.

Place `:::data`, `:::query`, and `:::toc` directly in the document. Do not put them in lists, quotes, code examples, or other blocks. Notebooks does not evaluate nested blocks.

For notice blocks such as `:::info`, do not indent the closing `:::` more than the opening line.

## Add your own data {icon="braces"}

Put a stable name directly above a data block:

```text
@profile
:::data
owner: Ada
status: active
reviewDays: 30
approved: true
teams:
  - operations
  - support
:::
```

This creates fields such as `profile.owner` and `profile.reviewDays`. Names and field keys are case-sensitive. For query fields, start each part with a letter, followed by letters, numbers, underscores, or hyphens. Each part has at most 64 characters.

:::reference
- **Values:** Strings, numbers, booleans, or flat lists of these values.
- **Numbers as text:** Quote a string that looks like a number. `"30"` is not the number `30`.
- **Lists:** Write each list item on its own line with two spaces before `-`. Data blocks do not accept inline arrays or nested objects.
- **Dates:** Dates stay strings. There is no separate date type.
- **Empty values:** A key with no value and no list items is an empty list. Use `""` for an empty string.
:::

Do not repeat a block name, and do not repeat a key inside a block. Queries exclude invalid named data, and Notebooks reports it as a diagnostic. A block has at most 64 fields, a list 128 items, and a string 2,000 characters.

## List matching pages {icon="list-search"}

Type `:::` in the editor and choose **query**. This example finds handbook pages with the status active and a review interval of at most 30 days:

```text
:::query
source: notes
scope: notebook
match: all
where:
  - field: $tags
    op: contains-all
    value: [handbook]
  - field: profile.status
    op: eq
    value: active
  - field: profile.reviewDays
    op: lte
    value: 30
sort:
  field: $updated
  direction: desc
columns:
  - $title
  - profile.owner
  - profile.reviewDays
limit: 25
:::
```

Queries read only saved notes from the current notebook. They cannot fetch other notebooks, read table rows, run JavaScript, join data sets, or write changes.

Use the indentation of the example. Put two spaces before filter list items, columns, and sort fields. Put four spaces before the `op` and `value` of a filter. The format is a small format similar to YAML, not general YAML. It does not support comments, anchors, or nested filter objects. To use the default of an optional setting, leave the setting out. Do not leave its value blank.

| Setting | Meaning |
| --- | --- |
| `source` | Required: `notes` |
| `scope` | `notebook` (default, includes this note), direct `children`, or all `descendants` of this note. Children and descendants exclude this note. |
| `match` | `all` (default) requires every filter; `any` requires at least one. Without filters, all notes in the scope match. |
| `sort` | `field`: `$title`, `$created`, or `$updated`; `direction`: `asc` or `desc`. Default: updated, descending. |
| `columns` | Fields to show, one per indented list item. Without columns, the query shows a list of linked titles. |
| `limit` | 1–100 results, default 25. A notice shows that more notes match. Narrow your filters to see them. |

A query has at most 32 filters and 16 different columns. A page has at most 20 query blocks. Lists in filters use inline syntax such as `[active, draft]` with 1–100 values. A filter string has at most 2,000 characters. Quote list values that contain commas, for example `["Sales, Europe", Support]`.

## Choose filters {icon="filter"}

| Field or value | Operators |
| --- | --- |
| `$title` | `eq`, `ne`, `in`, `not-in`, `contains`, `starts-with` |
| `$created`, `$updated` | `eq`, `ne`, `in`, `not-in`; use full timestamps such as `2026-09-01T10:00:00Z` |
| `$tags` | `contains` for one tag; `contains-any` or `contains-all` for a list; `exists` or `missing` |
| Named scalar data | `eq`, `ne`, `in`, `not-in`, `exists`, `missing` |
| Named text | Also `contains`, `starts-with` |
| Named numbers | Also `gt`, `gte`, `lt`, `lte` |
| Named lists | `contains-any`, `contains-all`, `exists`, `missing` |

Leave out `value` for `exists` and `missing`. Membership operators take lists. Other operators take one value. `in` tests one value against a list. `contains-any` and `contains-all` test the contents of a list.

:::reference
- **Equality:** Keeps types and text case.
- **Text:** `contains` and `starts-with` ignore case.
- **Tags:** Ignore case and an optional leading `#`.
- **Missing fields:** `ne` and `not-in` do not match missing fields. If you need them, add a separate `missing` filter with `match: any`.
- **Exists:** Empty property lists exist. `$tags` exists only when a note has at least one tag.
- **Not available:** Nested filter groups, expressions, date range comparisons, and sorting by your own fields.
:::

## Add page contents {icon="list"}

Type `:::` and choose **toc**:

```text
:::toc
min-depth: 2
max-depth: 3
:::
```

The block links to the headings in this note, also to headings before and after the block. Depths go from 1 to 6. The defaults are 1 and 6. `min-depth` must not be greater than `max-depth`. The block lists the contents of one page, not an index of the notebook.

Book also links to headings in lists, quotes, and notices. The editor preview can jump only to headings with an exact source position. For other headings, it shows a notice.

## Preview and refresh blocks {icon="refresh"}

Rich mode shows query and contents previews that the server renders. To edit a block, move the cursor into it or choose **Show source**. Notebooks marks invalid settings on their source lines.

A draft preview uses the query settings and headings of your draft. Queries still read saved data, even for the current note. The preview does not save the draft and does not change matching notes.

Book renders the same blocks on the server, without an editor. When JavaScript is available, saved changes refresh Book and query previews automatically. **Read-only** keeps its saved source until you reload. Reload after that source changes. Without JavaScript, Book still shows results and links when the page loads.

## Keep tables and tasks readable {icon="table"}

Ordinary tables, lists, checkboxes, and named sections stay Markdown. Use table formulas for calculations in a table. Queries index only named `:::data` properties and the system fields above.

Book evaluates the same table formulas as the editor, including computed columns, totals, and progress bars. A formula error stays visible in its cell. Table headers and ordinary cells also support inline formatting, links, images, and LaTeX. Formula results stay plain values.
