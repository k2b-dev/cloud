---
title: Grids
navTitle: Grids
section: Work
order: 140
description: Structured data with Bases, Views, Forms, Custom Apps, documents, and workflows.
tags: [grids, tables, workflows]
updated: 2026-09-15
---

# Grids

Grids builds structured applications from tables and records. A base can grow
from a simple shared dataset into forms, saved views, dashboards, generated
documents, and workflows without splitting the domain across unrelated tools.

## Use Grids

Grids resources use six-character public IDs in URLs, API and CLI responses,
relations, workflow results, and live updates. Database UUIDs stay internal.
Cloud account/group identities and operational audit IDs use their own
contracts. Workflow capture references expose step keys; internal capture IDs
are not part of the public API.

### Choose a file format

Workflows can generate PDF, CSV, JSON, XML, SEPA transfer files, and DATEV
booking batches from captured data. Financial profiles use the shared stdlib
format implementation. Grids owns the source snapshot, approval, document
number, and export identity; generating a file does not execute a payment or
import it into accounting software.

The supported financial formats are ZUGFeRD 2.5 EN16931 CII (German EUR
invoices, referenced credit notes, and self-billing), SEPA SCT
`pain.001.001.09` GBIC 5, and DATEV 700/13 EUR booking batches. Other formats,
including UBL, XRechnung, SEPA direct debit, and instant payments, are not
provided by these profiles. Unsupported SEPA characters are input errors;
they are not silently replaced.

The in-app Help overview links every Grids topic in English and German.
Use **Field configuration reference** for field types and ID strategies,
**Financial formats** for exact inputs and limits, and **Workflows** for the
workflow, CLI, and API contracts. Agents should discover and read those Help
pages rather than infer options from a UI label.

### Start with the billing template

The **Billing** Base template provides invoices, credit notes linked to an
original invoice, and commission self-billing. Positions belong to their bill
as an Object list; payments have their own table.
It uses EUR and German business partners with distinct German VAT IDs,
with 7% or 19% VAT. Check this scope before using it for your business.

In the Billing App, new invoices and self-billing drafts suggest today's
document date. Check it before saving; choose the service and due dates yourself.
Editing a draft preserves its saved dates. Optional notes are at the end of
the edit form; **Back to document** returns to the bill. The required
buyer reference stays in the main form. After finalization, notes are read-only.

New positions suggest quantity 1, Pieces, and 19% VAT. Change these when needed;
descriptions and prices stay empty. New payments and refunds suggest today's
date. Editing preserves the saved values. Short fields share a compact row,
including in the embedded business-partner form.

**Edit draft** opens a separate form. Saving returns to the document's saved
positions and totals; preview and issuance run only there,
never alongside unsaved inputs. **Record payment** also opens a separate form.

1. Complete **Your company**, including the receiving bank account, and confirm
   that the issuer details have been checked. Example records are drafts,
   not usable company or bank details.
2. Create an invoice draft, choose or create the business partner, and enter
   positions. Review the calculated totals before issuing.
3. Choose **Issue invoice**, **Issue self-billing**, or **Issue credit note**.
   Once the request is accepted, you can navigate away and keep working.
   **Billing documents** keeps drafts, running requests, failed requests, and
   finished documents together. Reloading preserves their status. **Open document**
   appears only when the stored file exists. Finalization alone is not completion.
   If rendering fails after finalization, use **Continue creation** on the same
   bill. It retains the original document number. A workflow requiring administrator
   attention cannot be restarted from this button.
4. Record actual payments separately, review the saved entry, then choose
   **Confirm payment**. Unconfirmed payments remain visible but do not affect
   balances. Confirmation requires a finalized bill and freezes the payment;
   it can no longer be edited, deleted or moved to another bill. The balance
   combines confirmed payments and finalized corrections without multiplying
   either through joins. Recording a payment does not initiate a bank transfer.

Use **Discard draft** on the bill detail page to move an unfinished bill to Trash.
Issued bills and their documents cannot be discarded this way.

The `REF-…` value identifies an internal record; it is not an invoice number
or a sequential counter. The issued Document owns the official number. Open
the bill's **Documents** section to see that number beside its stored file.
Retries retrieve the same Document and number.

