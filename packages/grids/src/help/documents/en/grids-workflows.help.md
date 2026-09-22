---
id: grids-workflows
title: Workflows
icon: ti ti-route
description: Automate repeatable work with typed inputs, safe actions, and observable runs.
order: 140
---
Workflows run record changes, documents, email and HTTP steps. Runs retain their published revision and outcomes; edits do not change active runs.

Use formulas for values, forms for creation, and workflows for multi-step operations. Give each workflow one outcome.

Agents use `workflow.record-actions` and `workflow.record-action` for approved correction Drafts; `workflow.run.read` tracks completion. Other workflow authoring and operations use the CLI.

## Create and test a first workflow {icon="route"}

**New workflow → Create a file from a query:** preview GQL, choose CSV/JSON/PDF/XML, then review the disabled draft. **Run inputs** binds `@params.name`; preview values are not saved. Capture happens when the workflow runs.

Workflow GQL starts with `from table`. Independent grouped summary Views can be joined, including in atomic checks. Publication pins their complete definitions and field dependencies; republish after changing a used summary. Ordinary View roots and non-summary View joins are not supported.

DATEV starters need issued totals and accounting fields; SEPA starters need finalized reimbursements with required unique numbers. Configure the destination and check dates. Files are not imported bookings or payments.

Name and Description explain the workflow. YAML defines inputs, optional triggers, and steps.

This workflow asks for one Items record and changes its status:

**Update one record**

```yaml
inputs:
  item:
    type: record
    table: Items
steps:
  - updateRecord:
      record: inputs.item
      set:
        Status: Checked
```

:::steps
1. Open **Workflows** in Edit mode and create a workflow.
2. Enter the name and description outside YAML.
3. Add the smallest input and step definition that produces the intended result.
4. Save until the YAML and Grids references validate.
5. Run a **dryRun** with a representative input and inspect every predicted effect. A step shown in amber could not be planned; fix that before executing.
6. Run **execute**, then inspect the succeeded run and the changed record.
7. Add an automatic trigger or run option only after direct execution is correct.
:::

## Understand the YAML contract {icon="code"}

Workflow YAML is deliberately strict. The root accepts only `inputs`, `triggers`, and `steps`. Inputs and triggers are optional; `steps` is required and must contain at least one step. Omit an unused section instead of writing an empty `triggers: {}` block.

Input names, `saveAs` names, `setVariable.name`, and `forEach.as` aliases are identifiers: start with a letter or underscore, then use only letters, digits, and underscores. Names are case-sensitive. A saved name cannot reuse an input, another saved value, a loop alias, or the reserved roots `inputs`, `trigger`, `bindings`, and `context`.

Each action step contains exactly one action. Control-flow steps use their documented keys, such as `if` with `then` and optional `else`. Unknown root keys, input properties, trigger properties, action fields, and control-flow keys are errors. The editor reports them with a line and column rather than ignoring them.

YAML maps must not repeat a key. Indentation defines nesting, so use spaces consistently and keep sibling properties aligned. Quote a value when it must remain text but looks like `true`, `false`, `null`, or a number. Quote cron expressions so their spaces and `*` characters remain one clear value.

## How runs start {icon="square-plus"}

Execute runs start through direct UI/API/CLI requests, saved run options (scanner, bulk, Record or Grids App), `schedule`, or `recordEvent`. Direct requests and run options need no YAML trigger. Automatic triggers must be declared and published. Disabled workflows reject execution; unhandled occurrences create no run.

A **dry run is not an event**: it plans the newest published revision without consulting triggers, including for disabled workflows.

The run options are saved separately, outside workflow YAML. Scanners map scanned text or a resolved Record to one input; other inputs may be fixed, requested once or requested after each scan. Bulk supplies a record list. Record options use the open Record. Grids App options supply fixed values or request declared inputs.

## Understand a run {icon="layout-grid"}

:::reference
- **Inputs:** Typed values supplied by a direct caller, run option, or automatic trigger. Record inputs resolve before steps execute.
- **Revision:** A run pins the revision it started on and executes that plan to the end. Editing, restoring, or disabling the workflow does not change a run already in flight.
- **Steps:** Actions and control flow executed in order. A failed step stops the run and writes its message and error code to the run history.
- **Observe:** Each run keeps its revision, mode, channel, inputs, status, timing, step outcomes, result or error, and generated documents.
:::

A **run** succeeds; a **step** completes. The two vocabularies are deliberately different: a step that ran to the end reads `completed` and never `succeeded`, and a step a dry run only described reads `planned`. Read a step badge as a statement about that step, not as the run's verdict.

An idempotency key identifies one logical invocation. Retrying with the same key reuses it; reusing the key for different input is rejected. This prevents an uncertain client retry from quietly creating a second logical run. Execute and dry-run keys are separate, so the same key can be used once for each mode.

### Follow the run lifecycle

Starting a workflow creates a run immediately. Open that run to follow its current status, progress message, inputs, starter, run option, and individual steps. A run can wait for external work without appearing failed. Its detail names what it is waiting for.

You can cancel a queued, running, or waiting run. Cancellation is a request: the worker holding the run notices and unwinds where it is, rather than the run being deleted underneath it. It stops later steps, but it does not undo record changes, documents, emails, or HTTP requests that already finished. Resolve those effects explicitly when needed.

