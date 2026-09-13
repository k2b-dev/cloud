# Grids CLI

Grids stores structured operational data in bases made of tables, fields, records, views, forms, Grids Apps, documents, and workflows. Use `cld grids` to inspect and change the Grids resources available to the signed-in user through the same permission-checked HTTP API used by the app.

## Contents

- [Core model](#core-model)
- [Agent workflow](#agent-workflow)
- [Resolve resources and pass input](#resolve-resources-and-pass-input)
- [Build schema and records](#build-schema-and-records)
- [Publish Combined tables](#publish-combined-tables)
- [Query data with GQL](#query-data-with-gql)
- [Create views and forms](#create-views-and-forms)
- [Publish a Grids App](#publish-a-grids-app)
- [Generate documents](#generate-documents)
- [Verify evidence packages](#verify-evidence-packages)
- [Manage access](#manage-access)
- [Build and operate workflows](#build-and-operate-workflows)
- [Command index](#command-index)

## Core model

- A **base** is the complete raw data and access boundary. Base Read sees every record in the Base. `cld grids use <base>` stores a default base for later commands.
- A **table** owns fields and records. A stored table owns writable records; a Combined table publishes a read-only canonical schema over
  explicitly mapped stored tables. Tables, fields, and other named resources expose one 6-character public `id` and a name.
- A **field** defines storage, validation, and presentation for one record value. Record write payloads use field public IDs as keys.
- A **record** is a versioned row. Relations store target record public IDs. Computed and system fields are read-only.
- A **view** is a saved GQL query plus display settings. Views can be shared or personal.
- A **form** writes records through a configured set of fields. A table also has a virtual default form.
- A **Grids App** is an independently shared, Base-owned published capability surface. Its readers do not need raw Base access, and it may be public.
- A **document template** selects GQL data and one renderer: HTML/PDF or an installed structured renderer such as E-Invoice. Every generated document is immutable and keeps its source snapshot and exact artifacts.
- A **workflow** is validated YAML with inputs, optional triggers, and steps. Launchers adapt workflows to scanner, bulk, Record, and Grids App
  interactions. Grids contributes the actions and the events; the runs themselves live in Cloud's shared workflow kernel, so
  `cld grids workflow-runs` reads one base while `cld admin workflows` reads every app.

Permissions are enforced by the backend on every command. Raw Grids commands require the owning Base permission. Only Base and Grids Apps have Cloud access grants; listing or resolving either resource does not grant access to it.

## Shared base navigation

After building the resources, organize useful task-based shortcuts for the team. Navigation groups mix tables, views (including joined views), forms, document templates, workflows, and Apps. They do not grant access or move/delete resources. Only base admins manage this configuration; this is not a daily-task capability.

Read the current revision with `cld grids bases navigation get --base <base> --json`. Replace the ordered configuration with `cld grids bases navigation set --base <base> --body-file navigation.json` (or `--body` / `--stdin`). The body is `{ "revision": 0, "groups": [{ "id": "GROUP1", "name": "Invoices", "entries": [{ "type": "view", "id": "VIEW01" }] }] }`: use the returned revision and real resource public IDs. Group IDs are unique six-character alphanumeric IDs scoped to the base. Entry types are `table`, `view`, `form`, `documentTemplate`, `workflow`, and `customApp`. Names are required (up to 200 characters); the group configuration is limited to 64 KiB. References may repeat across groups, not within one group.

Array order controls display order. Rename, reorder, remove, or clear groups through the same replacement command. On HTTP 409, read the latest configuration and reconcile deliberately; do not blindly retry with a newer revision. Unknown or foreign-base targets are rejected; existing unavailable shortcuts can be retained or removed. Ordinary readers only receive visible groups and links in the workspace. Custom App workspace links retain the existing base-admin boundary; publishing an App does not grant raw workspace access.

In the GUI, **New** in Edit mode groups permitted creation actions. Table-based actions ask for a table; creating a View opens the query editor. **Documents** always expands to **All documents** and template destinations. Workflow email templates are managed under **Settings → Email templates**; CLI commands are unchanged.

The base landing page is **Overview**, with **Groups** and **All resources** tabs (`?tab=groups` or `?tab=resources`). It defaults to groups when present, otherwise all resources. The selected tab survives reload and browser history. Base admins edit shared groups in **Settings → Navigation**. Without visible groups, the sidebar retains its other open resource lists. With groups, complete resource-type lists are expandable. Expansion is browser-local cookie state, not part of the shared configuration.

## Agent workflow

The in-app Assistant has a separate built-in `cloud-grids` Skill. It routes product
and administration questions through `search_help` / `read_help`, rather than
duplicating this reference or all in-app Help. Query with AI opens a restricted
chat that can discover schema, preview/execute GQL and save a View after approval
and the existing Base-admin check. It cannot change records or schema. That
restriction does not limit a separately authorized CLI agent using this Skill.

Capability results may include optional table presentation metadata referencing
their existing `data`. Programmatic consumers can ignore it; exact values,
pagination and semantic links remain canonical. Editor links carry URL-encoded
GQL and its source; very long queries may not have a link.

For an inventory, CRM, invoicing, expense or merchandise-management application, first read [Build a business application](grids-build-apps.md). It connects model choices, permissions, atomic transitions, templates and scenario-specific acceptance checks. This reference supplies the individual commands.

Work from discovery to mutation, then read the result back.

1. Confirm that Grids is installed and discover accessible bases:

   ```bash
   cld apps list --search grids --json
   cld grids list --json
   cld grids use Bookshop
   cld grids current --json
   ```

2. Inspect the live schema before constructing payloads:

   ```bash
   cld grids tables list --json
   cld grids fields list Authors --json
   cld grids records shape Authors --json
   ```

3. Read current data before updating it. Keep the returned public ID and `version` when the next write depends on current state:

   ```bash
   cld grids records list Authors --limit 100 --json
   cld grids records get Authors <record-id> --json
   ```

4. Validate languages and templates before saving them:

   ```bash
   cld grids gql compile-view --query-file authors.gql --json
   cld grids formulas check Authors --expression-file score.formula --json
   cld grids workflows validate --source-file workflow.yml --json
   ```

5. Write with file input for JSON, YAML, GQL, HTML, or other multiline content. Read the created resource back with `--json`.

6. Pass `--yes` only after the user has explicitly requested a destructive operation. Delete commands are soft-delete operations where a matching restore command exists.

## Resolve resources and pass input

### Base selection

Most base-scoped commands accept a leading base argument or `--base <ref>`. Once `cld grids use <base>` sets a default, omit the base where the command has enough remaining arguments to be unambiguous.

```bash
cld grids tables list Bookshop --json
cld grids tables list --base Bookshop --json
cld grids use Bookshop
cld grids tables list --json
```

### Inspect document membership and export history

`documents sources <document-id> --limit 50 --offset 0` returns the frozen record associations of an authorized Document. `documents by-record` includes multi-record workflow outputs. `sourceRecordCount` counts distinct associated Records, while `dataSnapshot.rowCount` counts captured result rows. Null source count means membership is unknown; it is not zero. References open current Records; `version` identifies the captured version.

For `generateDocument` with `data`/`output`, optional `associatedData: selection` names a saved, single-table row-query result. Use it when a joined/aggregate output should appear at specific Records. Default membership is inferred only from unambiguous row origins; Document and Record snapshot sources preserve their known associations. Relations do not propagate membership. `associatedData` is not a freshness check: financial `sourceVersions` retains its separate approval/version contract.

The sources list uses stable public-ID ordering and current readable labels.
An unavailable captured version is `null`, never version zero. Inherited sources
with conflicting versions have unknown membership; use a separate row-query
selection for explicit `associatedData` in that case. Evidence exports contain
only source `tableId`, `recordId`, and captured `version`, without live names or
deletion state, and allow at most 10,000 document-source entries per package.

GQL row queries support `documentCount(format?)` and `latestDocumentAt(format?)` in SELECT (with an alias) and WHERE. Formats are `pdf`, `csv`, `json`, `xml`, `sepa-xml`, `datev-csv`; omission includes all outputs. One Document with several artifacts counts once. No matches yields count zero and date null. These are live metadata, not stored Formula fields; they do not change finalized business values. Custom App queries cannot access these Base-level metadata.

```sql
from table Auslagen
select Auslagennummer, documentCount('sepa-xml') as Exports,
  latestDocumentAt('sepa-xml') as LastExport
where documentCount('sepa-xml') = 0
```

Use stable business identities and export targets for duplicate protection. A read-time count cannot replace atomic export claims, and a generated file is not evidence of a completed bank transfer.

Example: associate one summary file with the selected expense records:

```yaml
steps:
  - query:
      source: from table Expenses select Description, Amount
      saveAs: selection
  - query:
      source: from table Expenses aggregate sum(Amount) as Total
      saveAs: summary
  - generateDocument:
      data: summary
      associatedData: selection
      output: { kind: csv }
      saveAs: export
```

`associatedData` is an explicit association chosen by the workflow author. It
does not prove that separately captured summary rows contain exactly those
records or the same amounts. Keep both selections consistent; for financial
exports retain the existing confirmation, business-identity and freshness checks.

A base reference can be an exact name or 6-character public ID. Table, field, view, form, Grids App, document-template, workflow, and launcher commands resolve the same two forms inside their parent scope. Prefer public IDs from JSON output in unattended automation.

### Structured input

Commands with JSON bodies accept `--body <json>`, `--body-file <path>`, or `--stdin`. Specialized inputs follow the same pattern, for example `--query-file`, `--source-file`, `--inputs-file`, and `--expression-file`.

```bash
cld grids records create Authors --body-file record.json --json
cat records.json | cld grids records import --table Authors --stdin --json
cld grids workflows create --name "Check in" --source-file workflow.yml --enabled --json
```

Use `--json` whenever another command or agent will consume the result. Normal text output is for human inspection and may omit nested fields.

### Time and locale

CLI requests use the Cloud instance's `app.timezone` for date grouping, relative date filters, generated date sequences, and document
dates. Browser requests may use the user's timezone cookie instead. Workflow schedules use the IANA timezone declared in their YAML and
default to UTC. Server-rendered number and date output uses the resolved request locale; Grids App `valueFormat` controls
numeric style and precision, not locale or query values.

## Build schema and records

### Bases and tables

```bash
cld grids templates list --json
cld grids templates instantiate inventory --name "Equipment" --use --json
cld grids bases create Bookshop --description "Books and loans" --use --json
cld grids tables create --name Authors --description "People who wrote books" --json
cld grids tables get Authors --json
cld grids tables mutation-policy Authors --json
```

Built-in templates create complete example bases with schema, views, Grids Apps, documents, workflows, and optional sample records. Sample
records are included by default; pass `--empty` to keep the complete configuration without those records. Commands are
`templates list|instantiate`.

Base commands are `list`, `use`, `current`, and `bases list|get|create|update|delete|restore|trash|retention|preservation-holds|destruction`. Table commands are `tables list|get|create|update|delete|restore|mutation-policy|mutation-policy impact|mutation-policy set|history|history enable|finalization|finalization enable|finalization disable|finalization policy`.

A Base Admin can configure a technical minimum age for trashed Records. Read and preview it before changing it:

```bash
cld grids bases retention Bookshop --json
cld grids bases retention preview Bookshop --days 30 --json
cld grids bases retention records list Bookshop --days 30 --search Cases --status all --page 1 --per-page 25 --json
cld grids bases retention files list Bookshop --days 30 --search invoice --status all --page 1 --per-page 25 --json
cld grids bases retention files download Bookshop HeUB3M --out ./retained-file.bin
cld grids bases retention set Bookshop --days 30 --json
```

The preview is bounded and uses one stated observation time. It reports both trashed Records and newly unreferenced Files, including retained byte totals and bounded examples. `bases retention records list` exposes the complete current Trash set through server-side search, floor-status filtering, and pagination; finalized Records are labelled as independently protected. Use the normal table Trash view for restore or other Record actions. `bases retention files list` exposes the complete current candidate set through the same bounded pattern; `download` accepts only a File public ID returned by that list. All routes require Base Admin permission. Current attachments and Files protected by Durable History or Documents are not unreferenced candidates. Reaching the floor does not delete a Record or File or state that destruction is appropriate. Shortening an existing floor requires `--yes`; removing it always requires `bases retention remove <base> --yes`. Existing Bases have no floor by default.

A Base Admin can also block future controlled destruction for the complete Base or one active Table with one or more explicit preservation holds:

```bash
cld grids bases preservation-holds list Bookshop --status active --json
cld grids bases preservation-holds list Bookshop --status active --search "Annual review" --page 2 --per-page 25 --json
cld grids bases preservation-holds create Bookshop --reason "Annual review" --json
cld grids bases preservation-holds create Bookshop --scope table --table Authors --reason "Authorship dispute" --json
cld grids bases preservation-holds list Bookshop --scope table --table Authors --status active --json
cld grids bases preservation-holds release Bookshop HOLD01 --reason "Review completed" --yes --json
```

Create defaults to `--scope base`; `--scope table` requires `--table` with a Table public ID or exact name. An exact name resolves an active Table; its six-character public ID can still filter hold history after the Table is no longer active. A Base hold covers every Table. A Table hold covers only that Table and blocks destruction of its parent Base so the hold cannot be bypassed. Creating and releasing require a non-empty reason. Releasing one hold leaves every other active hold in force. Holds do not lock Records, change access or Finalization, expire automatically, start cleanup, or establish legal compliance. `list` supports `active`, `released`, and `all` status filters, `base`, `table`, and `all` scope filters, optional exact Table filtering, and server-side pagination. Every command requires Base Admin permission and uses the same backend hold owner as future controlled destruction.

A Base Admin can irreversibly destroy one bounded batch of eligible unreferenced File bytes. Preview before starting the run:

```bash
cld grids bases destruction preview Bookshop --json
cld grids bases destruction run Bookshop --confirm "Bookshop" --json
cld grids bases destruction status Bookshop RUN001 --json
cld grids bases destruction cancel Bookshop RUN001 --yes --json
```

`preview` returns at most 100 exact eligible File candidates and reports totals for Files that are eligible, still retained, held, or unknown/protected. `run` fetches a fresh preview, requires the exact Base name through `--confirm`, and queues only those public File IDs. It refuses an empty batch. Before deleting each File, the server rechecks the active retention floor, current and protected references, saved origin Table, and Base/Table preservation holds. A changed File is skipped, so a run can complete as `partial`. `cancel --yes` stops only remaining work; already destroyed bytes cannot be recovered. Records, trashed Records, Documents, evidence exports, and Durable History are never included. Every command requires Base Admin permission.

Stored tables allow every record change source by default. Before tightening that setting, preview the active Forms, Actions, and Workflows that would stop changing the table, then apply the same policy:

```bash
cld grids tables mutation-policy impact Authors --allow direct,form --json
cld grids tables mutation-policy set Authors --allow direct,form --json
```

The impact preview is bounded. If a table is used by more Workflows than it can inspect in one request, the result says that additional entry points may be affected.

The source names are `direct`, `form`, and `workflow`; `direct` includes editing in the Base or a Grids App, Record Editor, API, CLI, and imports. Use `--allow all` for normal Grids behavior. `--allow none --yes` freezes creates, edits, trash, restore, Relations, and Files while leaving existing records readable. Permissions, field rules, audit requirements, history, and finalization still apply, and another client cannot bypass this server-side setting.

Pass `--kind stored` for a normal table or `--kind federated` for a user-facing Combined table. Stored is the default.

`bases restore`, `tables restore`, and the other restore commands require the deleted resource public ID rather than a name lookup. Base
admins can discover deleted table, field, and form public IDs with `cld grids bases trash <base> --json`. A deleted table owns its
deleted fields and forms, so those nested resources are restored with the table rather than duplicated in the trash response.

### Field types

Never guess a field config or record encoding. Read the live catalog first:

```bash
cld grids fields types --json
cld grids fields type relation --json
cld grids fields type select --json
```

The shipped field types are:

- Writable values: `boolean`, `date`, `duration`, `json`, `longtext`, `number`, `percent`, `principal`, `select`, `text`.
- Writable links: `relation`.
- Read-only computed values: `formula`, `lookup`, `rollup`, `html_template`.
- Read-only system or generated values: `created_at`, `created_by`, `id`, `updated_at`, `updated_by`.
- External file storage: `file`; use `records files` commands instead of record JSON.

Important encodings:

- `number` stores a canonical decimal string, although writes accept strings or numbers.
- `select` stores an array of option ids, including single-select fields.
- `relation` stores target record public IDs. A single relation can be written as one public ID string; multiple relations use an array.
- `principal` always stores an array of typed Cloud references such as `[{"type":"user","id":"..."},{"type":"group","id":"..."}]`, even when its cardinality is `single`. Writes are revalidated against the current actor's identity-discovery scope.
- `date` uses `YYYY-MM-DD` unless `includeTime` is enabled; date-time values must include a timezone.
- `duration` accepts seconds, `MM:SS`, or `HH:MM:SS` and stores integer seconds.
- `id`, formula, lookup, rollup, HTML template, and timestamp fields must not be sent in record writes.

`html_template` renders Liquid and CSS per record. Inspect `fields type html_template --json` for its configuration. Use stable public field IDs in `record.data`, and preview before using `raw`. HTML fields are stored-table output only: no filtering, sorting, grouping, aggregation, formula use, relation lookup, or recursive HTML templates. Default exports omit them; explicit HTML exports require a query limit of at most 1,000 records. One read renders at most 2,000 HTML cells and 32 MB total. A Rendered HTML App block displays one such field in a non-interactive sandbox; immutable downloadable output belongs in Documents.

Record reads can include `fieldErrors`, keyed by public Field ID, when a stored object list no longer validates. The original
list remains in `data` for repair, not as validated calculation input. Correct the indicated fields before creating a Document
snapshot; snapshots reject invalid source fields instead of freezing their errors as data.

Create a field only after inspecting its type:

```bash
cld grids fields create Authors \
  --name Email \
  --type text \
  --config '{"regex":"^[^@]+@[^@]+$"}' \
  --json
```

Field commands are `fields types|type|list|get|create|update|delete|restore|dependents|reorder`. Run `fields dependents` before deleting a field referenced by formulas, relations, views, or other configuration.

### Record payloads and versions

`records shape` returns writable field public IDs, types, and example values for one table. Create and update bodies are plain objects keyed by those public IDs.

```bash
cld grids records shape Authors --json
cld grids records create Authors --body '{"<field-id>":"Octavia Butler"}' --json
cld grids records update Authors <record-id> \
  --if-version 3 \
  --body-file record-update.json \
  --json
```

For a Combined table, `records shape` returns no writable fields. Query or export its canonical fields; record creation, imports, forms,
file uploads, edits, deletes, and restores are unavailable.

Use `--if-version` for optimistic concurrency when updating a previously read record. `records import` accepts an array or `{ "items": [...] }` and creates the batch in one transaction.

### Typed rows inside a record

Use `object_list` for a bounded list owned by one record, such as invoice positions. Use a related table instead when rows need independent permissions, links, or lifecycle. Inspect `fields type object_list --json` and `records shape <table> --json` before writing.

- Each column has a stable six-character `id`, a `name`, a scalar `type`, optional `config`, and `required`. Supported scalar types are `text`, `longtext`, `number`, `boolean`, `date`, `select`, `percent`, and `duration`; their usual validation applies. Nested lists, relations, and arbitrary JSON columns are not supported.
- A record value is an array of objects keyed by column IDs, not names: `{"Items1":[{"Label1":"Consulting","Amount":"42.50"}]}`. Send exact amounts as decimal strings. The field and column IDs in this example must be replaced with IDs from the actual schema.
- A write replaces the entire list atomically. Omit the record field to leave it unchanged on update; send `[]` to clear it when its `required`/`minItems` constraints allow that. Use the record version for concurrent edits.
- Workflows assign a YAML sequence to the list field in `createRecord.values` or `updateRecord.set`. Quote exact decimal amounts and omit calculated cells. The same validation runs at execution; use `atomicRecords` with its locks and checks when several record changes must succeed or roll back together.
- A column with `formula: {"expression":"Amount * 2"}` is read-only. Its expression uses sibling columns. Omit calculated columns when creating, importing, or updating rows; do not send a read response back unchanged. `records shape` excludes them from its example, while retaining the full configuration for discovery.
- Selection columns are inputs only. Regex constraints apply to text inputs, not calculated text. Field creation/update checks SQL compatibility of row calculations and rejects unsupported expressions before saving.
- Record formulas can aggregate a numeric column with `LIST_SUM(Items, 'Amount')`, `LIST_AVG`, `LIST_MIN`, or `LIST_MAX`; `LIST_COUNT(Items)` counts rows. Empty lists sum/count to zero; other aggregates return null. A missing list returns null.
- GQL formulas can reference a joined list through its table alias: `formula(LIST_SUM(customer.Items, 'Amount'))`. This sums one record's list; `sum(formula(LIST_SUM(customer.Items, 'Amount')))` aggregates those totals across query rows. A join that repeats a record also repeats its total; choose the query's row scope accordingly.
- While a record is a draft, calculated cells follow the formula. Finalization freezes the list and its calculated values together, preserving their scalar types. Subsequent formula changes must not rewrite finalized values.

The list config accepts `minItems` (default 0) and `maxItems` (default 100). Limits are 1,000 rows, 200 columns, and 256 KiB per value. Examples show structure, not a guarantee that they satisfy custom constraints such as a text pattern; inspect the actual configuration before submitting. Removing a column hides it in draft reads without rewriting stored history. A column containing finalized values cannot be removed. New writes still reject unknown columns; submit only the current writable columns.

For connector projections, `records upsert-external` binds the exact provider, provider account, resource kind, and external ID to one Record. Reuse its idempotency key only for an uncertain retry, and pass the current version for an existing binding. `records upsert-external-batch` accepts `{ "items": [...] }` with at most 100 independently committed items. Each item carries its own `idempotencyKey`, `externalRef`, `values`, optional `ifVersion`, and optional `audit`. The ordered response keeps per-item successes and errors. Retry an unchanged interrupted batch safely; completed items replay. Use `records import` only for an atomic all-create batch.

```bash
cld grids records upsert-external-batch Authors \
  --body-file external-records.json \
  --jsonl
```

For resumable connector sync, save the opaque cursor returned by `records changes`. The feed reports committed public Record identities,
event types, versions, and deletion times from the last 30 days; read each current Record separately for its field values. `--table` narrows
the Base feed, while `--all --max-events` bounds catch-up work. If a cursor has expired, perform a fresh full Record scan and start again from
the new feed position.

```bash
cld grids records changes Operations --table Requests --limit 100 --json
cld grids records changes Operations --table Requests --cursor <cursor> --all --max-events 1000 --jsonl
```

Read and transfer records with:

```bash
cld grids records list Authors --q Butler --limit 100 --json
cld grids records list Authors --finalization awaiting-review --json
cld grids records export Authors --format csv --out authors.csv
cld grids records audit Authors <record-id> --json
```

Durable history is an irreversible opt-in for a stored table. Inspect the current status first, then enable it explicitly. The enable command
continues the initial baseline in bounded server-side batches until every existing record has been captured.

```bash
cld grids tables history Authors --json
cld grids tables history enable Authors --yes --json
cld grids tables finalization Authors --json
cld grids tables finalization enable Authors --mode direct --yes --json
cld grids tables finalization enable Authors --mode four-eyes --approver-group <group-uuid> --yes --json
cld grids records finalize Authors <record-id> --yes --json
cld grids records finalization request Authors <record-id> --comment "Ready for review" --json
cld grids records finalization approve Authors <record-id> --request <request-id> --yes --json
cld grids records finalization reject Authors <record-id> --request <request-id> --comment "Missing review" --yes --json
cld grids records versions Authors <record-id> --limit 20 --json
cld grids records versions download Authors <record-id> <revision-id> <file-id> --out historical-file.bin
```

`records versions` returns append-only states captured after opt-in, including the baseline and exact retained file metadata. The download
command reads bytes only through the selected record version. This feature increases storage use, cannot be disabled, and does not by itself
provide legal or regulatory compliance.

Finalization captures typed formula, lookup, rollup and object-list results. New fields added after finalization and older finalized records without captures have no historical calculated result; Grids does not fill that gap with current formulas. Missing results are not zero. Do not use incomplete totals for financial exports. Four-eyes requests bind all live field definitions, including names, because approval covers the record's meaning; after a schema change, submit a new request.

`records audit` shows one stored or Combined record's history. `records audit list` browses the published lifecycle history across an
entire Combined table and accepts record, source, action, time-range, cursor, and limit filters. Combined audit entries expose only
canonical included fields, declared audit answers such as required deletion comments, and safe source labels.

Record commands are `records changes|shape|list|query|get|create|upsert-external|upsert-external-batch|import|export|update|finalize|finalization request|finalization approve|finalization reject|delete|restore|audit|audit list|versions|versions download`.

### Files and snapshots

Use exact Table and Record public IDs for discussion and incoming relations. No default Base is needed; the server checks the owning Base permissions. List responses retain `nextCursor` and comment permissions, including in `--jsonl` (one complete page per line).

```bash
cld grids records comments list <table-id> <record-id> --limit 20 --json
cld grids records comments create <table-id> <record-id> --body-file comment.md --json
cld grids records comments update <table-id> <record-id> <comment-id> --body-file comment.md --json
cld grids records comments delete <table-id> <record-id> <comment-id> --yes
cld grids records referenced-by <table-id> <record-id> --limit 5 --json
```

Use `--cursor` to continue either list. `referenced-by --relation-field <field-id>` narrows the incoming relation field. Comment writes retain the server's Base Write, author, and moderation requirements.

File fields use dedicated blob commands:

```bash
cld grids records files upload Assets <record-id> Photo --file image.png --json
cld grids records files list Assets <record-id> Photo --json
cld grids records files download Assets <record-id> Photo <file-id> --out image.png
cld grids records files replace Assets <record-id> Photo <file-id> --file replacement.png --json
cld grids records files delete Assets <record-id> Photo <file-id> --yes
```

Manual recursive record snapshots use `snapshots list|create|get`:

```bash
cld grids snapshots create Assets <record-id> --json
cld grids snapshots list Assets <record-id> --json
```

## Publish Combined tables

Object-list mappings require identical source and target column definitions, including IDs, scalar configurations and calculations. Combined tables do not remap individual list columns. List-level minimum/maximum row settings do not change the source-owned rows.

Finalized source values stay frozen, including mapped formula results. The Combined table's own formulas still calculate over those values; source finalization does not freeze the reporting schema.

A Combined table exposes one canonical, read-only table over stored source tables from one or more bases. Readers need permission only on
the Combined target. They do not gain source-base navigation, raw source schema, non-published field history, or mutation rights. Queries,
saved views, Grids Apps, documents, workflow reads, exports, and the canonical Combined audit trail use normal Grids behavior.

Publication is fail-closed. Revocation, source deletion, or incompatible schema drift makes the complete published revision unavailable;
Grids does not return a silently smaller partial union. One Combined table supports at most 50 stored sources and 200 canonical fields.
Combined tables cannot source other Combined tables.

### Create the target and canonical schema

Create the table with the contract value `federated`, then add the fields readers should query:

```bash
cld grids tables create Reporting \
  --name "All inventory" \
  --kind federated \
  --json

cld grids fields create Reporting "All inventory" \
  --name Name \
  --type text \
  --json
```

Use `tables get` to inspect the table itself. Use `tables combined get` to inspect its draft and published revisions.

### Discover and map sources

Candidates include only stored tables whose base the current actor may administer:

```bash
cld grids tables combined candidates Reporting "All inventory" --json
```

The friendly JSON body resolves base, table, and field exact names or public IDs. Select-option mappings run from source option to
canonical target option.

```json
{
  "sources": [
    {
      "base": "Warehouse East",
      "table": "Items",
      "mappings": [
        { "target": "Name", "source": "Title" },
        {
          "target": "Status",
          "source": "State",
          "options": { "In stock": "Available" }
        }
      ]
    }
  ]
}
```

Validate without saving, save the complete replacement draft, inspect it, and publish:

```bash
cld grids tables combined validate Reporting "All inventory" \
  --body-file combined.json \
  --json

cld grids tables combined draft Reporting "All inventory" \
  --body-file combined.json \
  --json

cld grids tables combined get Reporting "All inventory" --json
cld grids tables combined publish Reporting "All inventory" --json
```

`validate` returns `{ "valid": boolean, "diagnostics": [...] }`. `draft` and `publish` return one permission-shaped revision view;
`get` returns `{ "current": revision|null, "draft": revision }`. A source entry contains its position, authorization time, revocation time,
and a nullable `sourceTableId`. The source table ID and its mappings are shown only when the actor also administers that source base.
Publication listings expose the target base and table by public ID, but do not expose an internal publication-entry ID.

Raw draft input contains only the complete visible source-table list and its mappings:

```json
{
  "sourceTableIds": ["<visible-source-table-id>"],
  "mappings": [
    {
      "targetFieldId": "<canonical-field-id>",
      "sourceTableId": "<visible-source-table-id>",
      "sourceFieldId": "<source-field-id>",
      "config": {}
    }
  ]
}
```

Do not add source-entry IDs or retention fields. Sources the target admin cannot inspect are retained automatically by the server and stay
opaque. Publishing always requires admin access to the target base. Source-base admin access is required only for scope that is new,
broadened, or being restored after revocation. Narrowing or removing an existing visible mapping does not reauthorize it. The grant persists
if the original authorizer later loses their role.

### Read, inspect, revoke, and repair

GQL uses no special Combined syntax:

```gql
from table "All inventory"
where Status = 'Available'
sort Name asc
```

```bash
cld grids gql run Reporting --query-file available-inventory.gql --json
cld grids records export Reporting "All inventory" --format csv --out inventory.csv
cld grids records audit list Reporting "All inventory" --action deleted --json
```

A source-base admin can inspect every Combined target and exact mapped scope that publishes one stored table. The target public ID in this
response is required for revocation:

```bash
cld grids tables combined publications "Warehouse East" Items --json

cld grids tables combined revoke "Warehouse East" Items \
  --target-table <combined-table-id> \
  --yes
```

Revocation immediately makes that target revision unavailable. To repair mappings or drift, update the JSON body, run `validate`, save it
with `draft`, and run `publish` again. Restoring revoked source scope requires an admin of that source base. Delete the target through the
normal confirmed table lifecycle:

```bash
cld grids tables delete Reporting "All inventory" --yes
```

## Query data with GQL

`gql run` and `gql preview` accept `--parameters '<json>'`, `--parameters-file <path>` or `--parameters-stdin`. Supply a name-to-value map, for example `{"minimum":{"decimal":"123.45"}}`, and reference it as `@params.minimum`. Preview/execute API bodies and capabilities use the same `parameters` object. Values may be strings, finite numbers, booleans, null, exact `{decimal: "..."}` values or flat lists of those values. Names start with a lowercase letter and contain only lowercase letters, digits and underscores. Limits: 100 names, 10,000 list entries, and 20,000 characters for serialized parameter JSON. Unsafe integer numbers and NUL strings are rejected; use exact decimals instead of unsafe numbers. Parameters cannot provide `@auth`, `@page` or other trusted context. Changed values invalidate pagination cursors. Capabilities omit editor links when parameters are supplied: the editor URL does not carry runtime values. Parameterized workflow starters save input bindings, not their preview values.

GQL is a line-oriented query language compiled and executed by Grids. The static language contract is documented below. These commands return the same contract in machine-readable form plus the visible schema of one base:

```bash
cld grids gql reference
cld grids gql context --out context.md
cld grids gql skill --out SKILL.md
```

`gql context` is permission-safe and base-specific. It contains only schema the current user may discover. Use it together with the downloaded skill when another agent must author GQL.

### GQL language reference

Write clauses in this order. Only `from` is required outside a table- or view-scoped editor:

```text
from table <source> [as alias] | from view <source> [as alias]
[join table <table> as alias on <relation> = alias.id]
[left join table <table> as alias on <relation> = alias.id]
[select <field> [as alias], formula(<expression>) as alias, ...]
[where <boolean expression>]
[search '<text>' [in <field>, ...]]
[group by <field> [by day|week|month|quarter|year], ...]
[aggregate <function>(<field>|*|formula(<expression>)) as alias, ...]
[having <boolean expression>]
[sort <field-or-alias> [asc|desc] [nulls first|nulls last], ...]
[limit 1..10000]
[offset 0..10000]
[include deleted | deleted only]
```

`from`, `where`, `search`, `having`, `limit`, `offset`, and the deleted mode are singleton clauses. Use comma-separated lists for fields,
groups, aggregates, and sorts. Multiple joins are allowed. Line breaks are optional; semicolons separate clauses and `--` starts a comment
when preceded by whitespace.

Not every saved query can be reused with `from view`. Sources containing relation joins, cross-field comparisons, or offsets are rejected
instead of silently losing their scope. Execute that saved query directly, or query its table and carry over every required clause explicitly.
Do not recover from an unavailable View by querying its entire table without the original filters.

Names without punctuation may be bare. Double-quote names containing spaces or punctuation and escape an embedded double quote by doubling
it. Text literals use single quotes. Stable fields and sources use `{public-id}`. Do not use removed `#field` aliases. An `as` alias starts with a
letter or underscore, continues with letters, digits, or underscores, is at most 64 characters, and cannot be a GQL keyword, logical operator,
or reserved literal. Aliases are case-insensitive when referenced later. Sort defaults to ascending order with missing values last.

Joins follow Grids relations only: the left side must be a relation field that targets the joined alias's `.id`. `join` removes source rows
without a target; `left join` keeps them. Arbitrary join predicates, subqueries, common table expressions, window functions, and unrestricted
expressions are not GQL.

Conditions use `=`, `!=`, `<`, `<=`, `>`, `>=`, `and`, `or`, `not`, and parentheses. Direct predicate compatibility is:

- text, long text, ID: `=`, `!=`, `contains`, `startswith`, `endswith`, `icontains`, `istartswith`, `iendswith`;
- number, percent, duration, date: all six comparison operators;
- boolean: equality with `true` or `false`, inequality, or the field by itself;
- select: `=`, `!=`, `oneof`, `noneof`, `containsall` with option label or id values;
- relation: `=`, `!=`, `oneof`, `noneof`, `containsall` with record public-ID values.
- principal: `=`, `!=`, `oneof`, `noneof`, `containsall` with user or group UUID values.

`field = null` means empty and `field != null` means not empty. Other comparisons with `null` are invalid. A true/false formula may compare
fields and calculated expressions. Use operators in GQL conditions, not function-style `AND(...)`, `OR(...)`, or `NOT(...)`.

Grids App GQL receives typed request context automatically:

- `@auth.id`: current account UUID or `null` for anonymous visitors;
- `@auth.name`: current account display name or `null`;
- `@auth.username`: current account username or `null`;
- `@auth.email`: current account email address or `null`;
- `@auth.subjects`: current user UUID plus effective direct and nested group UUIDs, or `[]` for anonymous visitors; valid only inside `oneof`, `noneof`, or `containsall`;
- `@params.<name>`: one declared and validated page parameter;
- `@page.id`, `@page.title`, `@page.url`;
- `@app.id`, `@app.name`;
- `@base.id`, `@base.name`;
- `@time.now`, `@time.today`, `@time.timeZone`.

Use `@auth.id != null` for authenticated-only data and `@auth.id = null` for anonymous data. Unknown namespaces and undeclared parameters fail compilation. Context values are bound separately from query text; Grids App GQL has no `inputs` map or `param()` helper. Grids App Markdown may insert the same names as safe text placeholders, such as `Hello @auth.name`; it does not support Liquid control flow or executable templates.

Record metadata filters are `record.id`, `record.createdBy`, `record.updatedBy`, `record.deletedBy`, and `record.finalizationState`; they accept
`=` or `oneof(...)` and may be combined only with `and`. Record IDs are public IDs, user values are UUIDs, and Finalization values are `draft`,
`awaitingReview`, or `finalized`. `awaitingReview` means a current Four-eyes request, not that the current caller may approve it. Metadata sorts are
`record.createdAt`, `record.updatedAt`, and `record.deletedAt`. The `records list --finalization` shortcut accepts `draft`, `awaiting-review`, or
`finalized` and composes with the other list filters.

Aggregates are:

- `count(*)` for all matching records; `*` is valid only here;
- `count(field)`, `countEmpty(field)`, and `countUnique(field)` for any readable field or formula;
- `sum(field)`, `avg(field)`, and `median(field)` for numeric fields or formulas;
- `min(field)` and `max(field)` for number, date, date-time, or text fields or formulas;
- `earliest(field)` and `latest(field)` for date or date-time fields or formulas.

Every aggregate and formula output requires `as alias`. Use `aggregate sum(formula(Quantity * Price)) as revenue` for a calculated input.
With `group by`, every sorted source field must also be grouped; aggregate aliases may be sorted. Without `group by`, aggregates produce one
summary row and cannot be combined with record-field selections or sorting. `where` filters records before grouping and `having` filters the
summary rows afterward.

A visible Combined table uses the same `from table ...` syntax as a stored table. Its canonical fields are the complete exposed schema;
do not infer physical source tables, fields, or permissions from the downloaded context.

```gql
from table Authors
select Name, "Birth year"
sort "Birth year" desc
limit 100
```

Run or validate queries with:

```bash
cld grids gql preview --query-file authors.gql --limit 100 --json
cld grids gql run --query-file authors.gql --page-size 500 --json
cld grids gql run --query-file authors.gql --all --max-rows 1000 --json
cld grids gql compile-view --query-file authors.gql --json
```

`gql preview` caps `--limit` at 500. `gql run` has no `--limit`: it reads one page with `--page-size` (1–1000, default 100) and `--cursor`,
or follows cursors with `--all` up to `--max-rows` (1–10,000, default 10,000). `--max-rows` without `--all` is an error. Both execute with
current permissions. `gql compile-view` canonicalizes valid source and returns diagnostics with a nonzero exit status for invalid source.
`gql autocomplete` accepts a UTF-16 `--caret` offset and returns permission-safe completion items.

Use exact source and field names when unambiguous, quote names containing spaces, and use `{public-id}` references where renames must not break saved automation.

Formula fields, GQL predicates, computed columns, and parts of document and workflow authoring share the formula engine:

```bash
cld grids formulas reference
cld grids formulas check Authors --expression 'LEN(Name)' --json
```

### Formula language reference

Numeric results may be JSON numbers or decimal strings. JavaScript evaluation retains a decimal string when conversion to a number would lose digits, including intermediate results of literal-only formulas. Treat these strings as numbers using decimal arithmetic, not `Number(...)`, when calculating further. `number` columns inside object lists always use decimal strings; a configured `decimalPlaces` preserves that scale. Non-finite math results are formula errors, not the text `NaN` or `Infinity`.

Finite addition, subtraction, multiplication, remainder, and sums use operand-sized precision within the supported numeric range. `MEDIAN` also keeps exact numeric values in SQL; it does not convert amounts to floating point to select the middle values.

Division and averages use PostgreSQL numeric precision in both preview and SQL, after removing insignificant trailing zeroes from operands. Non-terminating results are rounded half away from zero at the selected scale (0–1,000 fractional digits, based on operand magnitudes and fractional digits). This is finite decimal arithmetic, not exact rational arithmetic. For a monetary result, explicitly use `ROUND(expression, 2)` or the currency's required scale; setting a column's decimal places validates the result rather than rounding it for you.

Expressions are bounded to 20,000 characters, 64 nesting levels and 1,024 AST nodes across JS and SQL parsing. Caller-specific limits still apply (for example, 5,000 characters for a computed column and 20,000 for the whole GQL query). Reduce expression complexity when validation reports a limit; do not retry unchanged input.

`ROUND` truncates fractional places toward zero. Places must be between −131,072 and 16,383, matching PostgreSQL numeric's supported digit range. Outside that range, evaluation returns a formula error that `IFERROR` can handle; it does not clamp or wrap the argument.

Field references are `Name`, `"Birth year"`, or `{field-id}`. Literals are single-quoted text, numbers, `true`, `false`, and `null`.
Inside text, `\\'`, `\\\\`, `\\n`, `\\r`, and `\\t` escape a quote, backslash, or control character. Parentheses group expressions and
a leading `=` is optional. Function names are case-insensitive.

Operators bind from strongest to weakest: unary `-`, `not`, `!`; then `*`, `/`, `%`; then `+`, `-`; then `<`, `<=`, `>`, `>=`; then
`=`, `!=`; then `and`/`&&`; then `or`/`||`. Arithmetic and ordered comparisons with an empty operand return empty. Two empty values are
equal. `null`, `false`, `0`, and empty text are false in conditions. Division and remainder by zero produce a formula error. `IF`, `IFEMPTY`,
`IFERROR`, `AND`, and `OR` evaluate only the branches or arguments needed for the result.

The complete function catalog is:

```text
SUM(value, ...)                 AVG(value, ...)                  MEAN(value, ...)
COUNT(value, ...)               MIN(value, ...)                  MAX(value, ...)
MEDIAN(value, ...)
LIST_SUM(list, column)          LIST_AVG(list, column)           LIST_COUNT(list)
LIST_MIN(list, column)          LIST_MAX(list, column)
ABS(number)                     ROUND(number, digits?)           FLOOR(number)
CEIL(number)                    SQRT(number)                     POW(base, exponent)
MOD(a, b)                       PERCENT(part, total)
IF(condition, then, else)       IFEMPTY(value, fallback)         IFERROR(value, fallback)
AND(value, ...)                 OR(value, ...)                   NOT(value)
ISBLANK(value)
CONTAINS(text, search)          STARTSWITH(text, prefix)         ENDSWITH(text, suffix)
ICONTAINS(text, search)         ISTARTSWITH(text, prefix)        IENDSWITH(text, suffix)
CONCAT(value, ...)              LEN(text)                        LOWER(text)
UPPER(text)                     TRIM(text)                       LEFT(text, n)
RIGHT(text, n)                  SUBSTRING(text, start, length)   REPLACE(text, search, replacement)
TODAY()                         NOW()                            YEAR(date)
MONTH(date)                     DAY(date)                        DATEADD(date, count, unit?)
DATEDIFF(from, to, unit?)
```

`SUM`, `AVG`/`MEAN`, `MIN`, `MAX`, and `MEDIAN` use numeric arguments and return empty when none are numeric. `COUNT` counts values other
than empty or empty text. `ABS`, `FLOOR`, `CEIL`, `SQRT`, `POW`, `MOD`, and `PERCENT` perform their named numeric operation. Numeric functions
require numeric values; an invalid operation such as a negative square root or zero divisor produces an error.
`SQRT` uses the same decimal rounding in previews and queries; trailing input zeroes do not change its precision.
Unhandled calculation errors abort GQL and workflow captures with `BAD_INPUT`, rather than becoming nulls that aggregates omit. `IFERROR` can explicitly supply a replacement; valid empty values remain empty. Query cancellation and resource failures still abort the query.
For whole-number `POW` exponents from −2,147,483,648 through 2,147,483,647, all integer result digits are retained. The fractional part rounds half away from zero to the larger of 16 places or the base's significant fractional places, capped at 1,000. Other exponents use 80 significant digits, capped at 1,000 fractional places, in both formula evaluation and SQL. Trailing input zeroes do not change this scale. Use explicit `ROUND` for monetary amounts.

`IF` chooses one branch. `IFEMPTY` handles empty or empty text, `IFERROR` handles formula errors, `ISBLANK` tests empty or empty text, and
`AND`, `OR`, and `NOT` use formula truthiness. `CONTAINS`, `STARTSWITH`, and `ENDSWITH` are case-sensitive; their `I...` forms ignore case.
`CONCAT` joins values, `LEN` counts text characters, `LOWER`/`UPPER` change case, `TRIM` removes surrounding whitespace, `LEFT`/`RIGHT`
take characters from an edge, and `REPLACE` replaces every match.

`SUM` through `MEDIAN` combine arguments from the current record; GQL `aggregate` summarizes multiple records. `ROUND` defaults to zero
decimal places and accepts negative places. `SUBSTRING` uses a zero-based start. Date-time calendar operations use the request's display
timezone; without one, Grids uses the Cloud application timezone. Date-only values remain calendar dates. `DATEADD` accepts day(s), hour(s),
minute(s), month(s), and year(s), defaulting to days. `DATEDIFF` accepts day(s), hour(s), minute(s), and second(s), defaults to days, and
returns `to - from`, rounded down to whole units.

The GQL command set is `gql reference|run|preview|compile-view|autocomplete|skill|context`. Formula commands are `formulas reference|check`.

## Create views and forms

### Views

Views save GQL source and presentation settings for one table.

```json
{
  "name": "Recent authors",
  "source": "from table Authors\nlimit 100",
  "shared": true
}
```

```bash
cld grids views create Authors --body-file recent-authors-view.json --json
cld grids views list Authors --json
```

Commands are `views list|get|create|update|delete|restore`. Create accepts `--shared`; update accepts `--shared` or `--personal`.

### Forms

Form configuration uses field public IDs. Inspect `fields list` and `records shape` first.

```bash
cld grids forms create Orders \
  --name Checkout \
  --config '{"fields":[{"kind":"user_input","fieldId":"<field-id>"}]}' \
  --json
cld grids forms submit Orders Checkout --body-file submission.json --json
```

Commands are `forms list|default|get|create|update|delete|restore|submit`. `--public` creates or retains a public submit token; `--private` removes it. Public form links allow form submission, not unrestricted table access.

### Form submission contract

Create accepts field values directly or `{data,inlineCreates?,idempotencyKey?}`. Prefer the envelope with a stable key for retryable operations. Each `inlineCreates` key is a relation Field ID and its value is `[{tempId,data}]`; include those temporary IDs in the root relation values. Only configured `inlineCreate.fields` are writable. Parent and children commit together.

To edit an existing parent with its lines, use `forms submit BASE TABLE FORM --record REC001 --body-file edit.json --yes`. Read the parent and children with `records get` first. The body is `{data,version,idempotencyKey,inlineCreates?,inlineUpdates?}`. `inlineUpdates` is keyed by relation Field ID with `[{recordId,version,data}]`; retain edited child IDs in the root relation value. These are full Form values, not an arbitrary record patch: preserve required inputs and use explicit empty values to clear fields. Up to 20 creates/updates per relation and 50 total are accepted. Children must already belong to this parent, stay linked, belong to the same Base and not be shared with another parent. Removing a relation detaches rather than deletes its child. Finalization and mutation policy checks remain active.

Published App Forms opt into editing with `mode: edit` on a Record page for the same table. `apps runtime read` returns `blocks[].form.initialRecord` with `version`, `values`, and `inlineCreates` drafts carrying `existing:{id,version}`. Replace those draft temp IDs in `data` with `existing.id` and send existing edits in `inlineUpdates`, not `inlineCreates`. Submit through the same discovered page/block and parameters; the server derives the target from the page, not a body Record ID. Sidebar and standalone public Forms remain create-only.

Keys are nonblank strings up to 200 characters without NUL. Preserve the exact key and complete body after a timeout. A replay returns the original Record ID without another write; changed payloads, deleted results and stale versions conflict (`409`). An unkeyed create can duplicate. After a confirmed stale-version conflict, read current values and review them before a new logical attempt. A new key is not a safe remedy for an uncertain outcome.

## Publish a Grids App

`apps reference --json` includes **`definitionSchema` generated from the installed input schema** and `validation` for cross-field rules. Inspect the relevant union branch before writing a block: `required` lists required input, while optional properties may have `default`. Do not confuse compiled publication capabilities with authoring input. The complete human reference is `/app/grids/help/grids-custom-app-api` (English and German); use the available in-app Help reader for explanations. The HTTP machine reference is `GET /api/grids/apps/reference`.

For quick orientation, every block accepts `id`, `type`, optional `title` and `availableWhen:{query}`. Additional options are:

| Block | Required besides id/type | Optional (defaults where defined) |
| --- | --- | --- |
| `markdown` | `markdown` | none |
| `records` | `source`, `display` | `emptyText`, `searchable:true`, `pageSize:25`, `rowNavigate`, `rowActions` |
| `referenced_records` | `sourceTableId`, `relationFieldId`, `fieldIds`, `display` | `emptyText`, `searchable:true`, `pageSize:25`, `rowActions` |
| `metrics` | `source` | none |
| `chart` | `source`, `chartType:donut\|bar\|line` | `subtitle`, `limit:100`, `valueFormat`, `xAxisLabel`, `yAxisLabel` |
| `record` | `fieldIds` | `emptyText`, `editableFieldIds:[]`, `documents:{templateIds:[…]}` |
| `html` | `fieldId` | `height:normal` (`compact\|normal\|large`) |
| `comments` | none | none |
| `form` | `formId` | `mode:create` (`create\|edit`), `fixedValues:{}`, `onSuccessNavigate` |
| `actions` | `actions` | none |
| `scanner` | `launcherId` | none |

Read nested shapes, enum values and limits in `definitionSchema`; always run the compiler because JSON Schema cannot express permission checks, same-table rules, unique IDs, compatible navigation and query result shapes. Local IDs start with a lowercase letter and contain lowercase letters/digits/hyphens (up to 80); parameter names use underscores. Resource IDs are six case-sensitive letters/digits. `startPageId` must name a parameter-free page. A Record page has exactly its matching Record parameter, hidden navigation and at least one Record or HTML block. Column spans total at most 12. Omit optional values instead of sending null. Form success navigation replaces history; only normal/row navigation supports `history:push|replace`.

Grids Apps are strict schema-v5 YAML definitions owned by one base. The current contract supports up to 12 pages containing responsive rows and
columns plus Markdown, Records, Referenced records, Metrics, Chart, Record, Rendered HTML, Form, Comments, Actions, and Scanner blocks. Records and insight blocks can use a saved view
or GQL. A Records block can navigate its row id or one selected single relation into one required
record parameter on a detail page. Record and Comments blocks use that page record; Record renders only its explicit field allowlist.
For signed-in readers, an editable displayed File field exposes App-scoped attachment controls without granting raw Base API access. File validation and limits remain owned by the field and file service. A published Comments block lets signed-in App readers comment without Base access; authors manage their own comments and Base administrators moderate. Form blocks submit existing Grids forms and may carry trusted typed `LITERAL`, `PARAMS`,
or page `RECORD` values. Records blocks may declare up to six workflow `rowActions`; compatible record inputs can receive `ROW.id`, and
the runtime rechecks the selected id against the exact published query result. Run the live reference before authoring a definition:

Saved-view Records blocks can use `display: { kind: table, columnIds: [...] }` or `display: { kind: cards }`. Cards reuse and pin the saved View's existing Cards fields and file cover. Row navigation is optional, and Cards reuse the same bounded workflow `rowActions` as tables. GQL Records blocks are table-only. Use an empty `columnIds` list to display the query's selected ordinary-record columns, including aliases; a nonempty list narrows the displayed columns without removing selected fields needed for block behavior. Use Metrics or Chart for aggregate output. Set `searchable: true` for parameterized PostgreSQL search over displayed fields and choose `pageSize` from 5 to 100. Cursor pagination stays server-side for both saved Views and GQL; use a GQL `limit` only to cap the complete result intentionally.

On a Record page, `referenced_records` pins one source table, one Relation field targeting the page record table, the exact displayed `fieldIds`, table or Cards display, search, page size, and optional row actions. The server derives and compiles the bounded GQL membership query from the page record parameter; do not add a second query or client-side reverse lookup.

Pages, blocks, Forms, and actions may use one `availableWhen.query`. At least one returned row means available. An empty result, invalid query, missing context, timeout, or cancellation means unavailable. The server rechecks Forms and actions before execution.

For dynamic responsibility, join the owning table and use `oneof(cost.Responsible, @auth.subjects)` on its Principal field. Joined `oneof`, `noneof`, and `containsall` keep the direct field's typed membership rules. On stored tables, `Receipts != null` requires a current attachment; `Receipts = null` checks for none. Combined-table file presence is unsupported. Keep these conditions server-side rather than copying group assignments onto requests.

The optional root `sidebar.actions` list adds ordered app-global Form launchers to the AppWorkspace navigation. Fixed values accept `LITERAL` and `AUTH.currentUser` for Principal inputs. They never inherit `PARAMS`, page `RECORD`, or `ROW`. Global availability receives only `@auth.*`, `@app.*`, `@base.*`, and `@time.*`. Form launchers can serve public app readers in a large dialog, while `AUTH.currentUser` requires sign-in. Visible pages follow their array order and may set `navigation.icon`; the runtime hides the whole sidebar when it would contain neither another page nor a Form action.

```bash
cld grids apps reference
cld grids apps create Bookshop --name "Request overview" --json
cld grids apps validate Bookshop --source-file app.yaml
cld grids apps plan Bookshop --source-file app.yaml
cld grids apps apply Bookshop --source-file app.yaml --json
```

The definition chooses a stable 6-character public `id`, and the original file remains safe to
apply again. `apply` changes the draft only. Grant explicit read access to the app, then publish the current validated draft:

```bash
cld grids access grant app Bookshop "Request overview" --group "Request team" --permission read
cld grids access grant app Bookshop "Public catalog" --public --permission read
cld grids apps publish Bookshop "Request overview" --yes
```

The standalone app is available to authenticated or public readers at `/apps/<id>`; named pages use `/apps/<id>/<pageId>` and record parameters
stay in the query string. Readers need only the Grids App grant; the immutable publication capability supplies its declared data and operations without granting raw Base access. Applying a later draft does not affect the published snapshot until the next publish. Commands are
`apps reference|list|create|get|validate|plan|apply|export|publish|unpublish|restore|delete`; `export --out <path>` writes normalized deterministic YAML and `export --published` selects the live definition.
`restore --yes` replaces the draft with the live definition. `unpublish --yes` removes only the live snapshot, while `delete --yes` removes the app and its route.

For context-aware query suggestions, select an existing draft and page. The CLI then sends the same fixed and declared page keys as the visual editor; raw `gql run` and `gql preview` still do not bind App context:

```bash
cld grids gql autocomplete Bookshop \
  --app "Request overview" \
  --page request \
  --query 'where @' \
  --caret 7 \
  --json
```

## Generate documents

Document templates combine table-scoped GQL with one renderer: Liquid HTML/CSS for a PDF, or an installed E-Invoice renderer whose Liquid input renders one JSON object. Read the runtime reference before creating one:

```bash
cld grids document-templates reference
cld grids document-templates create Invoices --body-file invoice-template.json --json
cld grids document-templates preview-draft-pdf Invoices \
  --body-file invoice-template.json \
  --record <record-id> \
  --out preview.pdf
```

Template commands are:

- `document-templates reference|list|get|create|update|delete`
- `document-templates preview-data|preview-pdf`
- `document-templates preview-draft-data|preview-draft-pdf`

Saved-template previews use the stored template. Draft previews accept unsaved source and one `renderer` object. Use `kind: "html"` with body and optional page parts, or `kind: "profile"` with an installed renderer id, version, and `inputTemplate`. Passing a saved template uses it as defaults before applying draft overrides.

Generate and manage immutable document output from a selected record:

```bash
cld grids documents generate Invoices Invoice \
  --record <record-id> \
  --idempotency-key invoice-<record-id>-v1 \
  --tag issued \
  --out invoice.pdf
cld grids documents by-record Invoices <record-id> --json
```

Document commands are `documents renderers|list|list-by-template|browse|by-record|generate|get|download|download-artifact`. `documents list` is the Base-wide immutable catalog. Every generation requires an explicit idempotency key; reuse it after an uncertain response to receive the same Document. An E-Invoice renderer owns its number and artifact filenames. `documents browse --mode folders --path 2026/07` traverses one template's generated Documents by year and month. Search matches filenames, numbers, or tags; tag filters are repeatable.

A record-template Document appears in its record detail, template workspace, and **All documents**. Workflow outputs use a frozen data source instead; their `tableId`, `recordId`, and `templateId` are null. `dataSnapshot` reports `rowCount` and `capturedAt` for these outputs and is null for record-template Documents. It never contains source rows. `documents get` and lists return the same Document shape, including all stored artifacts. `primaryArtifactKey` identifies the main file in `artifacts`; use its `mimeType`, not the key or filename, to determine the format. Download that file with `documents download`, or choose an exact artifact:

```bash
cld grids documents get <document-id> --json
cld grids documents download <document-id> --out invoice.pdf
cld grids documents download-artifact <document-id> structured --out factur-x.xml
```

List the installed renderers before creating an E-Invoice template:

```bash
cld grids documents renderers --json
```

Each renderer declares `primaryArtifact: { key, mediaType }`. Public share links
are available only for a primary PDF; other formats require authorized downloads.
Profile renderers own filenames, so `document.filename` is `null` while building
their input. Read the completed Document's `filename` after generation.

The installed `de.zugferd.en16931@1` renderer accepts outgoing German EUR invoices with German seller and buyer addresses, standard VAT rates, bank transfer, and exact string decimals. It emits both the hybrid PDF/A-3b and `factur-x.xml`, validates the XML against the pinned XSD, then verifies the embedded XML. Use four decimal places for quantities and unit prices and two for tax rates. Version 1 excludes corrections, replacements, tax exemptions, allowances, charges, prepayments, discounts, foreign currencies, incoming invoices, and filings. These technical checks are not tax or legal approval. The invoice issuer is responsible for the content and for checking whether this renderer fits the intended use. Do not interpret a valid report as a compliance certificate.

Renderer `de.zugferd.en16931@2` retains the version 1 fields and additionally requires `serviceDate` (`YYYY-MM-DD`) and one strict `billing` object:

- `{ "kind": "invoice" }` — commercial invoice (380).
- `{ "kind": "creditNote", "original": { "number": "RE-42", "invoiceDate": "2026-08-01" }, "reason": "Returned goods" }` — credit note (381), with a preceding invoice reference.
- `{ "kind": "selfBilling", "agreementReference": "Agreement-42" }` — self-billed invoice (389), for example a commission settlement. Seller stays the supplier, buyer stays the customer issuing it. This is not a payout record.

Use positive quantities and nonnegative prices in all three cases. The document kind carries the credit direction. Supply the intended receiving account explicitly. Version 2 rejects identical seller/buyer VAT IDs and a referenced invoice date later than the credit note. Other version 1 scope limits still apply. Existing templates and retries remain on their selected version.

The renderer checks document shape, not original-document existence, remaining credit balances or duplicate commission settlement. Enforce those in the issuing workflow under concurrency before offering this as a billing application. A valid artifact does not prove those business checks passed.

Public document links are bearer links. Create only the lifetime the user needs and revoke them when no longer required:

```bash
cld grids documents links create <document-id> --expires-in 30d --comment "Customer copy" --json
cld grids documents links list <document-id> --json
cld grids documents links revoke <link-id> --json
```

Supported lifetimes are `1d`, `7d`, `30d`, and `90d`; the default is `30d`.

## Verify evidence packages

Base administrators can manage exports before downloading them. Preflight and create accept an optional `--body-file scope.json` containing `tableId`, `from`, `to`, and `sections`. Omitted scope selects the whole Base and all sections. Run preflight to inspect available history and limits first.

```bash
cld grids evidence preflight --base Bookshop --body-file scope.json --json
cld grids evidence create --base Bookshop --body-file scope.json --yes --json
cld grids evidence list --base Bookshop --json
cld grids evidence get <export-id> --json
cld grids evidence retry <export-id> --yes --json
cld grids evidence cancel <export-id> --yes --json
cld grids evidence download <export-id> --out package.tar
```

Creation queues work; cancellation may be a request rather than immediate completion. Read the returned status. Retry is available for failed or canceled exports; download requires a completed, retained package.

`evidence verify` checks a downloaded Grids evidence TAR locally. It does not
contact Cloud, require a profile, extract files, or upload package contents.
Captured query entries also carry `sourceSha256` and `sourceHashVersion: 2`: recursively sorted UTF-16 keys and JavaScript JSON serialization without Unicode normalization. These source hashes are distinct from the archive-file hashes checked by `evidence verify`.

Document metadata uses `hash_version: 2` for `template_revision` and `snapshot_sha256`, with the same canonicalization. Old alpha hashes are not supported or rewritten. If startup reports `Unsupported Grids alpha`, stop and involve the operator: preserve the old installation and its workflow sources before deciding whether to archive or explicitly discard incompatible state. Do not change hashes, version markers or journals to make old data pass validation.
Pass the hashes shown beside the completed export when they are available:

```bash
cld grids evidence verify package.tar \
  --sha256 <package-sha256> \
  --manifest-sha256 <manifest-sha256>
cld grids evidence verify package.tar --json
```

The command checks the TAR shape, package and manifest hashes, every declared
entry, and unexpected or duplicate paths. It returns a non-zero exit code when
verification fails. The result reports the declared scope and available
history; it does not claim compliance, authorship, custody, or legal validity.

## Manage access

Grids grants access to one complete raw Base or one published Grids App. Tables, Views, Forms, document templates, and Workflows have no separate Cloud grants.

```bash
cld grids access reference
cld grids access search-principals ada --json
cld grids access list base Bookshop --json
cld grids access set base Bookshop \
  --user ada@example.test \
  --permission write \
  --json
cld grids access grant app Bookshop "Public catalog" --public --permission read
```

Supported resource references are:

- `base <base>`: `read`, `write`, `admin`, or `none`; applies to the complete raw Base and every record.
- `app <base> <app>`: `read` or `none`; supports users, groups, authenticated, and public principals. Delegated credentials act as their user.

Choose exactly one principal with `--user`, `--group`, `--service-account`, `--authenticated`, or `--public`. `--service-account` is accepted only for a Base; `--public` is accepted only for a Grids App. Existing Grids App service-account entries can be inspected with `access list --include-service-accounts` and removed with `access revoke --access-id <id> --yes`, but they do not authorize app runtime. `access grant` creates a direct grant. `access set` updates or creates it. `access revoke` requires `--yes` and either a principal or `--access-id`.

## Build and operate workflows

Workflow YAML stores `inputs`, optional `triggers`, and `steps`; name and description are normal workflow fields outside YAML. The complete static contract is documented below. This command returns the same manifest as JSON for tools and editors:

```bash
cld grids workflows reference --json
```

The shipped inputs are `record`, `recordList`, `text`, `number`, `boolean`, `date`, `dateTime`, and `select`. Triggers are `schedule` and `recordEvent`. Actions are `query`, `closeRecord`, `createCorrectionDraft`, `finalizeRecord`, `updateRecord`, `createRecord`, `atomicRecords`, `generateDocument`, `createDocumentLink`, `sendEmail`, `httpRequest`, `setVariable`, `fail`, and `succeed`. Control flow supports `if/then/else`, `switch/cases/default`, and `forEach/as/do`.

`schedule` and `recordEvent` are the only triggers written in YAML. A direct invocation and a launcher press are API and CLI operations, not
YAML — but they are still events, and a workflow is always listening for them, so nothing has to be declared to make it invocable.
Disabling a workflow silences all four: a disabled workflow refuses `--mode execute` and still accepts `--mode dryRun`.

### Workflow YAML language reference

The root accepts only `inputs`, `triggers`, and `steps`. `steps` is required and non-empty; omit optional sections instead of writing an
empty `triggers: {}`. Unknown keys are errors. Each action step has exactly one action. Input names, `saveAs`, `setVariable.name`, and
`forEach.as` start with a letter or underscore and continue with letters, digits, or underscores. Names are case-sensitive and cannot reuse
another value or the reserved roots `inputs`, `trigger`, `bindings`, and `context`.

YAML maps cannot repeat a key. Indentation defines nesting. Quote values that must remain text but look like `true`, `false`, `null`, or a
number, and quote cron expressions.

Every input may set `label`, `description`, and `required`. Type-specific declarations and invocation values are:

| Type | Declaration | Invocation value |
| --- | --- | --- |
| `record` | required `table` exact name or public ID | one record public ID |
| `recordList` | required `table` exact name or public ID | ordered record public-ID list, at most 10,000 |
| `text` | none | string |
| `number` | none | finite number |
| `boolean` | none | `true` or `false` |
| `date` | none | `YYYY-MM-DD` |
| `dateTime` | none | ISO date-time |
| `select` | `options` with 1–200 strings | one configured option |

`triggers.schedule` accepts `cron`, optional `timezone` defaulting to `UTC`, and `with`. Cron has five numeric fields in the order
`minute hour day-of-month month day-of-week`; it supports `*`, comma lists, ranges, and `/step`, but not names such as `MON` or `JAN`.
Ranges are minute 0–59, hour 0–23, day 1–31, month 1–12, and weekday 0–7 with 0 and 7 as Sunday. `timezone` is an IANA name. Schedule
bindings can read `${{ trigger.occurredAt }}` and `${{ trigger.slot }}`.

`triggers.recordEvent` requires `event: created|updated|deleted|commented`, and may set `table`, `filter`, and `with`. Bindings can read
`${{ trigger.record }}`, `${{ trigger.event }}`, and `${{ trigger.occurredAt }}`. Every required workflow input must be bound. A filter leaf
uses `fieldId`, `op`, `value`, and optional `caseInsensitive`; combine leaves with `{ op: AND|OR, filters: [...] }`. Operators are:

- text: `equals`, `notEquals`, `contains`, `notContains`, `startsWith`, `endsWith`, `regex`, `isEmpty`, `isNotEmpty`;
- number: `=`, `!=`, `<`, `<=`, `>`, `>=`, `between`, `isEmpty`, `isNotEmpty`;
- date: `=`, `notEquals`, `before`, `after`, `onOrBefore`, `onOrAfter`, `between`, `today`, `thisWeek`, `thisMonth`, `lastNDays`, `isEmpty`, `isNotEmpty`;
- boolean: `=`, `isEmpty`, `isNotEmpty`;
- select: `is`, `isNot`, `isAnyOf`, `isNoneOf`, `isEmpty`, `isNotEmpty`;
- relation: `containsAny`, `notContainsAny`, `isEmpty`, `isNotEmpty`.

Action fields are:

| Action | Required | Optional and defaults | Saved output |
| --- | --- | --- | --- |
| `query` | Inline GQL `source` (up to 20,000 characters) | Typed `parameters`, `saveAs` | frozen query reference and metadata |
| `closeRecord` | `record` | `expectedMode`, `expectedPolicyRevision` | none |
| `createCorrectionDraft` | `original`, `typeField`, `typeValue`, `originalField` | `intent` (`correction` default), `copyFields` | created linked Draft |
| `finalizeRecord` | `record` | none | none |
| `updateRecord` | `record`, non-empty `set` | `audit` answers by question UUID | none |
| `createRecord` | `table`, non-empty `values` | `saveAs` | created record |
| `atomicRecords` | 1–100 `locks`, 1–50 `checks`, 1–50 `changes` | check `message`; update `ifVersion` and `audit` | none |
| `generateDocument` | `template` + `record`, or `data` + `output` | `filename`, up to 20 `tags`, `saveAs` | document |
| `createDocumentLink` | `document` | `expiresIn: 1d|7d|30d|90d` default `30d`, `comment`, `saveAs` | public link |
| `sendEmail` | `template`, `to` with 1–50 recipients | `data` with at most 200 keys, `saveAs` | email result |
| `httpRequest` | absolute HTTP(S) `url` | `method` default `POST`, up to 100 `headers`, `json`, `timeoutMs` default 15,000 and range 1,000–60,000, `saveAs` | response |
| `setVariable` | `name`, `value` | none | named value |
| `succeed` | `message` | none | terminates successfully |
| `fail` | `message` | none | terminates with failure |

`sendEmail.to` entries contain exactly one of `email` or `user`. HTTP methods are `GET`, `POST`, `PUT`, `PATCH`, and `DELETE`; requests
carry optional JSON only. Field, table, document-template, and email-template references accept an exact name or public ID.

`query.parameters` maps lowercase names (`[a-z][a-z0-9_]*`) to `{type, value}`. Types are `text`, `number`, `decimal`, `boolean`,
`date`, `dateTime`, `record`, and `recordList`. Decimal values are exact strings, not JSON numbers. Record values are workflow references,
not manually constructed IDs. Bind them as `@params.name` in GQL, never interpolate workflow expressions into `source`.
Use an explicit `from table` source; live View bindings are not supported.
In the workflow editor, `generateDocument.data` suggests prior query result names in the current scope. Reuse one name for multiple files; results declared inside a branch or loop stay inside it.

```yaml
inputs:
  selected:
    type: recordList
    table: Tasks
    required: true
steps:
  - query:
      source: |
        from table Tasks
        select Name
        where oneof(record.id, @params.selected)
      parameters:
        selected:
          type: recordList
          value: ${{ inputs.selected }}
      saveAs: report
```

An empty selection captures zero rows, not every record. Query execution rechecks current access and the published schema, then freezes
at most 10,000 rows and 5 MiB including metadata. Technical truncation fails; explicit GQL `limit` means an intentional subset.
All source captures also share a total 5 MiB budget per run, including loops. Reusing a stored capture does not charge it again. Reduce selected rows/fields or split larger work into separate runs. Every run records its cumulative capture bytes; startup rejects missing historical budgets instead of estimating them. For upgrades from unsupported alpha state, follow [Grids alpha upgrade](https://cloud.k2b.dev/en/docs/operations/grids-alpha-upgrade) before replacing the application.

Query bindings use semantic schema contract 3. They ignore column position and, without search, presentation flags and select-option additions. Search still pins option labels and presentation fields; calculation/type configuration remains checked. Old or missing binding versions are rejected. Review and publish the workflow source again, then start a new run; never edit a stored binding or hash to suppress a conflict.
Retries retain the successful capture. The saved reference exposes `rowCount`, `sha256`, and `capturedAt`, not row payloads.
Dry-runs validate without capturing data and accept records planned by earlier steps; they do not predict a result count.
Pass the saved query reference as `generateDocument.data`, without `template` or `record`:

```yaml
steps:
  - query:
      source: from table Items select Name
      saveAs: report
  - generateDocument:
      data: report
      output: { kind: csv }
      filename: tasks.csv
      saveAs: csvDocument
  - generateDocument:
      data: report
      output: { kind: json }
      saveAs: jsonDocument
```

Both steps use the same captured rows. Each creates one immutable Document; a retry of that step returns its existing Document.
Generation rechecks execution permission, Base write access and source-table access. Dry-runs validate but do not render files.
The Document belongs to the workflow, not a dummy Record; find it under **All Documents** or the workflow run.
Downloads use the stored primary artifact; public download links currently support PDF only.

Instead of a query reference, `data` accepts typed workflow values:
`{ columns: [{ key: amount, type: decimal }], rows: [{ amount: "${{ inputs.amount }}" }] }`.
Declare that amount input as `text` to preserve exact decimal digits. Columns have literal `key`, optional `label`
(defaults to key), and `type`: `text`, `decimal`, `boolean`, `date`, `dateTime`, or `json`.
Keys and labels must be unique. Each row must contain exactly those keys; all cells allow null, but not missing values.
Decimals are plain decimal strings (no exponent); dates are ISO dates and date-times include a timezone.
Rows accept existing typed workflow expressions, not Liquid. Capture is bounded to 10,000 rows and 5 MiB and reused on retry.
This source has no implied Record identity or GQL provenance. Financial exports still require explicit business IDs and confirmation.

For already issued Documents, select their saved data, not current Records:
`data: { documents: [DOC001], columns: [{ key: number, type: text, path: [number] }] }`.
`documents` is an ordered list of 1–10,000 unique public Document IDs from this Base, or a workflow expression producing that list.
Each Document contributes exactly one row. Column `path` is a literal array of property names rooted at `id`, `number`,
`createdAt`, `data` (stored render data), `profile` (stored profile input, nullable), or `output` (stored derived profile values, nullable).
For example, `[profile, amount]` reads a saved profile's `amount` property only if that profile actually has it.
German invoice profiles now store `output.currency`, `netAmount`, `taxAmount`, `grossAmount` and `taxGroups`
(each group has `taxRate`, `netAmount`, `taxAmount`). Amounts are exact two-place decimal strings calculated by
the same rounding rules as PDF/XML. Use `[output, grossAmount]` with `type: decimal`, not an independently
recalculated sum of live Records. Invoice corrections still carry positive amounts: derive booking direction from
the saved `profile.billing.kind`, not the sign of the total. Older Documents without these saved outputs fail the
path lookup; they are never silently regenerated. Arrays remain explicit JSON cells, not implicit booking rows.
Paths neither expand arrays nor query live Records. Missing Documents, paths or incompatible cell types fail the entire step.
All selected render/profile snapshots together must fit 5 MiB before loading; the projected capture has the same limit.
Use exact issued IDs for invoice exports; a later live invoice query is not equivalent to the issued snapshot.
After `generateDocument` with `saveAs: issued`, use `documents: ["${{ issued.shortId }}"]` to consume it in a later step.
Its result exposes `id` (internal identity), `shortId` (public identity), `number`, `filename` and `primaryArtifactKey`;
do not use `documentNumber`, `snapshotId` or `workflowRunId` as expression fields.
A dry-run accepts earlier planned Documents without looking up placeholder IDs. Their saved values can only be checked
during execution; the dry-run summary states this limitation. Existing source Documents are still checked.

For manual Record snapshots, use `snapshots` instead of `documents`:
`data: { snapshots: [SNP001], columns: [{ key: name, type: text, path: [root, data, FLD001] }] }`.
Use public snapshot IDs returned by `snapshots list|create|get` and public Field IDs in `root.data` paths.
The context is the public snapshot returned by `snapshots get`: `root` holds the historical Record,
and `[graph, records]` selects the related-record map as a `json` cell. Paths do not expand arrays or map entries.
Each selected snapshot contributes one row; IDs must be unique and belong to this Base. The same row and byte limits apply.
Current root access and existence are required. Related Records are redacted using the snapshot API's current access checks;
lost access never falls back to live values. Issuance rechecks the captured source-table permissions.
This is a manual Record snapshot, not an issued invoice: use `documents` when the issued Document is the authority.

For financial outputs, optional `sourceVersions: [{ tableId: TBL001, recordId: REC001, version: 3 }]`
pins explicitly selected live Records. This property belongs beside `data` and `output`, not inside either.
For a newly captured, single-source Record query, prefer `sourceVersions: data`: Grids derives the list from
the frozen row identities and versions, without accepting a caller-supplied list. Rows must be unique and retain
their Record identity. Multiple table dependencies, aggregates without row identity, empty results and older captures
without version metadata are rejected. Capture a new query or provide explicit versions for those cases.
Joins, including self-joins, are rejected. Only the selected root Records are protected: lookup or formula dependencies
are not recursively versioned, even if they refer to another Record in the same table. Guard those Records explicitly.
A dry-run checks the workflow but cannot promise which versions the later query will capture; it states that limitation.
The array can come from a workflow expression; provide 1–10,000 unique Record identities, public IDs,
and positive integer versions. All must belong to this Base and remain readable and undeleted.
Grids checks them when reserving the preview, reading/confirming it, and creating the file. The final check locks
those Records through issuance. Any version change conflicts; start a new export and review its data.
To protect approvals, first select only approved Records and pass the versions observed with that selection.
Derive the guard set in the authored workflow; do not let an untrusted caller omit approval Records or choose arbitrary versions.
Include child or approval Records separately when their changes matter: a header version does not cover its relations.
This is not automatic freshness detection for arbitrary joins or aggregates, nor proof that your approval filter is correct.
Omitting `sourceVersions` deliberately exports the frozen data despite later source changes. Completed exports retain
their original bytes and replay normally. The option is rejected for free formats and record-template generation.

`output.kind` supports:

- `csv`: ordered aliases as headers, UTF-8 and CRLF. `delimiter` accepts comma (default), semicolon, tab or pipe.
  For a tab separator, write `delimiter: "\t"` in YAML.
  Null becomes an empty cell. `nestedValues` is `reject` (default) or explicit `json`.
  `textProtection` is `spreadsheet` (default); dangerous text cells receive a leading apostrophe, reported in validation results.
  `raw` deliberately disables that protection. Exact numeric values are not rewritten.
  Optional `columns: [{ source: Amount, label: Total }, { source: Name }]` selects and orders exact GQL aliases and renames headings.
  Omit `label` to keep the alias. Unknown sources, repeated sources, empty selections and duplicate headings fail; internal `q_col_*` keys are not aliases.
- `json`: an array of row objects keyed by unique column aliases. Decimal strings, arrays, booleans and null retain their types.
  Optional `wrapper: { rowsKey: items, values: { approved: "${{ inputs.approved }}" } }` produces an object containing `items`
  and the additional typed `values`. `values` defaults to `{}` and cannot contain `rowsKey`; the row array is never stringified twice.
  `rowsKey` is a literal property name. Values use the existing workflow expression syntax and the combined output must fit 5 MiB.
- `pdf`: requires `body` (HTML/Liquid, at most 200,000 characters); optional `header`, `footer`, and `css` each allow 50,000.
  The template receives `rows`, ordered `columns` (`key`, `label`, `type`, `sqlType`), and `document.number`/`document.createdAt`.
  Read row values using the column's `key`, not its label. Iterate nested object-list values inside each row.
  There is no implicit `record`, live query, or relation expansion. Rendering uses the existing configured PDF service.

For example, a PDF body independent of field names is
`{% for row in rows %}{% for column in columns %}<p>{{ column.label }}: {{ row[column.key] }}</p>{% endfor %}{% endfor %}`.
Liquid values are escaped. Invalid syntax or unavailable root variables fail publication.
For XML, use `output: { kind: xml, body: '...' }` with the same data roots and a 200,000-character source limit.
The output is UTF-8 XML 1.0 with exactly one root. Place values only in text or quoted attribute values; names and namespace declarations
must be static. Loops, conditions and scalar assignments use Liquid. DTDs, CDATA, processing instructions (except a static XML declaration),
raw/capture/comment Liquid blocks and dynamic markup are rejected. XML comments must be static. Escaping preserves text and attribute
whitespace; a parser rejects malformed output, unknown entities, unbound namespaces and illegal characters. Rendered output uses the
shared 300,000-byte template limit. Free XML is not a SEPA or E-Invoice profile.

#### Review and create financial export files

The UI's **New workflow** offers invoice-accounting and reimbursement-payment starters. Both produce an ordinary disabled workflow for review; enable it only after checking fields, destination and dates. Invoice accounting takes one issued Document public ID as `document`, reads `output.grossAmount` and the saved Record's explicitly selected direction/account/counter-account fields. It does not recalculate invoice totals. Reimbursement payments take a `records` selection, reject unfinished finalization, capture finalized rows and set `sourceVersions: data`. The required unique reimbursement number supplies the stable business and payment identity. Dates are literal saved configuration: review them before each batch. These are editable starting points, not automatic accounting decisions.

Use the same `generateDocument` action with `data: report` and `output: { kind, version: 1, header, mapping }`.
`kind` is `datev-csv` (DATEV 700/13, EUR booking batch) or `sepa-xml` (SCT pain.001.001.09, DK GBIC 5, EUR).
These profiles require manual invocation and explicit preview confirmation; scheduled and record-event triggers are rejected.
They create files, not payments or imported bookings. Bank and accounting-system acceptance is not guaranteed.

`mapping` values are exact GQL aliases, never cell values or internal compiler keys. `header` accepts literal values and existing
workflow expressions such as `${{ inputs.executionDate }}`. The exception is `header.destinationKey`: choose a stable literal
identity for the target accounting ledger or payment account, never a run ID or date. Changing that identity bypasses the separation
between previously exported and new business events, so do not change it to retry an export.

| Profile | Required header fields | Required mapping aliases | Optional mapping aliases |
| --- | --- | --- | --- |
| DATEV | `destinationKey`, `consultantNumber`, `clientNumber`, `fiscalYearStart`, `accountLength`, `periodStart`, `periodEnd`, `label`, `finalize` | `businessId`, `entryId`, `amount`, `direction`, `account`, `counterAccount`, `documentDate`, `documentNumber` | `text`, `taxKey`, `costCenter1`, `costCenter2` |
| SEPA | `destinationKey`, `debtorName`, `debtorIban`, `executionDate`; optional `debtorBic` | `businessId`, `endToEndId`, `amount`, `creditorName`, `creditorIban`, `remittance` | `creditorBic` |

Use `cld grids workflows reference` for the current field descriptions and constraints before authoring YAML.
DATEV consultant/client numbers and account numbers are digit **strings**; `accountLength` is an integer from 4 to 8.
`finalize` is a required boolean controlling finalization on import, not Grids Record finalization. Dates are `YYYY-MM-DD`;
DATEV dates must fall in 2000–2099 and within the configured fiscal period. SEPA IBANs must be valid uppercase electronic values
without spaces; QR-IBANs are rejected. Amounts must be positive exact decimal values with at most two effective decimal places.
Grids does not round fractional cents. DATEV represents the direction separately as `S` or `H`.
SEPA preview `warnings` flag extended characters requiring bank support and a past execution date in the request timezone.
Warnings are advisory metadata, not part of the confirmation hash. Names and dates remain unchanged; cancel and restart with
corrected inputs to change them. Local XML validation does not guarantee bank acceptance.

`businessId` identifies the business event across runs, not a generated export row. DATEV may have multiple postings per event,
each with a unique `entryId`. SEPA requires one row per event and unique `endToEndId` values. Grids reserves event identities
per Base, destination and accounting/payment purpose. A completed export prevents a new export of the same events to that target;
download its stored Document again instead. A replay of the same step returns the same Document. Query joins and accounting
correctness remain the workflow author's responsibility; identifiers do not prove that sums or approval rules are correct.

When the run waits for confirmation:

```bash
cld grids workflow-runs steps RUN_ID
cld grids workflow-runs preview-export RUN_ID RECEIPT_ID --json
cld grids workflow-runs confirm-export RUN_ID RECEIPT_ID --sha256 REVIEWED_HASH --yes
cld grids workflow-runs get RUN_ID
```

Replace the uppercase placeholders with the public IDs and exact hash returned by the preview. Review the profile/version, destination, all mapped
rows, dates, totals and any explicit query limit before confirming. Use the same account and access method that launched the run,
with current permissions: a browser session cannot substitute for an API credential. The preview supplies the viewer's `timeZone`
for date display; exact amounts remain decimal strings. Never fetch a new hash silently or confirm without the user's approval. Confirmation resumes generation; it does not
mean the file already exists. Inspect the completed run and download its Document. The UI offers the same review from the waiting
step or a Custom App action's status. Confirmation has no automatic expiry: closing the review leaves the run waiting until confirmation or explicit cancellation. The frozen data and reserved number remain retained; current permissions and source-version guards are rechecked at confirmation and issuance.

`atomicRecords` is a bounded Grids-only transaction. `locks` contains existing record references acquired in stable order. Each `checks`
entry selects a bound `table`, has 1–20 `where` predicates combined with AND, and uses `assert: empty|notEmpty`; predicates contain
`field`, `op`, optional `value`, and optional `caseInsensitive`. Optional `message` controls the failed-check text. `changes` contains only
`createRecord` entries (`table`, non-empty `values`) or `updateRecord` entries (`record`, non-empty `set`, optional `ifVersion`, optional
`audit`). Grids rechecks current Base permission and commits the writes, relations, audit rows, event outbox, and step outcome
together. A failure rolls back all of them. Dry run validates and evaluates but neither locks nor writes.

Use stored fields for atomic predicates; Formula fields and aggregate arithmetic are not supported. Relation field values in `createRecord`/`updateRecord` and relation-filter values use public Record IDs (for example `${{ inputs.item.recordId }}`), not internal UUIDs, display labels, or whole record-reference objects. Record targets and locks still use references such as `inputs.item`. Relation targets must remain readable in the expected table and Base, including during dry run.

An empty query has no row to lock. Competing reservation workflows must therefore name the same stable coordination record in `locks`, then
check for the absence of an active relation while that record is locked:

```yaml
inputs:
  item:
    type: record
    table: Items
    required: true
steps:
  - atomicRecords:
      locks:
        - inputs.item
      checks:
        - table: Movements
          where:
            - field: Item
              op: containsAny
              value:
                - ${{ inputs.item.recordId }}
            - field: Type
              op: equals
              value: Active loan
          assert: empty
          message: This item is already reserved.
      changes:
        - updateRecord:
            record: inputs.item
            set:
              Status: Loaned
        - createRecord:
            table: Movements
            values:
              Item:
                - ${{ inputs.item.recordId }}
              Type: Active loan
```

`httpRequest` reaches public addresses only. A URL whose host is `localhost`, ends in `.localhost` or `.internal`, or resolves to a
loopback, private, carrier-NAT, link-local, multicast, or reserved address is rejected — every DNS answer is checked, not only the one
dialled — as is a URL carrying credentials or a scheme other than `http`/`https`. There is no setting that widens this. Transport headers
are rejected (`accept-encoding`, `connection`, `content-length`, `host`, `proxy-authorization`, `proxy-connection`, `te`, `trailer`,
`transfer-encoding`, `upgrade`); an `Authorization` header of your own is passed through. Grids sends its own `Idempotency-Key` so a
receiver can deduplicate, defaults `content-type` to `application/json`, and caps the request and response bodies at 64 KiB each.

`httpRequest` is the one action whose outcome cannot be checked afterwards. If a request leaves the process and no complete answer comes
back, the step is neither retried nor failed: the run stops at `needs_attention` and the effect appears in `cld admin workflows effects`
for a person to settle. Repeating it automatically is how the same webhook fires twice.

Control flow uses these exact shapes:

```yaml
inputs:
  state:
    type: select
    options:
      - Ready
      - Pending
  items:
    type: recordList
    table: Items
steps:
  - if:
      equals:
        - ${{ inputs.state }}
        - Ready
    then:
      - setVariable:
          name: readiness
          value: ready
    else:
      - setVariable:
          name: readiness
          value: pending
  - switch: ${{ inputs.state }}
    cases:
      - when: Ready
        do:
          - setVariable:
              name: queue
              value: active
    default:
      - setVariable:
          name: queue
          value: review
  - forEach: inputs.items
    as: item
    do:
      - updateRecord:
          record: item
          set:
            Status: Checked
```

Conditions are `equals`, `notEquals`, `includes`, `textEquals`, `contains`, `startsWith`, `endsWith`, `exists`, `all`, `any`, and `not`. Use `includes` for exact list membership, not `contains`. Text operators require text operands. Binary conditions take
exactly two values; `exists` takes one raw reference; `all` and `any` take non-empty condition lists.

Plain strings are literals. A dynamic value must occupy the whole string as `${{ reference }}` or `${{ now() }}`. References include
`inputs.<name>`, record fields such as `inputs.item.Status`, a prior `saveAs` or variable name, and a loop alias. The expression language has
no arithmetic, concatenation, or additional functions. Reference-only fields remain raw: `record: inputs.item`, `document: documentResult`,
`forEach: inputs.items`, and `exists: inputs.item.Status`. Only `succeed.message` and `fail.message` may embed several expressions in text.
Lists and objects may contain dynamic values recursively.

A single relation field is a typed record reference in raw record slots, for example `record: inputs.asset.Current loan item`. A multiple relation field is a typed record list and may drive `forEach`, for example `forEach: inputs.loan.Items`. Resolution verifies the target table, current access, and every referenced record before the step runs.

Saved document outputs expose `id`, `shortId`, `templateId`, `baseId`, `tableId`, `recordId`,
`number`, `filename`, `createdAt`, `createdBy`, `tags`, and `primaryArtifactKey`. Link outputs expose `kind`, `id`, `url`, `expiresAt`, and
`documentId`. Email outputs expose `subject`, `templateId`, and `recipients`, whose entries include `id`, `deliveryId`, `kind`, `recipient`,
and `status`. HTTP outputs expose `status`, `ok`, and `body`.

Limits are 100 inputs, 1,000 total steps, nesting depth 20, 1,000 conditions, condition depth 20, 10,000 loop or record-list items, and
200,000 YAML characters. Run modes are `execute` and `dryRun`. Invocation channels are `api`, `customApp`, `scanner`, `bulk`, `record`,
`schedule`, and `recordEvent`.

A run and a step do not share a vocabulary, and reading one as the other is how a finished step gets reported as still going:

- A **run** is `queued`, `running`, `waiting`, `succeeded`, `failed`, `canceled`, or `needs_attention`. That set, and only that set, is what
  `workflow-runs list --status` accepts.
- A **step** is `running`, `completed`, `waiting`, `failed`, `needs_attention`, `terminal`, `planned`, `unsupported`, `indeterminate`, or
  `canceled`. A step *completes* where a run *succeeds*. `terminal` is the step that ended the run early — a `succeed` step, or one cut
  short by a cancel request; a `fail` step records `failed`. A dry run records `planned` steps, or `unsupported`/`indeterminate` where it
  could not say what would happen. `cld grids workflow-runs steps <run-id>` prints these.

A minimal manually invoked workflow is:

```yaml
inputs:
  item:
    type: record
    table: Items
    required: true
steps:
  - updateRecord:
      record: inputs.item
      set:
        Status: Checked
```

Validate before saving:

```bash
cld grids workflows validate --source-file check-in.yml --json
cld grids workflows create \
  --name "Check in" \
  --source-file check-in.yml \
  --enabled \
  --json
```

`workflows autocomplete` returns permission-safe YAML completions for a UTF-16 caret offset. Workflow CRUD commands are `workflows list|get|create|update|delete`; deletion requires `--yes`.

Every workflow save creates an immutable revision. Inspect or restore revisions without deleting history:

```bash
cld grids workflows history "Check in"
cld grids workflows restore "Check in" --revision 2 --yes --json
```

Restore copies the selected definition into a new current revision. It uses the current revision as an optimistic concurrency guard and fails if somebody saves the workflow first.

### Invoke and inspect runs

Everything that starts a run is an event. A direct invocation records `grids.invoked`; a scanner, bulk, Record, or Grids App launcher records
`grids.launcherPressed`, a schedule slot records `grids.scheduleTick`, and a watched row records `grids.recordChanged`. The kernel matches
the event against the workflow's activations and materializes the run, so a run has an inspectable cause rather than only a channel label.
A dry run is deliberately not an event: nothing happened, somebody is asking what would, so it is created directly against the workflow's
newest version.

Direct CLI invocation requires a stable idempotency key. Reuse a key only for the same logical invocation.

```bash
cld grids workflows invoke "Check in" \
  --inputs '{"item":"<record-id>"}' \
  --idempotency-key check-in-2026-07-15-001 \
  --json

cld grids workflows invoke "Check in" \
  --mode dryRun \
  --inputs-file inputs.json \
  --idempotency-key check-in-preview-001 \
  --expected-revision 3 \
  --json
```

The idempotency key is scoped to the workflow, not to the channel: repeating it answers with the run it already started and reports
`"created": false`, while reusing it for a different mode, actor, or inputs is rejected as a conflict rather than silently ignored. Launcher
invocations key on their own `operationId` instead. `--expected-revision` rejects the invocation when a different workflow revision is
active; it is not part of the idempotency key. A dry run plans each step's effects rather than performing them; consult the run's steps,
because actions declare different dry-run support in `workflows reference`.

Inspect execution with:

```bash
cld grids workflow-runs list --workflow "Check in" --status failed --json
cld grids workflow-runs get <run-id> --json
cld grids workflow-runs steps <run-id> --json
cld grids workflow-runs documents <run-id> --json
cld grids workflow-emails list --workflow "Check in" --json
```

`workflow-runs list` filters on `--status` (a run state), `--channel`, `--mode`, `--workflow`, and pages with `--cursor` and `--limit` up to
200. `workflow-runs steps` prints step states and an `ATTEMPT` count that starts at 0 and rises each time that one step is re-run; it
returns at most 500 steps and says so when it truncates. These commands see one base. For the kernel-wide view — every app's runs, the event
that caused a run, its effect budget, stranded effects, and events that never turned into runs — use `cld admin workflows` or
`/admin/observability/workflows`. Grids keeps no run list of its own.

Cancel a queued, running, or waiting run explicitly:

```bash
cld grids workflow-runs cancel <run-id> --yes --json
```

Cancellation is a request, not a write. A queued run is canceled at once; a running or waiting one stops when the worker holding it next
checks in, so the command may return the run still `running` and the state settles shortly after. It does not undo effects that already
happened. Run commands are `workflow-runs list|get|cancel|steps|documents|download-documents`. Email delivery history uses
`workflow-emails list`.

### Run options and email templates

Run options expose a workflow as a scanner, bulk, Record, or Grids App interaction. The API and CLI call these resources launchers. The **Close selected Records** starter installs the dedicated bulk profile `closeSelection`; it accepts only exact public Record IDs and is rejected if the workflow no longer has the canonical close-only plan. The browser reviews up to 100 Records and supplies the current Finalization mode and policy revision. API and CLI callers must review and provide those two inputs themselves; every action verifies them again before changing anything. The linked follow-up Draft starter installs the Record profile `correctionDraft`; callers supply one finalized Record public ID, and the canonical action creates one normal Draft linked through the configured existing fields. Set action and launcher `intent` to the same `correction` or `cancellation` value; omitted intent remains `correction` for legacy workflows and launchers. A mismatch is rejected so user-facing wording cannot disagree with the workflow contract, while the selected type value remains the stored business meaning. Its optional `copyFields` list carries over at most 100 stored value fields. Unique fields, generated IDs, Files, other Relations, calculated fields, and Documents are not copied. Grids does not calculate cancellation amounts, taxes, or counter-bookings or generate a Document. Ordinary bulk options may use explicit IDs or a row-shaped query. A Grids App option uses `inputMode: "fixed"` with complete `inputBindings` for a one-click action, or `inputMode: "prompt"` to request the workflow's declared inputs when it runs. Fixed options reject runtime inputs; prompt options do not store fixed bindings. Their complete JSON shapes and invocation bodies are part of `workflows reference`.

For an `object_list` in `copyFields`, only input cells are copied. Computed columns are recalculated using the current list configuration in the new Draft; frozen cells in the original remain unchanged. Review the new amounts before finalizing it.

A Grids App definition may also embed an enabled Scanner run option as a `scanner` block. Embedded scanners require a signed-in App reader and pin the exact launcher configuration and workflow revision at publish time. They accept scalar session and after-scan prompts; use the full Workflow scanner when those prompts must select records.

A waiting financial export appears as **Review export** in either scanner's log. Opening it reviews and confirms the existing run;
closing it does not rescan or create another run. Run-detail and embedded-scanner status responses optionally include
`documentConfirmation: {receiptId, sha256}` while waiting. Use that run's confirmation endpoints; list responses need not include this metadata.

For actions published inside an App, bind every required Workflow input in the App definition. A `prompt` launcher accepts those runtime bindings; the App button does not open a free-input dialog. Use a Records row action with `ROW.id` and page `RECORD.id` when the user must choose a child item for the current parent. Publication rejects missing required inputs.

```bash
cld grids workflow-launchers create "Check in" --body-file scanner-launcher.json --json
cld grids workflow-launchers invoke "Check in" Scanner --body-file scan.json --json
```

Commands are `workflow-launchers list|create|update|delete|invoke`. Deletion requires `--yes`. Source changes can invalidate an option; list it and review its diagnostics before enabling it again.

Workflow emails render a Liquid subject and HTML body. There is no plain-text template field.
The optional `sampleData` JSON object is stored with the template and available as `data` in editor previews. It does not change runtime email data supplied by `sendEmail`.

```bash
cld grids email-templates reference
cld grids email-templates create \
  --body '{"name":"Reminder","subject":"Reminder: {{ data.itemName }}","html":"<p>{{ data.itemName }}</p>","sampleData":{"itemName":"Camera kit"},"enabled":true}' \
  --json
```

Email-template commands are `email-templates reference|list|get|create|update|delete`. A referenced template cannot be deleted; update the dependent workflows first.

## Command index

Platform administrators can inspect and replay retained event delivery failures. This is not a Base-admin privilege:

```bash
cld grids record-events failures <base-id> --offset 0 --json
cld grids record-events replay <base-id> <failure-id> --yes --json
```

Failure lists return 100 items and `nextOffset`, without retained payloads. Use the exact operational failure UUID from that list. Replay uses the original event and only accepts stopped entries; acceptance is not proof of successful processing.

The app CLI covers terminal workflows; Cloud Capabilities remain a curated daily-task interface, not a mirror of administrative commands. App-only readers use `apps runtime`, not raw Base commands.

### Use a published App

Start with the App's public ID from `/apps/<id>`. No Base grant or default Base is needed:

```bash
cld grids apps runtime read APP001 --json
cld grids apps runtime read APP001 --page request --params '{"request_id":"REC001"}' --json
cld grids apps runtime records APP001 home requests --search "certificate" --json
cld grids apps runtime submit APP001 home apply --body '{"FIELD1":"Certificate request"}' --yes --json
cld grids apps runtime action APP001 request actions approve --params '{"request_id":"REC001"}' --body '{"operationId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}' --yes --json
```

`read` returns available navigation, visible block IDs, data, field schemas, editable fields, forms, document metadata and actions. Follow `rowNavigate` or returned navigation URLs to detail pages. Unavailable pages return 404; an individual data block can return its own error. Discovery does not expose drafts or compiled grants.

Use the exact page parameters on later commands. `records` accepts the returned cursor; row actions take `{operationId,rowId,search?,cursor?}` and must replay the displayed selection's search/cursor. Actions take `{operationId}`; reuse that UUID for retries, not for a new operation. `run` needs the same page/block and `--action <id>` for action runs; omit it for scanners. Accepted/queued does not mean completed.

Direct published-runtime HTTP reads use `_search`, `_cursor`, and `_limit` for list controls, separate from page parameters such as `q`, `cursor`, or `limit`. The CLI keeps its `--search`, `--cursor`, and `--limit` flags. Base record APIs are unchanged.

`update` takes `{values,audit?}`; only the published editable fields can change. `scan` takes `{operationId,expectedRevision,scannedText,inputs?}` using the discovered revision and prompt inputs. `submit` and `sidebar-submit` accept field values or `{data,inlineCreates?,idempotencyKey?}`. Do not supply fixed fields. Use an explicit stable `idempotencyKey` and the identical body on retries; unkeyed creates can duplicate. An edit Form additionally requires root `version` and may accept `inlineUpdates`; see the Form submission contract above. Commands that submit, update, scan or run actions require `--yes`.

`comments create|update` takes `--body '{"body":"Markdown"}'`; update/delete also need `--comment <id>`. File commands take the discovered File field as the fourth argument: upload/replace use `--file <path>`, existing files use `--id <id>`, downloads use `--out <path>`. Delete and replace require `--yes`. `document` downloads the exact stored PDF with `--out`. All writes retain the published runtime's authentication, current availability and permission checks; App grants never grant raw Base access. JSONL keeps the complete page envelope, including cursors.

### Daily capabilities

Agents can discover templates with `document.templates`, list stored results with `document.list`, follow `grids.document` references with `document.read`, and request `document.create` with an enabled template and a Record from its table. Issuance is permanent and always needs individual approval and an idempotency key. It neither sends the document nor guarantees legal compliance.

`workflow.record-actions` lists existing correction/cancellation Draft actions, including their intent. Use its table ID to find a finalized original with GQL, then call `workflow.record-action` with the exact revision and explicit approval. This creates a linked Draft, leaves the original unchanged, and does not issue or send a document. Reuse the same idempotency key for a retry and follow the returned `grids.workflow-run` reference with `workflow.run.read`. Creation/editing of workflows, other workflow kinds, bulk operations and App-only actions stay in the CLI.

Use `cld grids <command> --help` for every flag, positional form, constraint, and built-in example.

```text
list, use, current
templates list|instantiate
bases list|get|create|update|delete|restore|trash|retention
bases retention preview|set|remove
bases retention records list
bases retention files list|download
bases preservation-holds list|create|release
bases destruction preview|run|status|cancel
access reference|list|grant|set|revoke|search-principals
tables list|get|create|update|delete|restore|history|finalization|mutation-policy
tables history enable|finalization enable|finalization disable|finalization policy
tables mutation-policy impact|set
tables combined get|candidates|publications|validate|draft|publish|revoke
fields types|type|list|get|create|update|delete|restore|dependents|reorder
records changes|shape|list|query|get|create|upsert-external|upsert-external-batch|import|export|update|finalize|finalization request|finalization approve|finalization reject|delete|restore|audit|audit list|versions
records versions download
records files list|upload|replace|download|delete
records comments list|create|update|delete
records referenced-by
record-events failures|replay
snapshots list|create|get
gql reference|run|preview|compile-view|autocomplete|skill|context
formulas reference|check
views list|get|create|update|delete|restore
forms list|default|get|create|update|delete|restore|submit
apps reference|list|create|get|validate|plan|apply|export|publish|unpublish|restore|delete
apps runtime read|records|submit|sidebar-submit|update|action|row-action|scan|run|document|image
apps runtime comments list|create|update|delete
apps runtime files list|upload|replace|download|delete
document-templates reference|list|get|create|update|delete
document-templates preview-data|preview-pdf|preview-draft-data|preview-draft-pdf
documents renderers|list|list-by-template|browse|by-record|sources|generate|get|download|download-artifact
documents links list|create|revoke
evidence preflight|list|create|get|retry|cancel|download|verify
email-templates reference|list|get|create|update|delete
workflows reference|list|get|create|update|history|restore|delete|validate|autocomplete|invoke
workflow-launchers list|create|update|delete|invoke
workflow-runs list|get|cancel|steps|documents|download-documents
workflow-emails list
```