For a correction, start from the original invoice and reduce the copied
positions for a partial credit. The workflow checks the remaining net and VAT
at each rate, including whether the residual amount stays exactly correctable
after rounding. An incompatible split stays a draft; adjust its positions or
correct the complete remaining amount. Refunds require the recipient's bank
details. The document retains the original issuer and recipient facts.

For self-billing, choose the partner, supply the agreement reference and enter
positions directly in the bill's Object list. Review the saved totals and
recipient's bank account before issuing. Only this bill is finalized; there
is no separate commission collection or automatic check against earlier
commission settlements. The issuer must avoid entering the same obligation
twice. This is not accounting certification or a payment-execution service.

### Navigate a Base

Use **New** in Edit mode for permitted creation actions. Table-based actions ask for a table and preselect the current one when eligible. **View** opens the existing query editor. **Documents** always expands to **All documents** and individual template destinations. Workflow email templates live under **Settings → Email templates**.

**All documents** defaults to folders by document template and year. Search matches filenames, document numbers, and tags across the Base. Both the Base catalog and template document pages load their initial results on the server.

Open a Base's **Overview** to search its resources and use shared navigation groups.
Base admins configure one level of ordered groups in **Settings → Navigation**; groups can mix
Tables, Views, Forms, Document templates, Workflows, and Apps. Shortcuts do not
change access or resource ownership. Without visible groups, the sidebar keeps
its other resource lists open; with groups, the complete lists become expandable.
Each browser remembers its expansion state. The CLI exposes the same revision-checked
configuration through `grids bases navigation get` and `grids bases navigation set`.

- Create a base for one operational domain, then define tables, fields, and
  relationships around its records.
- Review Table structure, indexed and unique fields, write paths, Durable
  History, and Finalization together in the admin-only **Tables** Base setting.
- Save filtered or grouped views for recurring work and reporting.
- Publish Forms for guided record creation and Custom Apps for focused metrics,
  lists, instructions, and actions.
- Reuse a saved View's Cards layout and image cover in a Custom App, and expose
  bounded workflow row actions on Records blocks. Published Apps pin the View
  contract and recheck selected records server-side.
- Let signed-in App readers manage explicitly editable File fields from Record details
  without granting access to the Base record API.
### Manage files and retention

- Replace or remove a record attachment without rewriting file history. Removal
  detaches it from the current record; protected revisions or artifacts can
  retain exact bytes, while unprotected files can be cleaned up.
- Let a Base admin set one optional retention floor for trashed Records and
  newly unreferenced Files. The retention preview opens paginated,
  server-filtered Record and File lists. Record review links into the existing
  table Trash view; File review supports read-only preview and exact-byte
  download. It neither deletes data nor makes a compliance claim.
- Let a Base admin create multiple preservation holds for the entire Base or
  one active Table, with a recorded reason for creation and release. A Base
  hold covers every Table. A Table hold covers only that Table and also blocks
  destruction of its parent Base so the hold cannot be bypassed. Records remain
  editable, access and Finalization do not change, and releasing a hold never
  starts deletion.
- Let a Base admin preview and start a durable, irreversible destruction run
  for at most 100 exact unreferenced File candidates whose retention floor has
  been reached. The admin confirms the exact Base name; every File is rechecked
  for retention, references, origin Table, and preservation holds immediately
  before deletion. Records, Documents, evidence exports, and Durable History
  are excluded. Remaining work can be canceled, but destroyed bytes cannot be
  recovered.
### Keep history and finalize records

- Irreversibly enable Durable History for a stored table when every future
  Record, Relation, and File state must remain inspectable from an honest
  activation baseline. Existing tables stay unchanged until an admin opts in.
- Choose Direct Finalization for a Table when writers may lock reviewed Records
  themselves, or require Four-eyes Finalization with one Cloud approver group.
  The mode and approver group are applied atomically when Finalization is enabled.
  Four-eyes requests bind the exact current Record state, including Relations and Files; a different current
  group member with Write access approves and finalizes it through the same
  central service. Changing values, Relations, Files, trash state, or the policy
  invalidates open requests and never changes already finalized Records.
