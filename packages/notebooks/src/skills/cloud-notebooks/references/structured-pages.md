## Flexible data and automatic page lists

Keep the user's metadata vocabulary; there are no required handbook fields. Data and query configuration use a small YAML-like format, not general YAML. Place directives directly in the document, outside lists, quotes, code fences and notices. Close with a separate `:::` line, using zero to three leading spaces; unindented delimiters are safest. Scripts are not supported.

Example named data (the name must directly precede the block):

```text
@profile
:::data
status: active
owner: Ada
reviewDays: 30
teams:
  - operations
  - support
:::
```

Fields such as `profile.status` are case-sensitive. Both parts start with an ASCII letter and use up to 64 letters, digits, underscores or hyphens. Values are strings, numbers, booleans or flat lists; dates remain strings. Quote numeric-looking strings. Data lists use separate indented lines, not inline arrays; nested objects are unsupported. A blank field is an empty list; `""` is an empty string. Limits: 64 fields per data block, 128 items per list, 2,000 characters per string. Duplicate names/keys or invalid data prevent the affected data from being indexed. When replacing a named data block, include its `:::data` and closing delimiters, not bare JSON or only its inner values.

Example automatic list using that data:

```text
:::query
source: notes
scope: notebook
match: all
where:
  - field: profile.status
    op: eq
    value: active
  - field: $tags
    op: contains-all
    value: [handbook]
sort:
  field: $updated
  direction: desc
columns:
  - $title
  - profile.owner
limit: 25
:::
```

- Queries read saved notes in the current notebook only. Draft preview changes the query and headings, not the indexed data, even for the current note. No joins, table-row sources, JavaScript, SQL, network access or write effects.
- `scope`: `notebook` includes the current note; `children` and `descendants` are relative to it and exclude it. `match`: `all` or `any`; zero filters matches every note in scope. Defaults: notebook, all, updated descending, 25 results. Omit optional settings for defaults rather than leaving values blank.
- Select/filter `$title`, `$created`, `$updated`, `$tags` or `block.key`. Sort only by title/created/updated with `asc` or `desc`. Omit columns for linked titles; selected columns produce a table.
- Limits: 20 query blocks per page; 32 filters, 16 distinct columns, 1–100 results per query; filter lists contain 1–100 values and strings at most 2,000 characters. A result limit is not pagination: narrow filters if truncated.
- Use two spaces for list items and sort fields, four for filter continuations. Query lists are inline, for example `[active, draft]`. Quote comma-containing items. Comments, aliases, nested filter groups and expressions are unsupported.

Choose operators by field:

- Title: `eq`, `ne`, `in`, `not-in`, `contains`, `starts-with`.
- Created/updated: only `eq`, `ne`, `in`, `not-in` with full RFC3339 timestamps such as `2026-09-01T10:00:00Z`; no date ranges or relative-date expressions.
- Tags: `exists`, `missing`, `contains`, `contains-any`, `contains-all`.
- Named scalar data: typed `eq`, `ne`, `in`, `not-in`, `exists`, `missing`; strings also `contains`/`starts-with`, numbers also `gt`/`gte`/`lt`/`lte`. Named lists support `contains-any`/`contains-all` and existence checks.

Omit value for exists/missing. Membership operators take a non-empty list; others take one scalar. Equality preserves type and case; string contains/starts-with ignore case. Tags ignore case and an optional leading #. Negative comparisons exclude missing fields: combine with a missing filter using match:any when needed. Empty property lists exist; tags exist only when at least one is present.

## Page contents and tables

```text
:::toc
min-depth: 2
max-depth: 3
:::
```

TOC links to headings before and after the block on this page, not other pages. Depths range from 1 to 6, defaulting to 1/6; min must not exceed max. Book supports nested heading links; the editor can jump only where an exact source position is available. Use a query for a notebook index. With JavaScript, saved changes refresh Book and rich previews; without it, Book renders on page load. Read-only source changes require reload.

Tables and tasks remain Markdown. Formula cells start with =, such as `=SUM(Hours)`, `=IF(Status == "done", "closed", "open")` or `=PROGRESS(2, 10)`. Use real column names; quote names containing spaces with backticks. These formulas operate within their table, not across query results or notebooks. Book and editor share formula evaluation, including totals/progress; errors remain visible. Ordinary Book table cells and headers support inline formatting, links, images and LaTeX. Escape literal table pipes as backslash-pipe. Preserve unknown existing syntax instead of inventing spreadsheet functions; note.preview is not a formula validator.
## Preview before saving structured changes

Use notebooks.note.preview with the complete proposed Markdown before saving query or TOC changes. Fix diagnostics, then use the original saved note's hash as the edit precondition, not the preview hash. Preview the saved note after saving changed data. Preview checks query/TOC blocks, not every Markdown feature, data block or table formula; it is not a formula validator. Draft previews require write access and an unlocked note; previews require a user-backed actor.
