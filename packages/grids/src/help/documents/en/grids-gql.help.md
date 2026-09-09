---
id: grids-gql
title: GQL
icon: ti ti-code
description: Find, combine, and summarize Grids data with the Grids Query Language.
order: 125
---
GQL is the Grids Query Language. It describes which saved data you want and how Grids should shape the result. The query explorer, saved views, Grids App blocks, document sources, exports, and CLI use the same language.

You do not need GQL for ordinary table work. Start with Search, Filter, Sort, and Computed controls. Use GQL when text makes a precise query easier to understand, reuse, or review.

## Query with AI {icon="sparkles"}

Choose **Query with AI** in the editor to open an Assistant draft with this Base,
source and query. Add what you want to find, then send it. Assistant discovers
relevant fields, checks queries and displays actual results with the same
permissions as the editor. This chat cannot change records or the schema.

It can save a query as a View after you confirm its name and personal/shared
visibility; both require Base admin rights. Use the returned link to open the
query in a new browser tab, keeping the conversation open. Very long queries may need copying instead. Previews and
paginated results are not complete exports.

The built-in **cloud-grids** Skill directs Assistant to current Help for product
questions and administration. It explains GUI steps when no tool supports an
operation; it does not grant more permissions.

For a generic request, describe the result you want before Assistant reads the
schema. When a query fails, its diagnostic includes the technical cause and
location. A corrected query should keep the same business conditions, not replace
a parent status with a line-item status. Joined select/membership filters are not
currently supported. Standalone Assistant queries use `TODAY()` and `NOW()`;
Custom App `@auth` and `@time` context is not supplied to these queries.

## Read a first query {icon="search"}

This query reads the Books table, keeps available books, chooses three fields, orders the newest first, and returns at most 25 rows:

```gql
from table Books
where Status = 'Available'
select Title, Author, Published
sort Published desc
limit 25
```

Each line is one clause:

- `from` chooses a table or saved view.
- `where` removes records that do not match an exact rule.
- `select` chooses the output columns.
- `sort` defines the order.
- `limit` deliberately caps the complete result.

Write field and table names as shown in Grids. Put names containing spaces in double quotes, such as `"Birth year"`. Put text values in single quotes, such as `'Available'`.

## Build a query safely {icon="search"}

Start with only the source and preview it:

```gql
from table Books
```

Then add one concern at a time: a filter, selected fields, and finally a meaningful sort. The editor resolves accessible tables, views, fields, relations, and aliases as you type. Diagnostics identify syntax, unknown names, ambiguity, incompatible operations, and permission failures instead of guessing.

Omitting `select` returns all ordinary source fields. Expensive post-query fields such as HTML templates require an explicit `select`. List important fields explicitly when a saved result, document, or integration needs a stable output.

An explicitly selected HTML template field is rendered after the bounded primary records have been read. It cannot be used in `where`, `sort`, `group by`, `aggregate`, `having`, or formula expressions because Liquid and CSS are rendered only after the query result is known. Selecting an HTML template from a joined table is also unsupported; create the output field on the primary stored table instead.

## Common query tasks {icon="search"}

**Find exact records**

```gql
from table Tasks
where Status = 'Open' and Priority != 'Low'
sort Due asc
```

Use `where` for rules that must remain exact. Use `search` for broad discovery across searchable display values:

```gql
from table Books
search 'tolkien'
limit 20
```

Search can be restricted to named fields:

```gql
from table Books
search 'kingdom' in Title, Country
limit 20
```

**Add a calculated result**

```gql
from table Products
select Name, Price, formula(Price * 1.19) as gross
where Price > 0
sort gross desc
```

The calculation is part of this result and does not create a table field.

**Summarize records**

```gql
from table Orders
group by "Ordered at" by month
aggregate sum(Total) as revenue, count(*) as orders
having revenue > 0
sort "Ordered at" asc
```

Grouping returns summary rows rather than editable records. Use it for reports, charts, Grids Apps, documents, and exports. `where` filters source records before grouping; `having` filters the calculated groups.