- Filter Records by **Draft**, **Awaiting review**, or **Finalized** in the
  Records metadata filter, GQL, or the CLI. Awaiting review means a current
  Four-eyes request still matches the Record and Table policy; it does not
  imply that the current viewer can approve it.
- Create the **Close selected Records** workflow starter for a stored Table
  when a reviewed selection of up to 100 Records should be closed together. Its Records
  action freezes the exact selected public IDs: Direct mode finalizes each
  eligible Record, while Four-eyes mode requests approval and never bypasses
  the configured approver. The preview also pins the complete Finalization
  policy revision, so a mode or approver change stops later steps instead of
  mixing policies. It does not close a period or capture Records added later.
- Create the linked follow-up Draft workflow starter when a finalized Record
  needs a correction or cancellation without changing the original. Choose the
  intent shown to users, an existing single-select type value, and an existing
  single self-relation for the original. The protected run option must match
  the workflow intent, so cancellation wording cannot front a correction
  workflow. You can also choose up to 100 stored
  value fields to carry over. Object lists copy their inputs and recalculate
  computed columns using the current formulas; the original stays frozen.
  The action creates a normal editable Draft that
  follows the Table's numbering rules. Unique fields, generated IDs, Files,
  other Relations, calculated fields, and Documents are not copied. A
  cancellation is named clearly, but Grids does not calculate amounts, taxes,
  or counter-bookings or generate a Document for it.
### Control record changes

For Assistant discovery, `grids.gql.context` keeps the `fields` catalog compact. Request `kind: "list-columns"` with the parent `tableId` and `fieldId` to read an object list's column IDs, scalar settings, required flags and calculations. Follow the returned cursor; `data.list` contains its effective minimum and maximum row counts. Results use the same table permissions and byte budget as other context pages. An individual column that exceeds the result budget returns `BAD_INPUT`, not a silently truncated configuration. An optional `fieldId` also filters `kind: "fields"` to one field.

- Keep the default open mutation policy, or let a Base admin limit record,
  Relation, and File changes to direct editing and APIs, Forms, or Workflows
  and actions. Every client follows the same server-enforced policy.
- Open a record's **Referenced by** section to page through permission-aware
  incoming Relations, or pin the same relationship as a Referenced records
  block in a Custom App.
- Keep relationships between compatible Form inputs, such as a start date that
  must not follow its due date, in server-enforced cross-field validation.
### Generate documents and evidence

- Generate documents or PDFs from reviewed templates and record data.
- Download the exact stored primary file or an additional artifact of a completed Document. `primaryArtifactKey` identifies the main file and its MIME type determines the format. Public links share only a primary PDF. Repeatable templates can generate a new immutable Document; once-per-finalized-record templates retrieve the existing one for that finalized revision.
- If generation has an uncertain result, keep its dialog open and retry that
  attempt. Closing loses the retry context; check All documents before creating
  another Document.
- Select an installed E-Invoice renderer on a table's Document template when
  one frozen Record snapshot must produce both a readable PDF and structured
  artifact. Generate it from the Record detail or template workspace; the same
  Document also appears in All documents. Its number, validation evidence,
  exact bytes, and hashes are immutable. Renderer validation names technical
  checks; it is not a universal compliance decision. The invoice issuer is
  responsible for the content and suitability for the intended use.
- Use automatically provisioned durable number series for sequential ID fields
  and numbered Documents. Allocations are atomic and never reused; technical
  gaps are possible, and formatting changes affect future values only.
- Let a Base admin create a bounded evidence package for one Base or table.
  The short-lived TAR contains the selected current and historical sources,
  exact stored File and Document bytes, public Grids IDs, coverage statements,
  and SHA-256 hashes. It reports unavailable history rather than reconstructing
  it or making a compliance claim; ordinary CSV and JSON exports remain unchanged.
- Generate a per-record HTML value from Liquid and inline CSS when an email body, product description, or bounded export column should stay attached to the row rather than become a Document artifact.
- Run typed, versioned workflows for repeatable record changes, document
  generation, email delivery, and bounded HTTP calls.

Use formulas for derived values and workflows for multi-step effects that need
inputs, permissions, revisions, and observable runs.

