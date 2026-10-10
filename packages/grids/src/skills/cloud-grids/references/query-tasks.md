# Query tasks

Use these as intent patterns, not executable queries against an unknown schema. Discover actual names/IDs, types, options and relationships first. Read grids-gql for syntax, then preview. Explicitly select fields; use stable sorting when paging.

1. Exact record lookup: use record.id for a known public record ID, filter a discovered business-identifier field for a display number, or read a returned grids.record reference. These identifiers are not interchangeable.
2. Available inventory: filter the discovered status option, not a guessed translated label.
3. Overdue loans: combine open-state selection with the due date before the runtime-local day. Confirm whether returned/cancelled loans are excluded.
4. My open items: discover the authoritative current identity and assignee type. Standalone capability queries have no injected @auth context. User and group membership are not interchangeable strings.
5. Unpaid invoices: agree on outstanding balance versus status and exclude cancelled documents as requested.
6. Monthly revenue: choose paid/issued date and currency, group the date by month and aggregate sum of the exact amount. Never sum just one page.
7. Top customers by revenue: aggregate by customer identity and sort the aggregate descending; do not merge different customers that share a label.
8. CRM follow-ups: combine open state, owner and next-contact date; decide what a missing date means.
9. Relation names: left join the discovered target on the source relation = alias.id, then select needed target columns. Respect unreadable targets.
10. Missing relations: use the documented empty predicate on the relation. An unreadable target is not necessarily a missing relation.
11. Stock below minimum: compare the two numeric fields using the documented field-comparison syntax; quoting a field name as a text literal changes its meaning.
12. Reusable report: preview, execute, agree on name/visibility, then request View creation approval. If denied or unavailable, offer the editor link instead.
13. Invoice items inside one record: first establish whether Items is an object_list or a relation. List reductions calculate within each record; ordinary aggregates combine records. Do not turn a list into a join or sum a parent total repeatedly.

## Typed values

Read grids-tables-fields for object lists and finalization, grids-formulas for LIST functions and rounding, and grids-custom-app-api for form payloads. Use Help search/read rather than copying the handbook into the chat.

An object_list contains one level of parent-owned rows, not separate records. Use it for invoice positions that have no independent permissions or lifecycle; use a relation when the items need either. Load grids.gql.context kind list-columns with tableId and fieldId for the actual column IDs, scalar types, constraints and calculations; follow its cursors. The list metadata reports minimum and maximum row counts. If that discovery is unavailable, ask for the configuration or offer the existing editor link; names alone are not enough to invent writable IDs.

Write a JSON array keyed by discovered six-character column IDs. Decimal amounts remain strings. Omit calculated columns even when record.read returned them. Updating a list replaces the whole list: retain all intended rows from the current record and use ifVersion; do not send just the edited row. An empty array clears a list only when its required/minimum-row rules allow it. Nested lists, per-item records and independent item permissions are not supported.

Example using discovered column names, not JavaScript property access:
```gql
from table Invoices
select "Invoice number", formula(LIST_SUM(Items, 'Amount')) as items_total
limit 25
```

LIST_COUNT counts rows. LIST_SUM/AVG/MIN/MAX require a numeric column name or ID as the second string argument. For an empty list SUM and COUNT return zero; AVG/MIN/MAX return null. A missing list returns null. For totals across invoices, aggregate the numeric invoice-total field; do not sum only the displayed page. Agree on currency and explicit ROUND(..., 2) before treating a calculation as a monetary amount. Display units do not convert currencies; decimal-place constraints reject excess precision instead of silently rounding it.

Finalizing a parent freezes its typed list cells and formula/lookup/rollup results atomically with final numbers. Numeric values remain queryable; a related record is not recursively finalized. A generated document is a separate immutable artifact, not proof that its source record was finalized. Follow the current record status and documented correction workflow, not edits to frozen values. Four-eyes approval applies to the reviewed version and requires another eligible person. Do not promise legal conformity or a finalization tool that is absent from the live catalog.

Syntax examples from canonical GQL Help (replace names with discovered resources):

```gql
from table Orders
group by "Ordered at" by month
aggregate sum(Total) as revenue, count(*) as orders
sort "Ordered at" asc
```

```gql
from table Orders
left join table Customers as customer on Customer = customer.id
select "Order number", customer.Name as customer_name, Total
limit 50
```

A left join preserves unmatched readable source records. A relation with many targets can multiply result rows; account for that before aggregation. Diagnostics, permission errors and truncation are part of the result, not an invitation to invent missing data.

## Read stored document files

For download links, use the downloadUrl returned by document.list/read/create verbatim; each artifacts[] entry carries its own downloadUrl. Every format (PDF, CSV, JSON, XML, renderer artifacts) uses the same links. They require the user's current Cloud session and are not a public share. Studio/code tools needing file bytes use document.content.read plus cloud.capabilities.streams.read; do not fetch invented paths.

Use `grids.document.read` for metadata and available artifact keys. When the task needs actual PDF, XML or CSV bytes, use `grids.document.content.read` with the document ID and optional artifactKey; omission selects the primary artifact. In code mode, obtain the stream via cloud.capabilities.run in the current run and pass it to cloud.capabilities.streams.read to receive a File. Read XML/CSV as text or use an available PDF processor. A binary download alone does not extract PDF text or prove that you inspected its contents. Prefer GQL for structured data analysis. This is a read, not document issuance, a public share or sending a file. Respect the 50 MiB code-mode payload budget and 250 MiB total transfer budget; larger stored artifacts require a supported HTTP/CLI transfer. Streams expire, require current permissions and cannot be reused across turns or in mandate-backed background tasks. Never invent stream references or export capabilities.