**Run again** opens the input dialog pre-filled from the selected run, then starts the workflow's current revision in the same mode the original used. Review the inputs before starting because the workflow may have changed since. To inspect exactly what an older run executed, open its linked revision from the run detail.

Publishing new YAML creates an immutable revision, so the revision number counts published plans rather than edits — renaming a workflow or changing its description does not produce one. Restoring an older revision never deletes history; it publishes that definition as a new current revision. Enabling a workflow with a schedule or record-event trigger requires confirmation because it can start work without another click.

## Inputs reference {icon="book-2"}

Every input has `type`. Optional `label` and `description` text appears in generated controls. `required: true` rejects a missing value; omitting `required` makes the input optional. Omitted or `null` optional scalar inputs resolve to `null` in workflow expressions; `false`, `0`, and empty text remain unchanged.

| Type | Run value | Additional declaration |
| --- | --- | --- |
| `record` | One record public ID | Required `table` exact name or public ID |
| `recordList` | Ordered list of record public IDs, at most 10,000 | Required `table` exact name or public ID |
| `text` | String | None |
| `number` | Finite number | None |
| `decimal` | Exact decimal string, such as `"12.50"` | None |
| `boolean` | `true` or `false` | None |
| `date` | Date in `YYYY-MM-DD` format | None |
| `dateTime` | ISO date-time | None |
| `select` | String equal to one configured option | Required `options` list with 1–200 values |

Decimal controls accept the locale’s decimal separator, without grouping separators. Runs receive normalized decimal strings without floating-point conversion, within the ordinary Number field’s supported range. Use `decimal` for exact amounts.

Record inputs are checked against the bound table and current read permission before steps start. Unknown inputs, missing records, inaccessible tables, wrong value types, and values outside a select's options reject the invocation.

**Input declarations (fragment)**

```yaml
inputs:
  item:
    type: record
    table: Items
    label: Item
    required: true
  labels:
    type: recordList
    table: Items
  note:
    type: text
  priority:
    type: select
    options:
      - Low
      - Normal
      - High
```

## Invoke a workflow directly {icon="terminal-2"}

:::reference
- **Request shape:** The workflow page, the authenticated API, and the CLI all invoke the same workflow with an input object, `execute` or `dryRun` mode, and an idempotency key.
- **Expected revision:** A caller may state the revision it loaded. If the workflow has been published again since, the invocation is rejected instead of running a plan the caller never saw.
- **Deduplication:** The same idempotency key returns the first run. The same key with different inputs, a different mode, a different channel, or a different actor is rejected as a conflict.
- **Disabled workflows:** An execute invocation of a disabled workflow is refused. A dry run of one is still allowed.
:::

Only `schedule` and `recordEvent` belong under `triggers` in YAML. A workflow does not need a YAML trigger: one that is only ever invoked directly or through a run option leaves the block out entirely.

## Automatic trigger reference {icon="route"}

:::reference
- **schedule:** Starts future runs from a five-field cron expression. timezone is an optional IANA timezone and defaults to UTC. The same scheduled time creates at most one run. If a scheduled time passes while Grids is unavailable, that missed run is not created later.
- **recordEvent:** Runs when a record is created, updated, deleted, or commented on. Add an optional table restriction and a filter that must match before the workflow starts.
- **Activation window:** A record event only starts a run if it happened after the trigger became active. Enabling a workflow, or publishing a changed record-event trigger, restarts that window — earlier changes are not replayed into it.
- **with bindings:** Map trigger values into declared workflow inputs. Every required input must receive a compatible value before the automatic run can start.
- **Trigger values:** Schedules expose occurredAt and slot. Record events expose record, event, and occurredAt through the trigger root.
:::

A workflow may declare both trigger kinds. Trigger bindings can read only `trigger.*` values; they cannot read run inputs or values created by steps. If an automatic trigger cannot bind every required input, validation fails. Keep interactive-only workflows trigger-free and start them directly or through a run option.

A cron expression has exactly five fields in this order: `minute hour day-of-month month day-of-week`. Values use numbers, `*`, comma lists, ranges, and `/step`; month and weekday names are not accepted. Minute is 0–59, hour 0–23, day-of-month 1–31, month 1–12, and day-of-week 0–7 where both 0 and 7 mean Sunday. For example, `'0 9 * * 1-5'` means 09:00 Monday through Friday in the selected timezone.

**Scheduled workflow**

```yaml
inputs:
  requestedAt:
    type: dateTime
    required: true
triggers:
  schedule:
    cron: '0 9 * * 1-5'
    timezone: Europe/Berlin
    with:
      requestedAt: ${{ trigger.slot }}
steps:
  - succeed:
      message: "Scheduled for ${{ inputs.requestedAt }}."
```

**Record-event workflow**

```yaml
inputs:
  item:
    type: record
    table: Items
    required: true
  eventAt:
    type: dateTime
    required: true
triggers:
  recordEvent:
    event: updated
    table: Items
    filter:
      fieldId: Name
      op: contains
      value: ready
      caseInsensitive: true
    with:
      item: ${{ trigger.record }}
      eventAt: ${{ trigger.occurredAt }}
steps:
  - updateRecord:
      record: inputs.item
      set:
        Reviewed at: ${{ inputs.eventAt }}
```