Single-select formula conditions accept an exact option ID or an unambiguous
case-insensitive label: `IF(Tax = 'ust-19', ROUND(Net / 100 * 19, 2), 0)`.
Use `HAS_OPTION(Tags, 'approved')` for exact membership, including multiple
selections; `CONTAINS` is a text search, not a Select test. Unknown options and
unsupported operations are rejected. Formula checks validate support even on
empty tables, then preview up to five records; review their results rather than
treating a successful check as proof of business correctness.

Saving formula fields, object-list calculations and computed view columns binds
Select labels to option IDs. Renaming labels preserves their meaning; deleting
an option used by these formulas is rejected. Collection-valued lookups are not
scalar formula inputs: join the target table in GQL and use its typed fields.
Runtime errors carry stable codes; authoring diagnostics explain the problem.

Formula parsing is bounded to 20,000 characters, 64 nesting levels and 1,024 expression nodes before evaluation or SQL compilation. Input-specific limits can be smaller, including the 5,000-character computed-column limit. Oversized expressions return validation diagnostics instead of entering evaluation.

`ROUND` truncates fractional places toward zero and accepts −131,072 through 16,383 places. These bounds follow PostgreSQL numeric's supported digit range. Both runtimes reject out-of-range places as a recoverable formula error before arithmetic or integer conversion.

Numeric formula results can be JSON numbers or decimal strings. JavaScript evaluation preserves a decimal string when converting to a number would lose digits, including intermediate values. Consumers must use decimal arithmetic for further calculations rather than coercing these strings with `Number(...)`. Object-list `number` columns return decimal strings; configured decimal places preserve their scale. Non-finite math results are formula errors, not successful text values.

An overflowing `POW` result also stays in the formula error channel in SQL. `IFERROR` can replace it without aborting the query; cancellation and database resource failures are not suppressed.
Fractional `POW` exponents and integers outside the signed 32-bit range use 80 significant digits, capped at 1,000 fractional places, in both formula evaluation and SQL. Round monetary results explicitly.

Finite addition, subtraction, multiplication, and remainder derive their working precision from the operands within the supported PostgreSQL numeric range. Summation uses the same operation, so a later subtraction cannot expose digits lost to a fixed precision. SQL medians retain the two middle values as numeric values instead of converting them to floating point.

Number inputs and their minimum/maximum settings must fit within 131,072 integer digits and 16,383 decimal places. Compact exponent notation does not bypass these limits. Out-of-range inputs are rejected before expanding them into stored decimal text; an out-of-range formula result produces `VALUE_TOO_LARGE`.

Division and averages share PostgreSQL numeric precision across previews and SQL. Insignificant trailing zeroes do not affect the result. Division rounds half away from zero at a scale based on the operands, between 0 and 1,000 fractional digits; it is not exact rational arithmetic. Use explicit `ROUND(expression, 2)` for a two-decimal monetary result. A column's decimal-place constraint validates the result instead of rounding it automatically.

### Keep typed line items inside one record

Use an `object_list` field for rows that belong entirely to their parent, such
as invoice positions. The list is one atomic value: editing or finalizing the
parent includes all its items. Use a related table when items need their own
permissions, links, or lifecycle.

Define scalar columns with stable six-character IDs, names, types, and the
usual field constraints. Supported types are text, long text, number, boolean,
date, select, percent, and duration. Lists cannot contain nested objects,
relations, or further lists. The editor shows names and types first;
**Rules and calculation** reveals validation and calculated-column options.

Set a column's **Default value** there to suggest a value when adding an entry.
Defaults follow the column's validation rules. Existing entries stay unchanged;
API writes still need to supply their own values. Calculated columns have no defaults.

The record editor shows 25 rows per page and preserves all edits when paging.
Adding or moving a row opens the relevant page and keeps keyboard focus with
that row. Only the edited row's calculation preview is recomputed; incomplete
rows do not hide valid previews elsewhere. Saving still validates and replaces
the entire list, including rows on other pages.

A calculated column references sibling columns in the same row. Use names
(double-quoted when they contain spaces) or column IDs. Renaming a column
does not change its ID; update name-based formulas before saving. Do not send
calculated cells in write payloads: Grids calculates them. Send exact amounts
as decimal strings, such as `"42.50"`.