**Follow a relation**

If Orders has a Customer relation, a join can expose fields from Customers:

```gql
from table Orders
left join table Customers as customer on Customer = customer.id
select "Order number", customer.Name as customer_name, Total
sort "Order number" asc
limit 50
```

The relation field on the left must target the joined alias's `id`. Use `left join` when records without a related target should remain in the result.

## Clause order {icon="search"}

Not every query needs every clause. When clauses are combined, keep them in this order so the source remains easy to scan:

```text
from table ...
join ...
select ...
where ...
search ...
group by ...
aggregate ...
having ...
sort ...
limit ...
offset ...
include deleted | deleted only
```

Line breaks are optional. Use semicolons when several clauses share one line, and `-- comment` for a comment:

```gql
from table Orders; where Status = 'Paid'; sort "Ordered at" desc; limit 10
```

Use each of `from`, `where`, `search`, `having`, `limit`, `offset`, and the deleted-record mode at most once. Put several fields, groups, aggregates, or sorts in one comma-separated clause. A query may contain several joins because each join introduces another source.

## Clause reference {icon="search"}

| Clause | Purpose |
| --- | --- |
| `from table` / `from view` | Choose one readable source. Add `as alias` for a shorter or repeated source reference. |
| `join` / `left join` | Follow a relation to another readable table. |
| `select` | Choose, rename, or calculate output columns. Formulas and aggregates need an alias. |
| `where` | Filter source records before grouping. |
| `search` | Search all searchable fields, or named fields after `in`. |
| `group by` | Create one summary row per value. Date fields support `by day`, `week`, `month`, `quarter`, or `year`. |
| `aggregate` | Calculate `count`, `countEmpty`, `countUnique`, `sum`, `avg`, `min`, `max`, `median`, `earliest`, or `latest`. |
| `having` | Filter grouped rows after aggregates exist. |
| `sort` | Order rows or summaries; supports `asc`, `desc`, `nulls first`, and `nulls last`. |
| `limit` | Cap the complete logical result to 1–10,000 rows. |
| `offset` | Skip 0–10,000 rows before returning results. Always pair it with a meaningful sort. |
| `include deleted` | Include live and deleted records. |
| `deleted only` | Return only records in trash. |

The two deleted-record clauses are mutually exclusive. Normal queries return live records only.

`from view` starts with the saved view's query and then applies the new clauses. It is useful when a reviewed data set is already the correct starting point. Not every GQL query can be reused as a nested source: for example, a saved query with relation joins, cross-field comparisons, or an offset is unavailable as a `from view` source. Grids rejects these references rather than dropping their filters. Run the saved query directly, or start from its table and explicitly carry over the required clauses. A view that filters by record metadata also cannot be used as another view's source.

## Names, aliases, and values {icon="point"}

- Use readable table, view, and field names when they are unambiguous.
- Quote names containing spaces or punctuation with double quotes.
- Use single quotes for literal text.
- Use source aliases after joins, for example `customer.Name`.
- Use brace-wrapped public IDs when generated configuration or a migration needs an immutable reference.
- Do not use removed `#field` aliases.

Aliases used after `as` must start with a letter or underscore, may then contain letters, numbers, and underscores, and may be at most 64 characters. An alias cannot be a GQL keyword, logical operator, or reserved literal. Aliases are case-insensitive when referenced later.

When `from` is omitted in a table or view query editor, the current page can provide the source. Write it explicitly when the query should remain understandable outside that page.

## Conditions and helpers {icon="search"}

Use `=`, `!=`, `>`, `>=`, `<`, and `<=` for comparisons. Combine conditions with `and`, `or`, `not`, and parentheses:

```gql
from table Inventory
where (Status = 'Available' or Status = 'Reserved') and Quantity > 0
sort Name asc
```

Use the operators between expressions. Do not write function-style `AND(...)`, `OR(...)`, or `NOT(...)`.

Text helpers are `contains`, `startswith`, `endswith`, and the case-insensitive `icontains`, `istartswith`, and `iendswith`. Membership helpers support controlled and multi-value fields:

- `oneof(Field, 'a', 'b')`
- `noneof(Field, 'a', 'b')`
- `containsall(Field, 'a', 'b')`

Use `null` for a missing value. Sort defaults to ascending order with missing values last. Add `desc`, `nulls first`, or `nulls last` when another order is required.

A condition can also be a formula:

```gql
from table Products
where Price <= "Purchase price" * 1.10
select Name, Price, "Purchase price"
```

Open **Formulas** for expression syntax and the complete function catalog.

## Use Grids App context {icon="app-window"}

Grids App queries receive typed request context automatically. Values are bound separately from the query text.

| Reference | Value |
| --- | --- |
| `@auth.id` | Current account UUID, or `null` for an anonymous visitor |
| `@auth.subjects` | Flat UUID list containing the current user and all effective direct or nested groups; empty for anonymous visitors |
| `@params.<name>` | A declared and validated page parameter |
| `@page.id`, `@page.title`, `@page.url` | Current page identity and canonical relative URL |
| `@app.id`, `@app.name` | Published Grids App identity |
| `@base.id`, `@base.name` | Owning Base identity |
| `@time.now`, `@time.today`, `@time.timeZone` | One request timestamp, local date, and IANA timezone |

Use `@auth.id != null` when a query requires a signed-in account. An anonymous app request can be matched explicitly with `@auth.id = null`. Unknown namespaces and undeclared parameters are publish errors.

Use `oneof(Participants, @auth.subjects)` when a Principal field grants the current user or any of their effective groups access to a record. Effective group memberships are resolved server-side; the query never receives group members or names. `@auth.subjects` is a list and is therefore valid only in `oneof`, `noneof`, or `containsall` membership predicates.

```gql
from table Loans
where oneof(Participants, @auth.subjects)
```

```gql
from table Loans
where record.createdBy = @auth.id and Status = 'Active'
limit 100
```

Page, block, Form, and action `availableWhen` rules use the same context. They are available only when their bounded query returns at least one row. Errors, missing values, timeouts, cancellation, and an empty result all mean unavailable.

```gql
from table Loans
where record.id = @params.loan_id and Status = 'Active'
limit 1
```

### Predicate compatibility

The simple field predicates below are the clearest choice when they fit. A boolean formula can compare fields or calculated expressions when a direct predicate is not enough.

| Field value | Supported direct predicates |
| --- | --- |
| Text, long text, ID | `=`, `!=`, `contains`, `startswith`, `endswith`, `icontains`, `istartswith`, `iendswith` |
| Number, percent, duration | `=`, `!=`, `<`, `<=`, `>`, `>=` |
| Date | `=`, `!=`, `<`, `<=`, `>`, `>=`; write dates and date-times as single-quoted ISO values |
| Boolean | `= true`, `= false`, `!= true`, `!= false`, or the field alone |
| Select | `=`, `!=`, `oneof`, `noneof`, `containsall`; values may be option labels or option ids |
| Relation | `=`, `!=`, `oneof`, `noneof`, `containsall`; values are related record public IDs |

Comparing a filterable field with `null` uses `=` for empty and `!=` for not empty. Other comparisons with `null` are invalid. Scalar formula, lookup, and rollup outputs can participate in a supported true/false formula. JSON and file fields cannot be filtered directly.

### Record metadata

Record metadata uses the reserved `record` scope:

| Reference | Use |
| --- | --- |
| `record.id` | Match one record public ID with `=` or several with `oneof(...)` |
| `record.createdBy` | Match one or several creator user UUIDs |
| `record.updatedBy` | Match one or several last-editor user UUIDs |
| `record.deletedBy` | Match one or several deleting-user UUIDs |
| `record.finalizationState` | Match `draft`, `awaitingReview`, or `finalized` with `=` or `oneof(...)` |
| `record.finalizedAt` | Finalization time returned with Record metadata |
| `record.finalizedBy` | Finalizing user UUID returned with Record metadata |
| `record.createdAt` | Sort by creation time |
| `record.updatedAt` | Sort by last update time |
| `record.deletedAt` | Sort deleted records by deletion time |