:::reference
- **Filter shape:** A leaf uses fieldId, op, and value; fieldId accepts an exact field name or public ID. Text leaves may also set caseInsensitive. Combine leaves with a group containing op: AND or op: OR and a filters list. isEmpty, isNotEmpty, today, thisWeek, and thisMonth omit value.
- **Text operators:** equals, notEquals, contains, notContains, startsWith, endsWith, regex, isEmpty, isNotEmpty.
- **Number operators:** =, !=, <, <=, >, >=, between, isEmpty, isNotEmpty. between takes a two-number \[from, to] list.
- **Date operators:** =, notEquals, before, after, onOrBefore, onOrAfter, between, today, thisWeek, thisMonth, lastNDays, isEmpty, isNotEmpty. between takes a two-value \[from, to] list. Use ISO dates, timezone-aware ISO date-times for fields with time, and a non-negative integer for lastNDays.
- **Boolean, select, and relation operators:** Boolean fields use =, isEmpty, isNotEmpty. Select fields use is, isNot, isAnyOf, isNoneOf, isEmpty, isNotEmpty; list operators take option-id arrays. Relation fields use containsAny, notContainsAny, isEmpty, isNotEmpty; list operators take non-empty record public-ID arrays.
:::

:::note Required inputs
Direct callers can provide every declared input. Run options accept only the inputs their saved configuration assigns to the user. Each automatic trigger must use `with` to provide all required inputs from compatible trigger values.
:::

## Run option reference {icon="book-2"}

:::reference
- **Scanner:** Maps exactly one text or record input to the scan. Record scans resolve by generated scan code or a configured unique field. Any other workflow input can be asked once before scanning, asked after every scan, or fixed by the run option.
- **Bulk:** Binds one recordList input from explicit record IDs or a row-shaped table query, with at most 10,000 records per run. The **Close selected Records** starter installs a protected exact-selection profile; ordinary bulk options keep their normal query behavior.
- **Record:** Binds the currently open Record. The linked follow-up Draft starter exposes a clearly named correction or cancellation action only on finalized Records and accepts only its one linked-Draft plan.
- **Grids App:** Exposes the workflow as a Grids App action and may save input bindings such as a fixed reporting range.
- **Lifecycle:** Each option has its own name, enabled state, validated workflow revision, and diagnostics. Source changes can make an option unavailable until it is reviewed and saved again.
:::

:::note Outside YAML
Run options are configured separately from the workflow source. One workflow can therefore support multiple named scanner, bulk, Record, or Grids App actions without changing its YAML. Protected profiles may bind presentation to the workflow contract: a linked follow-up Draft run option must use the same correction or cancellation intent as its action.
:::

## Step reference {icon="book-2"}

| Step | Required fields | Optional fields and defaults | Dry run |
| --- | --- | --- | --- |
| `query` | GQL `source` | Typed `parameters`, `saveAs` | Checks schema and access without capturing rows |
| `closeRecord` | `record` | `expectedMode`, `expectedPolicyRevision` | Predicts Direct Finalization or a Four-eyes request from the Table's current policy |
| `createCorrectionDraft` | `original`, `typeField`, `typeValue`, `originalField` | `intent` (`correction` default), `copyFields`, `values`, `saveAs` | Validates the finalized original and predicts one linked Draft |
| `finalizeRecord` | `record` | None | Validates Write access and predicts one permanent finalization |
| `deleteRecord` | `record` | `audit`, `saveAs` | Checks permission and predicts moving a non-finalized Record to trash, not destroying it |
| `updateRecord` | `record`, non-empty `set` | `audit` answers keyed by audit-question UUID | Validates and predicts the record update |
| `createRecord` | `table`, non-empty `values` | `copyFrom`, `copyFields`, `saveAs` | Validates and predicts the new record |
| `atomicRecords` | 1–100 `locks`, 1–50 `checks`, 1–50 `changes` | Check `message`; update `ifVersion`; update/delete `audit`; 1–50 `validateDocuments` | Evaluates checks and predicts changes without locking or writing |
| `generateDocument` | `template` + `record`, or `data` + `output` | `filename`, up to 20 `tags`, `associatedData`, `saveAs` | Validates access and values; does not generate |
| `createDocumentLink` | `document` output reference | `expiresIn` (`1d`, `7d`, `30d`, `90d`; default `30d`), `comment`, `saveAs` | Validates the document and access; does not create a link |
| `sendEmail` | `template`, 1–50 `to` recipients | `data` with up to 200 keys, `saveAs` | Validates template, recipients, data, and access; does not send |
| `httpRequest` | Absolute HTTP or HTTPS `url` | `method` (default `POST`), `headers`, `json`, `timeoutMs` (default 15,000; range 1,000–60,000), `saveAs` | Resolves and checks the target; does not send |
| `setVariable` | `name`, `value` | None | Stores the planned value in the current scope |
| `succeed` | `message` | None | Stops planning with a successful terminal result |
| `fail` | `message` | None | Stops planning with the failure that execution would produce |

`query` captures at most 10,000 rows/5 MiB or fails atomically; GQL `limit` selects a subset. Parameters: `{type, value}` via `@params.name`; types: text, number, decimal (exact string), boolean, date, dateTime, record, recordList. Records use workflow references. Empty `oneof(record.id, @params.selected)` matches nothing. Dry-runs accept planned records but capture nothing. Pass `saveAs` metadata, not rows, to `generateDocument.data`.

Grids resource IDs in run results and live updates are public IDs. Document and
link IDs also resolve to public IDs in expressions. Captures are opaque: pass
the whole saved reference to a later action; `.id` is not an expression field.
Inspect captures using the run's public ID and step key. Cloud account and
operational audit/delivery IDs retain their own identity format.