Selection columns are inputs, not calculated columns. Regex constraints are
supported on text inputs, not calculated text. Saving checks that row
calculations can also run in SQL; unsupported expressions are rejected before
they can make records unreadable.

`LIST_SUM(Items, 'Amount')` totals one numeric column. `LIST_AVG`, `LIST_MIN`,
and `LIST_MAX` use the same arguments; `LIST_COUNT(Items)` counts rows.
An empty list has sum and count zero, while its other reductions return null.
A missing list returns null. In GQL, `formula(LIST_SUM(customer.Items, 'Amount'))`
also supports a joined table alias. Cross-record aggregates count
query rows, so repeated joined records repeat their totals.

Writes replace the entire list. Omitting the field leaves it unchanged during
an update; `[]` clears it if the field's required/minimum constraints allow it.
Use the record version to avoid overwriting concurrent edits. Configuration
defaults to 0 minimum and 100 maximum rows, within limits of 1,000 rows,
200 columns, and 256 KiB per list value.

Document templates receive arrays and typed scalar values, not formatted
table text. For example, iterate `record.data.ITEMS1` with Liquid and access
`item.Amount` using the actual field and column IDs. HTML output is escaped
by default. For a profile input template, use the `json` filter to retain
arrays, booleans, nulls, and exact decimal strings. Finalized records supply
their frozen calculated cells and totals even after formulas change.

## Understand the Grids model

| Resource | Responsibility |
| --- | --- |
| Base | Permission boundary and catalog for one structured application |
| Table, field, and record | Schema, typed columns, and stored domain rows |
| View and form | Reusable read perspective and guided record submission |
| Custom App | Immutable published capability surface for a focused audience |
| Document and workflow | Immutable template output from one Record, and a versioned sequence of checked effects |

Base access opens the complete raw workspace and every record in that Base.
Tables, Views, Forms, document templates, and Workflows do not have separate
Cloud grants. Use a published Custom App when an authenticated or public
audience needs only selected data, Forms, documents, and actions. App readers
do not need Base access, and an app grant never opens raw Grids APIs or GQL.
Base grants support service accounts. Custom App grants support users, groups,
all authenticated accounts, or the public, but not service accounts. Delegated
credentials access a Custom App through their user identity.

Custom App pages, blocks, Forms, and actions can use server-enforced GQL
availability rules with request context such as `@auth.id`, `@auth.subjects`,
`@params.*`, and `@time.now`. A Principal field stores typed user and group
references. `@auth.subjects` flattens the signed-in user plus effective groups
to UUIDs, so `oneof(Participants, @auth.subjects)` supports individual and team
participation without exposing group membership. Public apps receive
`@auth.id = null` and `@auth.subjects = []`; Workflow actions still require an
authenticated account.

GQL membership predicates also accept joined fields, for example
`oneof(cost.Responsible, @auth.subjects)`. They retain the direct field's typed
values and the joined table's access checks. For stored tables,
`Receipts != null` checks for current attachments; `Receipts = null` checks for
none. Combined-table file presence is not supported.

## How Grids fits Cloud

Grids owns its bases, schema, records, queries, views, forms, dashboards,
documents, and workflows. Cloud supplies identity, resource access,
notifications, background execution, audit and observability primitives, PDF
rendering, application discovery, and shared Help and administration surfaces.

## Find detailed product help

Open **Help** inside Grids for the core model, schema, formulas, Views, Forms,
Custom Apps, public publishing, documents, evidence exports, permissions, GQL,
workflows, and troubleshooting.
Developers can read [Resource authorization](/en/docs/identity/authorization),
[Workflow overview](/en/docs/automation/workflow-overview), and
[PDF and templates](/en/docs/platform/pdf-and-templates) for shared contracts
Grids adopts.

## Automate Grids from the terminal

The CLI supports record comments and incoming references, the evidence export
lifecycle, and platform-admin inspection and replay of retained delivery
failures. These commands use the same permissions as their UI counterparts.
Comment and reference lists return bounded pages with continuation cursors;
evidence creation and event replay return request state rather than promising
that background processing has completed.

