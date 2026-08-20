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
- A **document template** renders GQL data through Liquid HTML and Gotenberg. A generated document keeps a recursive record snapshot.
- A **workflow** is validated YAML with inputs, optional triggers, and steps. Launchers adapt workflows to scanner, bulk, Record, and Grids App
  interactions. Grids contributes the actions and the events; the runs themselves live in Cloud's shared workflow kernel, so
  `cld grids workflow-runs` reads one base while `cld admin workflows` reads every app.

Permissions are enforced by the backend on every command. Raw Grids commands require the owning Base permission. Only Base and Grids Apps have Cloud access grants; listing or resolving either resource does not grant access to it.

## Agent workflow

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
default to UTC. Grids uses the platform English locale for server-rendered number and date output; Grids App `valueFormat` controls
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
- Read-only computed values: `formula`, `lookup`, `rollup`.
- Read-only system or generated values: `created_at`, `created_by`, `id`, `updated_at`, `updated_by`.
- External file storage: `file`; use `records files` commands instead of record JSON.

Important encodings:

- `number` stores a canonical decimal string, although writes accept strings or numbers.
- `select` stores an array of option ids, including single-select fields.
- `relation` stores target record public IDs. A single relation can be written as one public ID string; multiple relations use an array.
- `principal` always stores an array of typed Cloud references such as `[{"type":"user","id":"..."},{"type":"group","id":"..."}]`, even when its cardinality is `single`. Writes are revalidated against the current actor's identity-discovery scope.
- `date` uses `YYYY-MM-DD` unless `includeTime` is enabled; date-time values must include a timezone.
- `duration` accepts seconds, `MM:SS`, or `HH:MM:SS` and stores integer seconds.
- `id`, formula, lookup, rollup, and timestamp fields must not be sent in record writes.

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

`records audit` shows one stored or Combined record's history. `records audit list` browses the published lifecycle history across an
entire Combined table and accepts record, source, action, time-range, cursor, and limit filters. Combined audit entries expose only
canonical included fields, declared audit answers such as required deletion comments, and safe source labels.

Record commands are `records shape|list|query|get|create|import|export|update|finalize|finalization request|finalization approve|finalization reject|delete|restore|audit|audit list|versions|versions download`.

### Files and snapshots

File fields use dedicated blob commands:

```bash
cld grids records files upload Assets <record-id> Photo --file image.png --json
cld grids records files list Assets <record-id> Photo --json
cld grids records files download Assets <record-id> Photo <file-id> --out image.png
cld grids records files delete Assets <record-id> Photo <file-id> --yes
```

Manual recursive record snapshots use `snapshots list|create|get`:

```bash
cld grids snapshots create Assets <record-id> --json
cld grids snapshots list Assets <record-id> --json
```

## Publish Combined tables

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

## Publish a Grids App

Grids Apps are strict schema-v5 YAML definitions owned by one base. The current contract supports up to 12 pages containing responsive rows and
columns plus Markdown, Records, Referenced records, Metrics, Chart, Record, Rendered HTML, Form, Comments, Actions, and Scanner blocks. Records and insight blocks can use a saved view
or GQL. A Records block can navigate its row id or one selected single relation into one required
record parameter on a detail page. Record and Comments blocks use that page record; Record renders only its explicit field allowlist.
For signed-in readers, an editable displayed File field exposes App-scoped attachment controls without granting raw Base API access. File validation and limits remain owned by the field and file service. A published Comments block lets signed-in App readers comment without Base access; authors manage their own comments and Base administrators moderate. Form blocks submit existing Grids forms and may carry trusted typed `LITERAL`, `PARAMS`,
or page `RECORD` values. Records blocks may declare up to six workflow `rowActions`; compatible record inputs can receive `ROW.id`, and
the runtime rechecks the selected id against the exact published query result. Run the live reference before authoring a definition:

Saved-view Records blocks can use `display: { kind: table, columnIds: [...] }` or `display: { kind: cards }`. Cards reuse and pin the saved View's existing Cards fields and file cover. Row navigation is optional, and Cards reuse the same bounded workflow `rowActions` as tables. GQL Records blocks are table-only and display the query's selected ordinary-record columns, including aliases; use an empty `columnIds` list because no second column selection is applied. Use Metrics or Chart for aggregate output. Set `searchable: true` for parameterized PostgreSQL search over displayed fields and choose `pageSize` from 5 to 100. Cursor pagination stays server-side for both saved Views and GQL; use a GQL `limit` only to cap the complete result intentionally.