### Create files from a query


For a joined or grouped file, `associatedData: selection` names an earlier
single-table row query saved as `selection`. Those frozen record identities
determine where the completed file appears. Without it, only unambiguous row
captures infer membership. Membership is distinct from financial
`sourceVersions` freshness checks and does not follow relations. The document
detail distinguishes unique source records from captured output rows.

All source captures share 5 MiB per run, including loop iterations. Reusing a capture does not count twice. Reduce rows/fields or split larger exports into separate runs.

Reordering columns does not invalidate a published query. Changing calculation types can invalidate it: review the query and publish a new workflow revision before starting a new run.

At `generateDocument.data`, the editor suggests prior query results in scope. Reuse a name for several files.

Saved values: `data: { documents: [DOC001], columns: [{ key: number, type: text, path: [number] }] }` reads issued `id`, `number`, `createdAt`, `data`, `profile` or `output`. Invoice `[output, grossAmount]` is the saved exact decimal total. Missing paths fail, including older Documents without output. Manual snapshots use `snapshots: [SNP001]`, path `[root, data, FLD001]`. One row per ID; no live values or array expansion. Related Records are permission-redacted. Limit: 5 MiB.

For workflow values instead of GQL, use `data: { columns: [{ key: amount, type: decimal }], rows: [{ amount: "12.30" }] }`.
Column `key`, optional `label`, and `type` are literal; rows accept workflow expressions. Types: text, decimal (plain string), boolean, date, dateTime, json. Keys and labels must be unique; every row must contain exactly those keys. Null is allowed, missing cells are not. Capture retains types, is bounded to 10,000 rows/5 MiB, and is reused on retry. This source implies no Record identity.

**Capture and export query data**

```yaml
steps:
  - query:
      source: from table Items select Name
      saveAs: report
  - generateDocument:
      data: report
      output: { kind: csv }
      filename: report.csv
      saveAs: reportDocument
```

Do not combine `data`/`output` with `template`/`record`. File steps can share captured data; retries return the existing Document. Generation rechecks direct Base rights or the published App Workflow authorization, not UI table visibility. Find files in **All Documents** or the run. Dry-runs do not render.

- **CSV:** UTF-8, CRLF, ordered aliases as headers. `delimiter` accepts comma (default), semicolon, tab (`"\t"`) or pipe. Null becomes an empty cell; nested values require `nestedValues: json`. Default `textProtection: spreadsheet` prefixes risky text, including `+`/`-` phone numbers, with an apostrophe; the report counts changed cells. Use `raw` only when the recipient handles unmodified text safely.
- **CSV column selection:** Optional `columns: [{ source: Amount, label: Total }, { source: Name }]` selects and orders exact GQL aliases. Omit `label` to keep the alias. Unknown or repeated sources, empty selections and duplicate headings fail. Use aliases, not internal column keys.
- **JSON:** `output: { kind: json }` creates row objects using unique aliases. Exact decimals remain strings; arrays, booleans and null keep their types.
- **JSON wrapper:** Optional `wrapper: { rowsKey: items, values: { approved: "${{ inputs.approved }}" } }` adds typed root properties beside the row array. `values` defaults to `{}` and must not contain `rowsKey`. The property name is literal; values use workflow expressions. Combined output must fit 5 MiB.
- **PDF:** `output.kind: pdf` requires a Liquid `body`; optional `header`, `footer` and `css` use the same template language. The body allows 200,000 characters; each other part allows 50,000. Use `rows`, `columns` and `document.number`/`document.createdAt`. Read cells as `row[column.key]`; `column.label` is the heading. Loops can render multiple rows and their object-list items in one PDF. No live queries or implicit Record are available in this context. The operator must configure the PDF service.

- **XML:** `output.kind: xml` requires a Liquid `body` (up to 200,000 characters), using the same data roots as PDF. Output is UTF-8 XML 1.0 with one root. Values are allowed in text or quoted attributes; names and namespaces must be static. DTDs, CDATA, raw/capture/comment Liquid blocks and dynamic markup are rejected. Static XML comments and an optional static XML declaration are allowed. The shared rendered-template limit is 300,000 bytes. Malformed XML, unknown entities, invalid namespaces or illegal characters fail the step.

- **ZIP:** `output.kind: zip` packages the stored files of existing Documents instead of rendering. `files` lists selections from the captured data: without `column`, the captured rows themselves (a single-table row query); with `column`, the records in that relation alias. Each selection can restrict `template` (record template name or public ID) and `mediaType` (for example `application/pdf`) and can put its files into a `folder`. `required` defaults to true: every selected record must contribute a file and every row must have a relation record, otherwise the step fails; set `required: false` to skip them. `include` adds Documents generated by earlier steps (for example a payment CSV). Every issued Document of a record is packaged with its original bytes; the same Document file appears once, and equal file names get the Document ID appended. The selection is frozen with the first attempt, so retries produce the same archive. Limits: 10,000 files and 512 MiB per archive; an empty selection fails.

**Package Document files**

```yaml
steps:
  - query:
      source: from table Items select Name
      saveAs: items
  - generateDocument:
      data: items
      output: { kind: csv }
      saveAs: itemList
  - generateDocument:
      data: items
      output:
        kind: zip
        files:
          - { template: Item label, mediaType: application/pdf, folder: labels, required: false }
        include: [itemList]
      filename: item-labels.zip
```