Published-App readers use `cld grids apps runtime read <app-id>` to discover
available pages, data, forms and action IDs without Base access. The runtime
commands support bounded record reads, form submission, editable record fields,
comments, attachments, stored document downloads, actions, scanners and scoped
run status. They retain the published App's permission and availability checks.

Custom App authors can fetch `grids apps reference --json` for the generated
input `definitionSchema`, including every option, enum, default and limit.
Run `apps validate` for additional query, resource and permission checks.
In-App Help's **Custom App API reference** explains the same contract for people.
Forms may opt into `mode: edit` on a matching Record page, with versioned,
all-or-nothing parent and related-row edits. Shared relation targets stay links,
not inline editors. Base writers use `forms submit --record <id>`; App readers
use `apps runtime read` and `submit`. Stable Form idempotency keys protect exact
retries; unkeyed creates do not. Finalization and mutation policies still apply.

Published-runtime HTTP list controls use `_search`, `_cursor`, and `_limit` so
they cannot overwrite a page's Record parameters. CLI flags remain `--search`,
`--cursor`, and `--limit`; Base APIs retain their existing query parameters.

Capabilities remain a curated daily-task surface: discover templates, read or
issue immutable documents, discover configured correction/cancellation Draft actions, execute
one at its expected revision, and follow its run status. Issuance and workflow
actions require an idempotency key and individual approval. They do not expose
workflow authoring or arbitrary workflow source.

For structured table queries, `sort` orders Records. Grouped results use
`groupBy.direction` and `groupSort` instead, on both stored and federated tables.
Aggregate labels are display text and do not need to be valid GQL aliases.

Grids provides a native CLI module for every major resource area. These
read-oriented commands list bases and records from a chosen table:

```bash
cld grids list --json
cld grids records list --base "Operations" --table "Requests" --limit 20 --json
```

Record updates patch only the named fields. Integrations can pass the current positive Record version with `--if-version` so a stale projection conflicts instead of overwriting a newer edit. An update whose normalized scalar and Relation values are already current returns the Record without creating another version, history revision, audit entry, or live event.

For repeated connector projections, use `cld grids records upsert-external`. The provider, provider account, resource kind, and external ID form a case-sensitive durable binding to one Record; they do not replace its public Grids ID or become editable fields. Reuse one `--idempotency-key` after an uncertain response. Creating the binding needs no version, while a later update needs the current `--if-version`; a different request under the same key or a stale version conflicts without another write. The response is an immutable receipt containing the public Record ID and the version produced by that request; read the Record separately when current values are needed. Retry receipts are retained for 30 days, while the external identity binding remains durable.

Use `cld grids records upsert-external-batch` when up to 100 such projections
should share one request. Items run sequentially and commit independently, each
with its own `idempotencyKey`; the ordered response reports success, replay,
no-op, or a bounded error for every attempted item. Retry the same complete
batch after an uncertain or interrupted response: committed items replay and
unfinished items continue. Use `records import` instead only when new Records
must be created all-or-nothing in one transaction; that import is not an
idempotent external-identity projection.

To resume a connector after a short interruption, first scan the current
Records it owns, then save the opaque cursor returned by `cld grids records
changes`. The feed reports committed Record identities, event types, versions,
and deletion times for the last 30 days; it does not return field values or
replace a current Record read. Every page rechecks Base Read access, and an
optional `--table` narrows the feed without creating a separate permission
boundary. If a cursor has expired, perform a new full scan instead of guessing
which changes were missed. Use `--all --max-events N` for a bounded catch-up.

Run `cld grids help` for bases, schema, records, views, forms, Custom Apps,
documents, templates, and workflows. Run `cld grids <area> <command> --help`
before changing schema, data, access, or automation.

Document automation is available through `documents renderers|list|list-by-template|browse|by-record|generate|get|download|download-artifact`. Template-generated Documents bind a template and Record; workflow Documents can instead use a captured GQL result containing multiple records or aggregates. Both use the same immutable Document and artifact API. Workflow Documents expose a `dataSnapshot` summary with row count and capture time, not the captured rows. Output can be PDF, CSV, JSON, XML or a supported financial profile. Template generation requires Base Write and an explicit stable idempotency key; reads and artifact downloads require Base Read. Public resource arguments use six-character IDs, never internal UUIDs. Base- and table-scoped evidence packages include the covered Documents and their exact artifacts.

