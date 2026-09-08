---
id: grids-workflows
title: Workflows
icon: ti ti-route
description: Automate repeatable work with typed inputs, safe actions, and observable runs.
order: 140
---
Workflows carry out repeatable operations in Grids. Use one when a person or event should run the same checked sequence of record changes, document generation, email delivery, or JSON HTTP requests.

A workflow is more than a hidden automation. It has typed inputs, a reviewed YAML definition, permissions, a published revision history, and a run history that shows what happened at each step. Every run pins the revision it started on, so editing a workflow never changes a run that is already in flight.

## Decide whether to use a workflow {icon="route"}

For agents, `workflow.record-actions` discovers configured correction/cancellation Draft actions and their expected revisions. `workflow.record-action` creates a linked Draft for one finalized original with explicit approval and an idempotency key. The original remains unchanged; no document is issued or sent. Reuse the key only for retries of the same request. Follow the returned run reference with `workflow.run.read`; acceptance is not completion. These capabilities do not author workflows, supply arbitrary extra inputs or run bulk selections. Use the CLI for those tasks, other workflow kinds and App-only runtime actions.

Use a normal field or formula when you only need to store or calculate one value. Use a form when you only need guided record creation. Use a workflow when the operation has several steps, must be run consistently, needs a scanner or bulk action, contacts another system, or needs an observable success or failure.

A small workflow is preferable to a large one with unrelated branches. Give it one outcome-oriented name, such as **Return item** or **Send approved invoice**.

## Create and test a first workflow {icon="route"}

The normal Name and Description fields explain the workflow to users. YAML defines only executable behavior: inputs, optional automatic triggers, and steps.

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

| Root key | Shape | Purpose |
| --- | --- | --- |
| `inputs` | Object keyed by input name | Declares values supplied when a run starts |
| `triggers` | Object keyed by trigger kind | Starts runs automatically and binds trigger values to inputs |
| `steps` | Non-empty list | Executes actions and control flow in order |

Input names, `saveAs` names, `setVariable.name`, and `forEach.as` aliases are identifiers: start with a letter or underscore, then use only letters, digits, and underscores. Names are case-sensitive. A saved name cannot reuse an input, another saved value, a loop alias, or the reserved roots `inputs`, `trigger`, `bindings`, and `context`.

Each action step contains exactly one action. Control-flow steps use their documented keys, such as `if` with `then` and optional `else`. Unknown root keys, input properties, trigger properties, action fields, and control-flow keys are errors. The editor reports them with a line and column rather than ignoring them.

YAML maps must not repeat a key. Indentation defines nesting, so use spaces consistently and keep sibling properties aligned. Quote a value when it must remain text but looks like `true`, `false`, `null`, or a number. Quote cron expressions so their spaces and `*` characters remain one clear value.

## How runs start {icon="square-plus"}

Everything that starts an execute run is an **event**: something happened, Grids records that occurrence, and the workflow's published revision decides whether to answer it. There are four kinds.

:::reference
- **Run requested:** Someone asked for this workflow directly — from the workflow page, the authenticated API, or the CLI.
- **Run option used:** A scanner, bulk action, or Grids App button started it.
- **Schedule fired:** A scheduled slot came due.
- **Record changed:** A row was created, updated, or deleted in a table this workflow watches.
:::

A run exists only when the workflow's published revision is listening for that event. Publishing always listens for **Run requested** and **Run option used** — being runnable is not a trigger anyone writes — and additionally for **Schedule fired** or **Record changed** when the YAML declares those triggers. Disabling the workflow stops every one of them, direct invocation included.

This is why an occurrence that nothing is listening for produces no run at all rather than a failed one: nothing was ever accepted. A schedule that fires while the workflow is disabled, or a record change that arrives before its trigger was published, leaves no run to open.

A **dry run is not an event**. Nothing happened; somebody is asking what would. It is created directly against the workflow's newest published revision and never consults a trigger, which is why a disabled workflow can still be dry-run while its execute runs are refused.

Scanner, bulk, Record, and Grids App run options are saved separately and remain outside workflow YAML. One workflow can therefore have several named surfaces without duplicating its executable definition. A scanner maps one input to scanned text or a resolved record and can collect other inputs once before scanning, after every scan, or from fixed values. Bulk supplies one record-list input. A Record option runs from one open Record. A Grids App option either keeps fixed values for one-click use or asks for the declared inputs when it runs.

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