Public download links support PDF only. Free XML does not validate a financial format.

**Review a financial export**

IBANs are masked; choose **Show bank details** to inspect them.

`generateDocument` also accepts `output: { kind: datev-csv, version: 1, header: ..., mapping: ... }`
or `kind: sepa-xml`. These create EUR booking or payment files, not imported bookings or executed payments.
The DATEV profile targets 700/13; SEPA targets SCT pain.001.001.09 (DK GBIC 5). Acceptance by the receiving system is not guaranteed.
SEPA previews warn about past execution dates. Unsupported characters are rejected before issuance; Grids does not transliterate names or silently rewrite values. Cancel and restart to correct inputs.

Start manually; automatic triggers cannot create financial exports. Choose **Review export** in the run, Custom App action or scanner log.
Check destination, date, rows, totals and query limit. Confirmation has no automatic expiry; cancel unwanted runs explicitly.
Optional `sourceVersions: [{tableId: TBL001, recordId: REC001, version: 3}]` beside `data` pins author-selected Records.
`sourceVersions: data` derives versions from a new, single-source query with unique Record rows. Joins and missing metadata fail.
Changes conflict at confirmation and issuance. Child/lookup dependencies are not recursive; without this option, frozen data is used.

Map exact GQL aliases to the fields below; use the workflow reference for limits. Dates: `YYYY-MM-DD`; fractional cents fail.
Keep `header.destinationKey` stable per ledger/account and `businessId` per event: together they prevent duplicate exports.
Download the existing Document again; never change those identities to evade the check. Authors own queries, joins, accounting
and approval logic. Grids rechecks current permissions before creation.

| Profile | Required header | Required mapping | Optional mapping |
| --- | --- | --- | --- |
| `datev-csv`, `version: 1` | `destinationKey`, `consultantNumber`, `clientNumber`, `fiscalYearStart`, `accountLength`, `periodStart`, `periodEnd`, `label`, `finalize` | `businessId`, `entryId`, `amount`, `direction`, `account`, `counterAccount`, `documentDate`, `documentNumber` | `text`, `taxKey`, `costCenter1`, `costCenter2` |
| `sepa-xml`, `version: 1` | `destinationKey`, `debtorName`, `debtorIban`, `executionDate`; optional `debtorBic` | `businessId`, `endToEndId`, `amount`, `creditorName`, `creditorIban`, `remittance` | `creditorBic` |

`closeRecord` follows the Table's mode: Direct finalizes; Four-eyes requests another eligible person's approval. Optional expected mode and policy revision pin a review. **Close selected Records** reviews up to 100 exact Records; its protected profile retains confirmed IDs instead of refreshing a View or query. Changed policy or changed/incomplete Records stop later steps and leave affected Records editable. The run shows completed steps and failures.

`createCorrectionDraft` links a new Draft to its finalized original and sets its type. `copyFields` copies up to 100 stored fields, including empty values and object-list inputs, but not unique fields, IDs, Files, Relations or calculations. Optional `values` supplies up to 100 explicit inputs, including required Relations; it overrides copies, never type/original. Relations need public IDs (`inputs.original.Customer.recordId`). `saveAs` names the result. Validation, permissions and current formulas apply. Replay returns the same Draft.

`createRecord` can copy selected inputs from an existing record in the same table: supply `copyFrom: inputs.original` with `copyFields: [Positions]`. Select up to 100 stored value fields. IDs, unique fields, files, relations and calculated fields cannot be copied. Object-list inputs are copied and their formulas recalculated. Explicit `values` override copies and retain normal write validation. The source remains unchanged; replaying the same workflow step returns the same new record. This option belongs to the standalone action, not entries inside `atomicRecords`.

The starter labels the action **Correction** or **Cancellation**; its run option must match. The selected single-select value stores that meaning. Both create linked Drafts for a person to complete, without reversing amounts, taxes or bookings or generating Documents.

`finalizeRecord` uses the table's generic Finalization contract: it validates the complete record, assigns final IDs, stores the final Durable History version, and permanently locks the record atomically. Retrying the same workflow step is safe. `updateRecord` and `createRecord` field keys accept exact field names or public IDs. If a table requires change context, `updateRecord.audit` must answer the applicable questions by their question UUID. `generateDocument.template` and `sendEmail.template` accept an enabled template exact name or public ID. Ambiguous and inaccessible references are rejected during validation.

The `generateDocument` result includes `business`, the stored company context of a record Document. For example, `${{ issued.business.legalName }}` reads the original issuer name; `${{ issued.business }}` can be copied to a JSON snapshot field for a correction. It never reads current Base settings. Query-generated Documents have `business: null`.

`deleteRecord` trashes one non-finalized Record, never destroys it. Permission, mutation-policy and required `audit` checks apply; `saveAs` returns its reference. Inside `atomicRecords.changes`, use `deleteRecord: {record, audit?}` to apply the same trash operation after locked checks; `saveAs` belongs to the standalone action.

**Four-eyes Finalization** cannot be bypassed by `finalizeRecord`: request it from the Record; a different current approver-group member approves. Direct mode instead permits writers to finalize through Workflows, API, CLI and Record actions.

### Commit related record changes together

`atomicRecords` commits bounded Grids changes together. Email, HTTP, document generation, other workflows and control flow belong in separate steps.