On a Record page, `referenced_records` pins one source table, one Relation field targeting the page record table, the exact displayed `fieldIds`, table or Cards display, search, page size, and optional row actions. The server derives and compiles the bounded GQL membership query from the page record parameter; do not add a second query or client-side reverse lookup.

Pages, blocks, Forms, and actions may use one `availableWhen.query`. At least one returned row means available. An empty result, invalid query, missing context, timeout, or cancellation means unavailable. The server rechecks Forms and actions before execution.

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

Document templates combine GQL source, Liquid HTML, optional header/footer HTML, and page CSS. Read the runtime reference before creating one:

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

Saved-template previews use the stored template. Draft previews accept unsaved source, HTML, header, footer, CSS, number, and filename values; passing a saved template uses it as defaults before applying draft overrides.

Generate and manage immutable document output from a selected record:

```bash
cld grids documents generate Invoices Invoice \
  --record <record-id> \
  --tag issued \
  --out invoice.pdf \
  --json
cld grids documents by-record Invoices <record-id> --json
```

Document commands are `documents list|browse|by-record|generate|update|download`. `documents browse --mode folders --path 2026/07` traverses generated documents by year and month. Search matches filenames, numbers, or tags; tag filters are repeatable.

Public document links are bearer links. Create only the lifetime the user needs and revoke them when no longer required:

```bash
cld grids documents links create <document-run-id> --expires-in 30d --comment "Customer copy" --json
cld grids documents links list <document-run-id> --json
cld grids documents links revoke <link-id> --json
```

Supported lifetimes are `1d`, `7d`, `30d`, and `90d`; the default is `30d`.

## Verify evidence packages

`evidence verify` checks a downloaded Grids evidence TAR locally. It does not
contact Cloud, require a profile, extract files, or upload package contents.
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

The shipped inputs are `record`, `recordList`, `text`, `number`, `boolean`, `date`, `dateTime`, and `select`. Triggers are `schedule` and `recordEvent`. Actions are `closeRecord`, `createCorrectionDraft`, `finalizeRecord`, `updateRecord`, `createRecord`, `atomicRecords`, `generateDocument`, `createDocumentLink`, `sendEmail`, `httpRequest`, `setVariable`, `fail`, and `succeed`. Control flow supports `if/then/else`, `switch/cases/default`, and `forEach/as/do`.

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
| `closeRecord` | `record` | `expectedMode`, `expectedPolicyRevision` | none |
| `createCorrectionDraft` | `original`, `typeField`, `typeValue`, `originalField` | none | created correction Draft |
| `finalizeRecord` | `record` | none | none |
| `updateRecord` | `record`, non-empty `set` | `audit` answers by question UUID | none |
| `createRecord` | `table`, non-empty `values` | `saveAs` | created record |
| `atomicRecords` | 1–100 `locks`, 1–50 `checks`, 1–50 `changes` | check `message`; update `ifVersion` and `audit` | none |
| `generateDocument` | `template`, `record` | `filename`, up to 20 `tags`, `saveAs` | document |
| `createDocumentLink` | `document` | `expiresIn: 1d|7d|30d|90d` default `30d`, `comment`, `saveAs` | public link |
| `sendEmail` | `template`, `to` with 1–50 recipients | `data` with at most 200 keys, `saveAs` | email result |
| `httpRequest` | absolute HTTP(S) `url` | `method` default `POST`, up to 100 `headers`, `json`, `timeoutMs` default 15,000 and range 1,000–60,000, `saveAs` | response |
| `setVariable` | `name`, `value` | none | named value |
| `succeed` | `message` | none | terminates successfully |
| `fail` | `message` | none | terminates with failure |

`sendEmail.to` entries contain exactly one of `email` or `user`. HTTP methods are `GET`, `POST`, `PUT`, `PATCH`, and `DELETE`; requests
carry optional JSON only. Field, table, document-template, and email-template references accept an exact name or public ID.