Metadata filters may be combined with `and`, but not placed inside an `or` branch. User values are UUIDs; record values are public IDs, not display names.
`awaitingReview` means a current Four-eyes request still matches the Record version and Table policy. Rejected and superseded requests are history,
not current Record states. A Table without Finalization enabled has no `draft` Records.

## Grouping and aggregate reference {icon="chart-bar"}

`group by` returns one row per distinct value. Date fields can additionally use `by day`, `week`, `month`, `quarter`, or `year`. Every non-aggregate field used by a grouped `sort` must also appear in `group by`; aggregate aliases can be sorted directly.

Every aggregate needs an output alias:

```gql
from table Orders
where Status = 'Paid'
group by Customer
aggregate count(*) as orders, sum(Total) as revenue, latest("Ordered at") as last_order
having revenue >= 1000
sort revenue desc nulls last
```

| Aggregate | Accepted input |
| --- | --- |
| `count(*)` | All matching records; `*` is valid only with `count` |
| `count(field)`, `countEmpty(field)`, `countUnique(field)` | Any readable field or formula |
| `sum(field)`, `avg(field)`, `median(field)` | Numeric fields and numeric formulas |
| `min(field)`, `max(field)` | Number, date, date-time, or text fields and formulas |
| `earliest(field)`, `latest(field)` | Date or date-time fields and formulas |

Aggregate a calculated value with `aggregate sum(formula(Quantity * Price)) as revenue`. The formula is evaluated for each source record before the aggregate combines the results.

Omit `group by` to calculate one summary row for the complete matching set:

```gql
from table Orders
where Status = 'Paid'
aggregate count(*) as orders, sum(Total) as revenue
having orders >= 1
```

An aggregate-only query may use `having` to keep or remove its summary row. It cannot also select record fields or sort its single result row. Add `group by` when you need several sortable summary rows.

## Paging and result bounds {icon="point"}

Without `limit`, a result view can continue through all matching rows one page at a time. With `limit 100`, the complete result stops after 100 rows even if the UI displays it in smaller pages.

Changing the query starts again at the first page. Pages show live data rather than one frozen result, so records changed between page requests can move between pages.

For automated reads, the CLI can request one bounded page with `--page-size` or continue with `--all --max-rows N`.

## Permissions and supported queries {icon="shield-lock"}

Raw Grids queries require Base Read and can read the complete Base. Published Grids App queries instead run through the app's immutable capability snapshot and cannot escape to undeclared sources or fields.

Autocomplete follows the same boundary: the raw editor uses the current Base schema, while a Grids App editor uses a schema-only catalog for that app definition. It does not execute queries or reveal another Base.

GQL deliberately does not support arbitrary join conditions, subqueries, common table expressions, window functions, or unrestricted expressions. An unsupported query fails with a diagnostic instead of being guessed or partially applied.

## Views and query results {icon="search"}

Row-shaped table and view results can be displayed and paged like records. Grouped and aggregate-only results use a summary table and are not editable. Compatible query results can be saved as views and reused by Grids Apps, documents, and exports.

Use a saved View when people revisit the result in the raw Base workspace. Keep GQL local to a Grids App block or document when the query exists only for that resource.

## Troubleshoot a query {icon="lifebuoy"}

:::reference
- **Unknown source or field:** Check spelling, quoting, current base, and access.
- **Ambiguous name:** Add a source alias or use a scoped field such as `customer.Name`.
- **Join must target an id:** Join the relation field to the joined alias's `.id`.
- **Grouped sort is rejected:** Sort by a group or aggregate output that exists in the summary.
- **Missing rows:** Check `where`, `search`, source view, deleted mode, and `limit`.
- **Unstable page order:** Add a business sort before paging or using `offset`.
:::

:::note GQL is not a second data model
GQL shapes saved data. It does not copy records or bypass the access, field, and relation rules of the base.
:::