`validateDocuments: [{template, record}]` checks profile inputs after changes, before commit; failure rolls back finalization. HTML fails with `DOCUMENT_PROFILE_REQUIRED`. For finalized records with `oncePerFinalizedRecord`, it also reserves the document number and freezes the template, snapshot and render context (including `business`) in that transaction. A later `generateDocument` renders this reserved input; retries preserve it even after Base settings change. A committed reservation consumes its number even if generation never runs. The reservation fixes the filename and tags too; later generation options do not replace them. Other targets are validated without reservation. No PDF is rendered here. Dry run checks targets, not changed values.

:::reference
- **locks:** Record or record-list references, such as `inputs.item` or `inputs.items`, acquired in stable order before checks. Duplicates count once; explicit locks, change targets and `validateDocuments` targets together may include at most 100 distinct records. Empty lists add no locks. Every competing workflow must lock the same coordination record for the same business decision.
- **checks:** Choose `query: {source, parameters}` or `table` with 1–20 AND-combined `where` predicates (`field`, `op`, optional `value`/`caseInsensitive`). `assert: empty|notEmpty` tests row existence; optional `message` explains failure.
- **changes:** An ordered list of `createRecord`, `updateRecord`, `deleteRecord`, or `finalizeRecord` entries. Create uses `table` and non-empty `values`; optional `finalize: true` creates and finalizes the new Record in this transaction. It requires enabled direct Finalization. A failed finalization leaves no draft behind. Update uses `record`, non-empty `set`, optional `ifVersion`, and optional `audit` answers. Delete uses `record` and optional `audit` answers; its target is locked automatically, and it moves only mutable records to trash without destroying retained data. Finalize uses `record` and requires enabled direct Finalization; it does not bypass Four-eyes approval. Finalize after the required updates. A later rejected change rolls back the finalization too.
- **transaction:** Permissions and row scope are rechecked. Records, relations, audit, outbox and outcome commit together or roll back together.
:::

`finalizeRecord.record` accepts one Record reference, never a list or tree, including inside `changes`. Owned Object-list positions are part of that Record.

An empty query locks no row. Competing reservations must lock the same stable item before checking availability.

Formula/aggregate checks use `query: {source, parameters}`: typed GQL after locks, before changes (10,000 rows/5 MiB; no capture). Select violations with `where`/`having`, assert `empty`; a row containing `false`/`0` is not empty. Read changing amounts in GQL, not pre-resolved parameters; include proposed changes. Dry runs reserve nothing.

The `table`/`where` variant supports stored-field predicates only. Relation values in `createRecord` and `updateRecord`, and values for relation filters, use public Record IDs such as `${{ inputs.item.recordId }}`. Do not pass internal UUIDs, labels, or a whole record-reference object as a Relation value. Record targets and locks use the reference itself, such as `inputs.item`. Related records must remain readable in the configured target table and Base; dry run checks that boundary too.

**Reserve one available item atomically**

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
              Item: ${{ inputs.item.recordId }}
              Type: Active loan
```

Dry run evaluates the checks and validates every target without locking or mutating records. Its result is advisory: execution repeats the checks while the declared records are locked.

Each `sendEmail.to` item contains exactly one recipient: `email` resolves to an email address and `user` resolves to a Cloud user UUID. `httpRequest.headers` accepts at most 100 entries, each up to 1,000 characters; its URL is limited to 4,000 characters. The JSON request body and text response body are each limited to 64 KiB.

`httpRequest.method` accepts `GET`, `POST`, `PUT`, `PATCH`, or `DELETE`. It defaults to `POST`. Requests carry JSON only; use `json` for an optional structured body rather than encoding form data or arbitrary binary content. Grids sends an `Idempotency-Key` header derived from the run and the step, so a receiver that honours it can recognise a repeated attempt.

**Actions**

```yaml
inputs:
  item:
    type: record
    table: Items
    required: true
  priority:
    type: select
    options:
      - Low
      - Normal
      - High
  recipientEmail:
    type: text
    required: true
steps:
  - updateRecord:
      record: inputs.item
      set:
        Status: Available
        Last scanned at: ${{ now() }}
  - createRecord:
      table: Movements
      values:
        Item: ${{ inputs.item.recordId }}
        Type: Check-in
      saveAs: movement
  - generateDocument:
      template: Item label
      record: inputs.item
      filename: ${{ inputs.item.Name }}
      tags:
        - label
        - ${{ inputs.priority }}
      saveAs: labelRun
  - createDocumentLink:
      document: labelRun
      expiresIn: 30d
      comment: Workflow email link
      saveAs: labelLink
  - sendEmail:
      template: Label ready email
      to:
        - email: ${{ inputs.recipientEmail }}
      data:
        link: ${{ labelLink }}
        document: ${{ labelRun }}
      saveAs: emailResult
  - httpRequest:
      method: POST
      url: https://example.com/hooks/grids
      headers:
        X-App: Grids
      json:
        event: item.checked_in
        item: ${{ inputs.item }}
      timeoutMs: 15000
      saveAs: hook
  - setVariable:
      name: finishedAt
      value: ${{ now() }}
  - succeed:
      message: "${{ inputs.item.Name }} checked in."