`atomicRecords` is a bounded Grids-only transaction. `locks` contains existing record references acquired in stable order. Each `checks`
entry selects a bound `table`, has 1–20 `where` predicates combined with AND, and uses `assert: empty|notEmpty`; predicates contain
`field`, `op`, optional `value`, and optional `caseInsensitive`. Optional `message` controls the failed-check text. `changes` contains only
`createRecord` entries (`table`, non-empty `values`) or `updateRecord` entries (`record`, non-empty `set`, optional `ifVersion`, optional
`audit`). Grids rechecks current Base permission and commits the writes, relations, audit rows, event outbox, and step outcome
together. A failure rolls back all of them. Dry run validates and evaluates but neither locks nor writes.

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
              Item: ${{ inputs.item }}
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

Conditions are `equals`, `notEquals`, `contains`, `startsWith`, `endsWith`, `exists`, `all`, `any`, and `not`. Binary conditions take
exactly two values; `exists` takes one raw reference; `all` and `any` take non-empty condition lists.

Plain strings are literals. A dynamic value must occupy the whole string as `${{ reference }}` or `${{ now() }}`. References include
`inputs.<name>`, record fields such as `inputs.item.Status`, a prior `saveAs` or variable name, and a loop alias. The expression language has
no arithmetic, concatenation, or additional functions. Reference-only fields remain raw: `record: inputs.item`, `document: documentResult`,
`forEach: inputs.items`, and `exists: inputs.item.Status`. Only `succeed.message` and `fail.message` may embed several expressions in text.
Lists and objects may contain dynamic values recursively.

A single relation field is a typed record reference in raw record slots, for example `record: inputs.asset.Current loan item`. A multiple relation field is a typed record list and may drive `forEach`, for example `forEach: inputs.loan.Items`. Resolution verifies the target table, current access, and every referenced record before the step runs.

Saved document outputs expose `id`, `templateId`, `workflowRunId`, `snapshotId`, `baseId`, `tableId`, `recordId`,
`documentNumber`, `filename`, `tags`, `generatedBy`, and `generatedAt`. Link outputs expose `kind`, `id`, `url`, `expiresAt`, and
`documentRunId`. Email outputs expose `subject`, `templateId`, and `recipients`, whose entries include `id`, `deliveryId`, `kind`, `recipient`,
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

Run options expose a workflow as a scanner, bulk, Record, or Grids App interaction. The API and CLI call these resources launchers. The **Close selected Records** starter installs the dedicated bulk profile `closeSelection`; it accepts only exact public Record IDs and is rejected if the workflow no longer has the canonical close-only plan. The browser reviews up to 100 Records and supplies the current Finalization mode and policy revision. API and CLI callers must review and provide those two inputs themselves; every action verifies them again before changing anything. The **Create correction Draft** starter installs the Record profile `correctionDraft`; callers supply one finalized Record public ID, and the canonical action creates one normal Draft linked through the configured existing fields. Ordinary bulk options may use explicit IDs or a row-shaped query. A Grids App option uses `inputMode: "fixed"` with complete `inputBindings` for a one-click action, or `inputMode: "prompt"` to request the workflow's declared inputs when it runs. Fixed options reject runtime inputs; prompt options do not store fixed bindings. Their complete JSON shapes and invocation bodies are part of `workflows reference`.

A Grids App definition may also embed an enabled Scanner run option as a `scanner` block. Embedded scanners require a signed-in App reader and pin the exact launcher configuration and workflow revision at publish time. They accept scalar session and after-scan prompts; use the full Workflow scanner when those prompts must select records.

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
records shape|list|query|get|create|import|export|update|finalize|finalization request|finalization approve|finalization reject|delete|restore|audit|audit list|versions
records versions download
records files list|upload|download|delete
snapshots list|create|get
gql reference|run|preview|compile-view|autocomplete|skill|context
formulas reference|check
views list|get|create|update|delete|restore
forms list|default|get|create|update|delete|restore|submit
apps reference|list|create|get|validate|plan|apply|export|publish|unpublish|restore|delete
document-templates reference|list|get|create|update|delete
document-templates preview-data|preview-pdf|preview-draft-data|preview-draft-pdf
documents list|browse|by-record|generate|update|download
documents links list|create|revoke
evidence verify
email-templates reference|list|get|create|update|delete
workflows reference|list|get|create|update|history|restore|delete|validate|autocomplete|invoke
workflow-launchers list|create|update|delete|invoke
workflow-runs list|get|cancel|steps|documents|download-documents
workflow-emails list
```