Every input has `type`. Optional `label` and `description` text appears in generated controls. `required: true` rejects a missing value; omitting `required` makes the input optional.

| Type | Run value | Additional declaration |
| --- | --- | --- |
| `record` | One record public ID | Required `table` exact name or public ID |
| `recordList` | Ordered list of record public IDs, at most 10,000 | Required `table` exact name or public ID |
| `text` | String | None |
| `number` | Finite number | None |
| `boolean` | `true` or `false` | None |
| `date` | Date in `YYYY-MM-DD` format | None |
| `dateTime` | ISO date-time | None |
| `select` | String equal to one configured option | Required `options` list with 1–200 values |

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
| `closeRecord` | `record` | `expectedMode`, `expectedPolicyRevision` | Predicts Direct Finalization or a Four-eyes request from the Table's current policy |
| `createCorrectionDraft` | `original`, `typeField`, `typeValue`, `originalField` | `intent` (`correction` default), `copyFields` | Validates the finalized original and predicts one linked Draft |
| `finalizeRecord` | `record` | None | Validates Write access and predicts one permanent finalization |
| `updateRecord` | `record`, non-empty `set` | `audit` answers keyed by audit-question UUID | Validates and predicts the record update |
| `createRecord` | `table`, non-empty `values` | `saveAs` | Validates and predicts the new record |
| `atomicRecords` | 1–100 `locks`, 1–50 `checks`, 1–50 `changes` | Check `message`; update `ifVersion` and `audit` | Evaluates current checks and predicts the bounded record changes without locking or writing |
| `generateDocument` | `template`, `record` | `filename`, up to 20 `tags`, `saveAs` | Validates access and values; does not generate |
| `createDocumentLink` | `document` output reference | `expiresIn` (`1d`, `7d`, `30d`, `90d`; default `30d`), `comment`, `saveAs` | Validates the document and access; does not create a link |
| `sendEmail` | `template`, 1–50 `to` recipients | `data` with up to 200 keys, `saveAs` | Validates template, recipients, data, and access; does not send |
| `httpRequest` | Absolute HTTP or HTTPS `url` | `method` (default `POST`), `headers`, `json`, `timeoutMs` (default 15,000; range 1,000–60,000), `saveAs` | Resolves and checks the target; does not send |
| `setVariable` | `name`, `value` | None | Stores the planned value in the current scope |
| `succeed` | `message` | None | Stops planning with a successful terminal result |
| `fail` | `message` | None | Stops planning with the failure that execution would produce |

`closeRecord` follows the Table's current Finalization mode: Direct mode finalizes the Record, while Four-eyes mode creates an exact request for another eligible person. The optional expected mode and policy revision can pin a prior review. The **Close selected Records** starter reviews and closes up to 100 exact Records at once. Its protected profile ensures that the confirmed public Record IDs are never replaced by a later View or query result and a policy change stops later steps. Records are rechecked when each step runs; a changed or incomplete Record stops the run and remains editable. Open the run to see completed steps and the exact failure.

`createCorrectionDraft` keeps the finalized original unchanged and creates one normal editable Record in the same Table. It sets one existing single-select value and one existing single self-relation to the original. `copyFields` may name up to 100 current stored value fields whose values are carried over. An explicitly selected empty value stays empty; defaults apply only to unselected fields. Unique fields, generated IDs, Files, other Relations, calculated fields, and Documents are not copied. Normal Number Series, mutation policy, access, Durable History, Documents, and later Finalization still apply. Replaying the same workflow operation returns the same Draft instead of creating a duplicate.

The starter asks whether people should see a **Correction** or **Cancellation** action and stores that intent in both the workflow and its run option. Grids rejects a mismatched run option, so cancellation wording cannot front a correction workflow. The selected single-select value remains the stored business meaning. A cancellation still creates an ordinary linked Draft that a person completes. Grids does not infer reversed amounts, taxes, or counter-bookings or generate a Document.

`finalizeRecord` uses the table's generic Finalization contract: it validates the complete record, assigns final IDs, stores the final Durable History version, and permanently locks the record atomically. Retrying the same workflow step is safe. `updateRecord` and `createRecord` field keys accept exact field names or public IDs. If a table requires change context, `updateRecord.audit` must answer the applicable questions by their question UUID. `generateDocument.template` and `sendEmail.template` accept an enabled template exact name or public ID. Ambiguous and inaccessible references are rejected during validation.

