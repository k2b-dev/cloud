---
id: notebooks-structured-blocks
title: "Structured blocks"
icon: "ti ti-braces"
description: "Define your own data and build filtered page lists and tables of contents."
order: 130
---

Use named data for facts beside your prose, queries for automatic page lists, and a table of contents for headings on one page. No predefined metadata schema is required.

Place `:::data`, `:::query`, and `:::toc` directly in the document, outside lists, quotes, code examples, and other blocks. Nested examples are not evaluated.

For notice blocks such as `:::info`, indent the closing `:::` no more than the opening line.

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

This exposes fields such as `profile.owner` and `profile.reviewDays`. Names and field keys are case-sensitive. For query fields, use a letter followed by letters, numbers, underscores, or hyphens, up to 64 characters per part.

Values are strings, numbers, booleans, or flat lists of those values. Quote numeric-looking strings: `"30"` is not the number `30`. Write list items on separate lines with two spaces before `-`; data blocks do not accept inline arrays or nested objects. Dates remain strings rather than a separate type. A key with no value or list items is an empty list; use `""` for an empty string.

Do not repeat a block name or a key inside a block. Invalid named data is excluded from queries and reported as a diagnostic. A block supports at most 64 fields, a list 128 items, and a string 2,000 characters.

## List matching pages {icon="list-search"}

Type `:::` in the editor and choose **query**. This example finds handbook pages with active status and a review interval of at most 30 days:

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

Queries read saved notes from the current notebook only. They cannot fetch other notebooks, read table rows, run JavaScript, join datasets, or write changes.

| Setting | Meaning |
| --- | --- |
| `source` | Required: `notes` |
| `scope` | `notebook` (default), direct `children`, or all `descendants` of this note |
| `match` | `all` (default) requires every filter; `any` requires at least one. No filters means all notes in scope. |
| `sort` | `field`: `$title`, `$created`, or `$updated`; `direction`: `asc` or `desc`. Default: updated descending. |
| `columns` | Fields to display, one per indented list item. Omit for a linked title list. |
| `limit` | 1–100 results, default 25. A notice indicates additional matches; narrow your filters to see them. |

Use at most 32 filters and 16 distinct columns per query. A page supports at most 20 query blocks. Lists in filters use inline syntax such as `[active, draft]` with 1–100 values.

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

Omit `value` for `exists` and `missing`. Membership operators take lists; other operators take one value. `in` tests a scalar against a list, while `contains-any` and `contains-all` test list contents.

Equality preserves types and text case. Text `contains` and `starts-with` ignore case; tags ignore case and an optional leading `#`. `ne` and `not-in` do not match missing fields: use a separate `missing` filter with `match: any` if needed. Empty lists exist. There are no nested filter groups, expressions, date-range comparisons, or custom-field sorting.

## Add page contents {icon="list"}

Type `:::` and choose **toc**:

```text
:::toc
min-depth: 2
max-depth: 3
:::
```

The block links to headings in this note, including headings after the block. Depths range from 1 to 6; defaults are 1 and 6. This is a page contents list, not a notebook index.

## Preview and refresh {icon="refresh"}

Rich mode shows server-rendered query and contents previews. Move the cursor into a block or choose **Show source** to edit it. Invalid settings are marked at their source lines. A draft preview does not save the draft or modify matching notes.

Book renders the same blocks on the server without an editor. Saved changes refresh Book and query previews automatically when JavaScript is available. Read-only keeps its saved source until you reload; reload after that source changes. Without JavaScript, Book still renders results and links on page load.

## Keep tables and tasks readable {icon="table"}

Ordinary tables, lists, checkboxes, and named sections remain Markdown. Use table formulas for calculations within a table; queries only index named `:::data` properties and the system fields above.