```

## Control flow {icon="route"}

Control flow is still a normal step. That keeps nested behavior explicit and makes diagnostics point at the failing branch instead of guessing what the workflow meant.

:::reference
- **if:** Requires one condition and a non-empty `then` list. `else` is optional.
- **switch:** Requires a value and at least one `cases` entry. Every case has `when` and a non-empty `do` list. `default` is optional.
- **forEach:** Requires a raw `recordList` reference, an `as` identifier, and a non-empty `do` list. It preserves list order.
- **Value comparisons:** `equals` and `notEquals` take exactly two literal or dynamic values.
- **Text comparisons:** `textEquals`, `contains`, `startsWith`, and `endsWith` take two text values.
- **List membership:** `includes` takes a list and one exact value. Use it to check whether a record belongs to a relation list; `contains` is for text only.
- **Presence and nesting:** `exists` takes one raw value reference. `all` and `any` require at least one condition. `not` wraps one condition.
:::

**Branches and loops**

```yaml
inputs:
  item:
    type: record
    table: Items
    required: true
  items:
    type: recordList
    table: Items
    required: true
  priority:
    type: select
    options:
      - Low
      - Normal
      - High
steps:
  - if:
      equals:
        - ${{ inputs.item.Status }}
        - Loaned
    then:
      - updateRecord:
          record: inputs.item
          set:
            Status: Available
    else:
      - fail:
          message: Item is not currently loaned out.
  - switch: ${{ inputs.priority }}
    cases:
      - when: High
        do:
          - setVariable:
              name: queue
              value: urgent
    default:
      - setVariable:
          name: queue
          value: normal
  - forEach: inputs.items
    as: item
    do:
      - generateDocument:
          template: Item label
          record: item
```

**Recursive conditions**

```yaml
inputs:
  item:
    type: record
    table: Items
    required: true
  prefix:
    type: text
    required: true
steps:
  - if:
      all:
        - exists: inputs.item.Status
        - any:
            - equals:
                - ${{ inputs.item.Status }}
                - Loaned
            - startsWith:
                - ${{ inputs.item.Name }}
                - ${{ inputs.prefix }}
        - not:
            endsWith:
              - ${{ inputs.item.Name }}
              - Archived
    then:
      - succeed:
          message: Item matches.
    else:
      - fail:
          message: Item does not match.
```

## Values and references {icon="book-2"}

:::reference
- **Literal strings:** Plain strings are always literal values. Write `Checked`, URLs, email addresses, and dotted text directly when the workflow should use that exact text.
- **Dynamic values:** A dynamic value must be the whole `${{ ... }}` string. Use `${{ inputs.name }}`, append a record field such as `${{ inputs.item.Status }}`, use `${{ inputs.item.recordId }}` for the stable record public ID, read a saved value with `${{ savedValue }}`, or evaluate `${{ now() }}`. The expression language does not perform arithmetic, concatenate text, or call other functions.
- **Dedicated references:** Reference-only slots stay raw: `record: inputs.item`, `forEach: inputs.items`, `document: savedDocument`, and `exists: inputs.item.Field`. Do not wrap these slots in expression syntax.
- **Relation references:** A single relation field may fill any raw `record` slot, for example `record: inputs.asset.Current loan item`. A multiple relation field may fill `forEach`, for example `forEach: inputs.loan.Items`. Grids resolves the stored IDs to authorized records in the relation's target table and fails the run if a target is missing or inaccessible.
- **Scope:** Inputs are available for the whole run. `saveAs` and `setVariable` names are available only after their step. A `forEach` alias exists only inside its `do` steps; values created inside branches and loops do not escape that scope.
- **Result messages:** `succeed` and `fail` messages are literal text that may embed one or more expressions, for example `Processed ${{ inputs.item.Name }}`.
- **Structured values:** Lists and objects may contain literals and dynamic values recursively. This is useful for `set`, `values`, `data`, and `json`.
:::

:::note Saved output paths
Saved outputs expose structured paths. Documents provide `id`, `shortId`, `templateId`, `baseId`, `tableId`, `recordId`, `number`, `filename`, `createdAt`, `createdBy`, `tags`, and `primaryArtifactKey`. Document links provide `kind`, `id`, `url`, `expiresAt`, and `documentId`. Email results provide `subject`, `templateId`, and `recipients`; each recipient provides `id`, `deliveryId`, `kind`, `recipient`, and `status`. HTTP results provide `status`, `ok`, and `body`. Read them with expressions such as `${{ link.url }}`, `${{ emailResult.recipients }}`, or `${{ hook.status }}`.
:::

## Email templates {icon="file-description"}

Email templates are managed from the workflow page in Edit mode. They are base-level Liquid templates with a subject, HTML, stored sample data, and preview. A workflow step chooses one template and passes only the `data` that email needs. Sample data is used only by the editor preview; changing it does not affect sent messages.

:::reference
- **Template lookup:** `sendEmail.template` accepts an enabled email template exact name or public ID. Ambiguous names are rejected.
- **Recipients:** Use `email` for an email address value or `user` for a Cloud user id. Each entry must pick one recipient type.
- **Liquid roots:** Templates can read `data`, `app`, `business`, `workflow`, `run`, and `date`.
- **Preview data:** The template's sample-data JSON appears under `data`. Its nested keys also drive editor suggestions. App, business, workflow, run, and date examples are preview-only system values.
:::

**Send a generated document link**

```yaml
inputs:
  invoice:
    type: record
    table: Invoices
    required: true
  recipientEmail:
    type: text
    required: true