When a Table requires **Four-eyes Finalization**, a generic `finalizeRecord` workflow action cannot bypass it. A person requests Finalization from the Record, and a different current member of the configured approver group approves through the Finalization request. Switch the Table to Direct mode only when writers should again be able to finalize through ordinary Workflows, API, CLI, and Record actions.

### Commit related record changes together

Use `atomicRecords` when a current Grids condition and several record writes must succeed together. It accepts only Grids record work: it cannot send email, call HTTP, generate documents, run another workflow, or contain control flow.

:::reference
- **locks:** Existing record references acquired in stable order before any check runs. Every competing workflow must lock the same coordination record for the same business decision.
- **checks:** Each check selects one bound table and 1–20 bound field predicates in `where`. Predicates use `field`, `op`, optional `value`, and optional `caseInsensitive`, and are combined with AND. `assert` is `empty` or `notEmpty`; optional `message` replaces the default failure text.
- **changes:** An ordered list of `createRecord` or `updateRecord` entries. Create uses `table` and non-empty `values`. Update uses `record`, non-empty `set`, optional `ifVersion`, and optional `audit` answers.
- **transaction:** Grids rechecks current permissions and row scope, locks every coordination and update record, evaluates every check, then commits records, relations, audit entries, event outbox rows, and the workflow outcome together. A failed check or change rolls all of it back.
:::

An empty query has no row of its own to lock. For a reservation, lock the shared item (or another stable coordination record), then check that no active reservation references it. If competing workflows lock different records, the transaction cannot serialize that business decision for them.

Atomic checks support stored fields, not Formula fields or aggregate arithmetic. Check the stored facts that establish your decision under the same lock. Relation values in `createRecord` and `updateRecord`, and values for relation filters, use public Record IDs such as `${{ inputs.item.recordId }}`. Do not pass internal UUIDs, labels, or a whole record-reference object as a Relation value. Record targets and locks use the reference itself, such as `inputs.item`. Related records must remain readable in the configured target table and Base; dry run checks that boundary too.

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
              Item: ${{ inputs.item }}
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
        Item: ${{ inputs.item }}
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
Saved outputs expose structured paths. Documents provide `id`, `templateId`, `baseId`, `tableId`, `recordId`, `number`, `filename`, `createdAt`, `createdBy`, `tags`, `renderer`, `validationStatus`, and `artifacts`. Document links provide `kind`, `id`, `url`, `expiresAt`, and `documentId`. Email results provide `subject`, `templateId`, and `recipients`; each recipient provides `id`, `deliveryId`, `kind`, `recipient`, and `status`. HTTP results provide `status`, `ok`, and `body`. Read them with expressions such as `${{ link.url }}`, `${{ emailResult.recipients }}`, or `${{ hook.status }}`.
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

:::reference
- **execute:** Runs the pinned revision, changes records, generates documents, starts email delivery, and sends external requests.
- **dryRun:** Plans the workflow, checks current references and permissions, and records predicted effects without applying changes or sending external requests.
- **Channels:** Direct UI, API, and CLI calls use `api`. Run options use `customApp`, `scanner`, or `bulk`. Automatic triggers use `schedule` or `recordEvent`.
- **Run detail:** Inspect revision, channel, mode, input, start and finish times, duration, result message or structured error, each step outcome, and generated documents.
- **Automatic triggers:** The workflow page shows whether a schedule is reconciled and its next run, or which record event and table are active. A degraded schedule includes a persistent problem description.
- **Run statistics:** The counts and error rate above the run list cover execute runs in the selected window. Dry-run failures stay visible in run history without making real execution look unhealthy.
:::

A run and a step do not share a vocabulary. Both lists are complete:

:::reference
- **Run statuses:** `queued`, `running`, `waiting`, `succeeded`, `failed`, `canceled`, `needs_attention`.
- **Step statuses:** `running`, `completed`, `waiting`, `failed`, `needs_attention`, `terminal`, `planned`, `unsupported`, `indeterminate`, `canceled`.
:::

`terminal` marks the step that stopped the run: a `succeed` in either mode, and a `fail` in a dry run. A `fail` in an execute run reads `failed` instead, because it is one. `planned`, `indeterminate`, and `unsupported` only ever appear in a dry run — `planned` is a step that was described rather than performed, and the other two say the plan could not be decided, not that anything went wrong at run time.

:::note Dry runs are recorded
A dry run is a normal observable run with mode `dryRun`. Its step report describes the records, templates, recipient counts, and HTTP hosts that execution would affect without exposing request payloads. Review every predicted effect; a dry run does not prove that a later execute run will see unchanged records, permissions, or external systems.
:::