## Deployment requirements

Grids creates its current schema at startup and preserves data on subsequent
starts. Older Grids schemas require an explicit destructive reset, including
Grids-owned shared data. Follow the [operator reset procedure](/en/docs/reference/deprecations-and-migrations#grids-starts-with-a-fresh-schema)
before switching an existing installation. Start Core before Grids.

Record events are committed in PostgreSQL before background publication.
Workflow dispatch failures retry up to 20 times and remain in PostgreSQL for
inspection. Delayed retries return to the queue behind other work, so a broken
workflow does not block its partition throughout the retry period. Transport
failures have a separate Sync dead-letter queue.

Platform admins can open **Grids** in the administration area and select a
Base's failed record events to inspect the error and retry count. After fixing
the cause, replay a stopped event explicitly. Workflow replay retains its
failure history; replaying an outbox failure resets its publication attempts
and removes that failure entry. Upgrading does not replay historical failures
automatically.

See [Deployment requirements](/en/docs/operations/deployment-requirements) for
this app’s startup prerequisites, optional integrations, configuration and
functional checks.

## Configure workflow capacity

In **Grids administration** (`/admin/grids`), open **Settings** and set
**Concurrent workflow runs** (`grids.workflow_concurrency`, default **10**).
The value must be a positive whole number. Save it, then restart every Grids
instance to apply it.

Executions and dry runs share this limit per process. Additional runs wait in
the durable queue; steps within a run keep their declared order. More slots
allow independent runs to progress together, but do not make an individual PDF
render faster. Budget capacity across replicas and the shared database and PDF
renderer before increasing the limit. Workflow effects use a separate database
pool with up to ten connections per process, in addition to the normal and GQL
query pools. This keeps open effect transactions from blocking the reference
reads they need to finish. The pool drains when the workflow runtime stops.

## Configure query capacity

In **Grids administration** (`/admin/grids`), configure the query limits per
Grids process. Save them, then restart every Grids instance so the fleet uses
the same settings. These values are no longer environment variables.

| Setting | Default | Meaning |
| --- | --- | --- |
| `grids.query_pool_size` | 12 | Maximum connections in the query pool; at least 1. |
| `grids.query_concurrency` | 0 | Active queries; 0 follows the pool size. Larger values are limited to the pool size. |
| `grids.query_queue_limit` | 64 | Waiting queries; 0 rejects queries when all active slots are occupied. |
| `grids.query_queue_timeout_ms` | 1000 | Maximum admission wait in milliseconds; at least 1. |

Values must be whole numbers. Budget database connections across all replicas,
including each process's other database connections.

## Document source records

Workflow Documents can belong to multiple records, regardless of output format.
The association is captured at issuance, not recalculated from current data.
Simple single-table row queries supply the association automatically. Joined or
grouped outputs need `generateDocument.associatedData`, a reference to a separate
frozen single-table row query. Relations do not add members automatically.

Base record panels show associated Documents. The Document's source inspector
lists captured record versions; `sourceRecordCount` counts distinct records,
whereas `dataSnapshot.rowCount` counts output rows. A null source count means
membership is unknown, not zero. `GET /documents/:documentId/sources` returns
`items` and `hasMore`, with `offset` and `limit` pagination (default 50, maximum
100). Access requires permission to read the complete Document, not just one
member record. Custom App template-scoped document access is not broadened.

Base GQL supports `documentCount(format?)` and `latestDocumentAt(format?)` in
row projections and formula filters. Formats are `pdf`, `csv`, `json`, `xml`,
`sepa-xml`, and `datev-csv`. Metadata stays live after record finalization and
is unavailable in stored Formula fields and Custom App queries. An issued
SEPA export is not evidence that a transfer was executed.

For example, `where documentCount('sepa-xml') = 0` selects records without an
associated SEPA export. Do not wrap `where` expressions in `formula(...)`.
Generic `csv`/`xml` exclude financial profiles; `pdf` includes e-invoice PDFs.