steps:
  - generateDocument:
      template: Invoice
      record: inputs.invoice
      saveAs: invoicePdf
  - createDocumentLink:
      document: invoicePdf
      expiresIn: 30d
      saveAs: invoiceLink
  - sendEmail:
      template: Invoice email
      to:
        - email: ${{ inputs.recipientEmail }}
      data:
        link: ${{ invoiceLink }}
        document: ${{ invoicePdf }}
```

**Email HTML**

```html
<p>Hello,</p>
<p>Your document is ready.</p>
<p><a href="{{ data.link.url }}">Download PDF</a></p>
<p>{{ business.legalName | default: app.name }}</p>
```

## Run modes and observability {icon="route"}

- `execute` performs effects on the pinned revision; `dryRun` records predicted effects without changes or external requests.
- Channels: `api` for direct UI/API/CLI; `customApp`, `scanner`, `bulk` for run options; `schedule`, `recordEvent` for automatic triggers.
- Run details show revision, inputs, timing, result/error, steps and Documents. Statistics count execute runs; dry-run failures remain in history.
- The workflow page shows schedule reconciliation, next execution or a persistent schedule problem, and active record-event/table bindings.
- Cloud administrators inspect initiating occurrences and individual external effects under **Observability → Workflows** or `cld admin workflows`.

Run statuses: `queued`, `running`, `waiting`, `succeeded`, `failed`, `canceled`, `needs_attention`.
Step statuses: `running`, `completed`, `waiting`, `failed`, `needs_attention`, `terminal`, `planned`, `unsupported`, `indeterminate`, `canceled`.

`terminal` is a stopping `succeed`, or `fail` in dry-run mode; execute-mode `fail` is `failed`.
`planned`, `unsupported` and `indeterminate` are dry-run results, not runtime failures.
Review predicted records, templates, recipient counts and HTTP hosts. Payloads remain hidden; a dry run cannot guarantee unchanged data, permissions or external systems later.

## Understand an interrupted run {icon="alert-triangle"}

Interrupted runs resume from recorded outcomes, not from the beginning:

- Record changes and `createDocumentLink` commit atomically with their recorded outcome; committed changes are not repeated.
- `generateDocument` and `sendEmail` reuse their run/step identity, preventing duplicate Documents and recipient deliveries.
- `setVariable`, `succeed`, `fail` and control flow have no external effects and can be reevaluated.
- An `httpRequest` without a complete response may already have reached its receiver. Grids stops with `needs_attention`, rather than retrying or claiming failure. Check the receiving system before starting a new run. Prefer receivers that honor `Idempotency-Key`.

## Permissions and limits {icon="shield-lock"}

:::reference
- **Run permission:** Direct calls and standalone run options require Base Write. A published Grids App may invoke only its exact included launcher, and public visitors cannot run Workflow actions.
- **Identity:** Direct calls (channel `api`), scanners and bulk use the caller; App grants require a signed-in user, not a service account. Schedules/events use the owner's current groups. Events record the triggering user without inheriting their rights.
- **Action permission:** Raw runs use Base permissions. App grants, publication, inputs, launcher and `availableWhen` are rechecked before effects. `atomicRecords` checks once after acquiring locks; its own changes do not invalidate that step. Later effects check again. Enforce starting state with atomic checks. App Workflows may use all tables in their Base, not only visible ones. Base admins own business restrictions and export disclosure.
- **App result:** Actions poll their own run: `running`, `succeeded` or `failed`. `fail.message` and atomic `checks[].message` reach readers verbatim: write safe recovery instructions. Other errors get safe hints, never internal details or raw history.
- **Email delivery:** Email template management requires base admin access. Workflow runs can use enabled email templates without exposing template HTML in autocomplete.
- **Email-template dependencies:** Grids shows which workflows use an email template and refuses to delete a referenced template. Change those workflows first.
- **HTTP guardrails:** Only public internet addresses are allowed. Private, local or reserved targets are rejected, including hostnames resolving to both public and private addresses. No setting or allowlist enables internal network calls.
- **HTTP limits:** `httpRequest` limits request and response bodies to 64 KiB, applies the configured timeout to the complete request including target resolution, and rejects credentials embedded in the URL. Connection and transfer headers cannot be overridden.
:::

One workflow may declare at most 100 inputs and 1,000 steps across all branches and loops. Control flow and recursive conditions may each be nested 20 levels deep, with at most 1,000 conditions. A `recordList`, bulk selection, or `forEach` loop can contain at most 10,000 records. Workflow YAML itself is limited to 200,000 characters.

## Scanner example {icon="point"}

Use the record input and update action above. For returns, check that `inputs.item.Status` is `Loaned` before changing it to `Available`; otherwise stop with `fail`. Use `atomicRecords` when competing writes must be checked and committed together.

:::note Scanner run option
Add a scanner run option that maps `item` to a scanned record. Choose generated scan-code resolution or configure a unique field such as `Label code`. The option remains outside this YAML.
:::

## Bulk document example {icon="file-description"}

**Bulk document workflow YAML**

```yaml
inputs:
  items:
    type: recordList
    table: Items
    required: true
steps:
  - forEach: inputs.items
    as: item
    do:
      - generateDocument:
          template: Item label
          record: item
```

:::note Bulk run option
Add a bulk run option for the `items` record-list input. The option can supply an explicit selection or the current row-shaped query without adding a trigger to YAML.
:::