The workflow page covers the runs in this base, which is what a workflow author needs. Two things live one level up, with a Cloud administrator: the occurrence that caused each run, and the individual external effects a run performed. Both are under **Observability → Workflows** in Cloud administration, and in `cld admin workflows`. Ask for them when a run's own detail does not explain what started it or what escaped it.

## Understand an interrupted run {icon="alert-triangle"}

A run that is interrupted — a restart, a lost connection, a worker replaced mid-step — is resumed from the outcomes already recorded rather than started again. What that means for a step depends on the kind of effect the action performs, and it is the reason a run can end `needs_attention` instead of simply failing.

:::reference
- **Record changes:** `finalizeRecord`, `updateRecord`, `createRecord`, `atomicRecords`, and `createDocumentLink` commit their work and the record of it together. An interruption means the change did not happen, so resuming performs it once.
- **Documents and email:** `generateDocument` and `sendEmail` are keyed to the run and the step. Resuming after an interruption does not generate a second document or send a recipient a second copy.
- **HTTP requests:** `httpRequest` is the one action nothing can verify afterwards. If a request left Grids and no complete response came back, the outcome is genuinely unknown.
- **Decisions and variables:** `setVariable`, `succeed`, `fail`, and the control-flow steps perform no external effect and are simply re-evaluated.
:::

An `httpRequest` whose outcome is unknown is not retried and not reported as a failure. Repeating it is how a receiver is charged twice or a webhook fires twice; calling it a failure would claim it did not arrive. Instead the step ends `needs_attention` and the run stops there, so a person decides. Check the receiving system, then start a new run if the request has to be made again.

Because of that, an `httpRequest` inside a workflow is worth pointing at a receiver that tolerates a repeated `Idempotency-Key`. That turns the ambiguous case into a safe one.

## Permissions and limits {icon="shield-lock"}

:::reference
- **Run permission:** Direct calls and standalone run options require Base Write. A published Grids App may invoke only its exact included launcher, and public visitors cannot run Workflow actions.
- **Caller run identity:** Direct UI, API, and CLI calls plus scanner and bulk run options run as the user or service account that starts them. Grids App run options use the authenticated user's identity; Grids App grants do not support service accounts. Direct calls appear under the api channel.
- **Automatic run identity:** Schedules and record events run as the workflow owner with the owner's current groups. A record event keeps the user who changed the record in trigger metadata, but does not inherit that user's permissions.
- **Action permission:** Raw runs use the owning Base permission. Grids App invocation rechecks the immutable app capability and `availableWhen` rule on the server; workflow preconditions still protect state that can change after the run starts.
- **App result:** The invoking App action may poll only its own run and receives `running`, `succeeded`, or `failed` plus the workflow's sanitized result message. It does not gain access to generic run history or raw errors.
- **Email delivery:** Email template management requires base admin access. Workflow runs can use enabled email templates without exposing template HTML in autocomplete.
- **Email-template dependencies:** Grids shows which workflows use an email template and refuses to delete a referenced template. Change those workflows first.
- **HTTP guardrails:** `httpRequest` reaches public internet addresses only. A URL naming a private, local, or otherwise reserved address is refused, and so is a hostname that resolves to one — including a name that also resolves to a public address. There is no allowlist and no setting that opens this up; a service inside your network cannot be called from a workflow.
- **HTTP limits:** `httpRequest` limits request and response bodies to 64 KiB, applies the configured timeout to the complete request including target resolution, and rejects credentials embedded in the URL. Connection and transfer headers cannot be overridden.
:::

One workflow may declare at most 100 inputs and 1,000 steps across all branches and loops. Control flow and recursive conditions may each be nested 20 levels deep, with at most 1,000 conditions. A `recordList`, bulk selection, or `forEach` loop can contain at most 10,000 records. Workflow YAML itself is limited to 200,000 characters.

These are validation and execution boundaries, not recommended design targets. Split a workflow before it approaches them so one run still has one understandable purpose.

## Scanner example {icon="point"}

**Scanner workflow YAML**

```yaml
inputs:
  item:
    type: record
    table: Items
    required: true
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
            Last scanned at: ${{ now() }}
      - succeed:
          message: "${{ inputs.item.Name }} returned."
    else:
      - fail:
          message: "${{ inputs.item.Name }} is not currently loaned out."
```

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
