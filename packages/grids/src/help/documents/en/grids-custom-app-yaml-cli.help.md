---
id: grids-custom-app-yaml-cli
title: Grids App YAML & CLI
icon: ti ti-terminal-2
description: Validate, plan, apply, export, and publish the canonical app definition.
order: 136
---
The visual builder and CLI read and write the same typed Grids App definition. YAML is its lossless human-readable serialization. It composes existing Grids resources and the capabilities exposed by one publication; it does not duplicate Base data or define child-resource permissions.

## Build resources before the app {icon="building-factory-2"}

A complete solution still has one owner for each concern. Use the existing `cld grids` commands to create or update the base, tables, fields, views, forms, document templates, workflow launchers, and access bindings. Read those resources back with `--json` and use their canonical IDs in the Grids App definition.

The deterministic agent sequence is:

1. inspect the current base and the installed Grids references;
2. create or update the required resources through their existing commands;
3. configure Base access for administrators and Grids App access for its audience;
4. write the app-only YAML with the returned canonical IDs;
5. validate, plan, and apply the app draft;
6. open the saved draft and exercise the complete journey with real test accounts for each intended audience;
7. publish only after the plan and journey checks pass.

Grids App YAML is deliberately not a whole-base bundle. A second table, workflow, or permission schema would duplicate existing APIs, create conflicting owners, and make partial updates harder to reason about. An agent may keep several ordinary input files beside the app YAML, but it applies each file through the command that owns that resource.

## Start from the machine reference {icon="book-2"}

Ask the CLI for the installed schema and supported block contracts:

```bash
cld grids apps reference --json
```

Agents should read this reference before generating a definition. The server remains authoritative for the installed schema version, accessible resources, field types, and launcher inputs.

For a guided start, create the same blank Home draft as the visual **New app** action, then export and edit it. Advanced authors can skip this and apply a complete definition directly:

```bash
cld grids apps create MyBase --name "Certificate requests" --json
cld grids apps export MyBase "Certificate requests" --out certificate-app.yaml
```

## Use one strict root document {icon="file-code"}

Every definition has this shape:

```yaml
schemaVersion: 5
kind: grids.custom-app
id: app001
baseId: bas001
name: Certificate requests
icon: certificate
startPageId: home
sidebar:
  actions: []
pages:
  - id: home
    title: Home
    navigation: { visible: true }
    parameters: {}
    rows:
      - id: content
        columns:
          - id: main
            span: 12
            blocks:
              - id: intro
                type: markdown
                markdown: "# Certificate requests"
```

| Key | Contract |
| --- | --- |
| `schemaVersion` | Required integer. Unsupported versions fail validation. |
| `kind` | Must be `grids.custom-app`. |
| `id` | Required 6-character public ID. Supplying it makes create/apply idempotent. |
| `baseId` | Required 6-character public ID of the one owning base. It cannot be changed later. |
| `name` | Required visible name. |
| `icon` | Optional supported icon name. |
| `startPageId` | Required local ID of an existing page. |
| `sidebar.actions` | Optional ordered app-global Form launchers. Fixed values accept `LITERAL` and compatible Principal fields also accept `AUTH.currentUser`. Availability has no page or params context. |
| `pages` | At least one page. |

Malformed YAML fails in the CLI before any request is sent. The strict schema rejects unknown keys, duplicate IDs, invalid public IDs, and values of the wrong type.

## Define pages and layout {icon="layout-grid"}

```yaml
pages:
  - id: request
    title: Request detail
    navigation:
      visible: false
    parameters:
      request_id:
        type: record
        tableId: tbl001
        required: true
    record:
      tableId: tbl001
      id: { source: PARAMS, path: request_id }
    rows:
      - id: body
        columns:
          - id: main
            span: 8
            blocks: []
          - id: context
            span: 4
            blocks: []
```

Local IDs use lowercase letters, numbers, and hyphens. Column spans are integers from 1 to 12 and may not exceed 12 within one row.

## Bind typed values {icon="brackets"}

Bindings are discriminated values:

```yaml
# A constant
{ source: LITERAL, value: Submitted }

# A declared page parameter
{ source: PARAMS, path: list_id }

# The authorized page record
{ source: RECORD, path: id }

# The current Records result row
{ source: ROW, path: id }

# A selected single relation from the current row, for row navigation
{ source: ROW, path: relation, fieldId: res301 }

# The operation that just succeeded
{ source: RESULT, path: recordId }
```

Each property declares which sources and target type it accepts. Validation resolves referenced resource schemas and rejects incompatible bindings before apply or publish.

## Define blocks {icon="blocks"}

All blocks require a local `id` and `type`. Blocks may support an optional `title` and `availableWhen`; Records, Referenced records, and Record additionally support `emptyText`. A `referenced_records` block is valid only on a Record page and pins `sourceTableId`, `relationFieldId`, `fieldIds`, `display`, `searchable`, `pageSize`, and optional `rowActions`. The installed machine reference is authoritative for each block type.

```yaml
# Guidance
- id: intro
  type: markdown
  markdown: |
    ## Request a certificate
    Hello @auth.name. Tell us what the certificate should cover.

# Existing saved view
- id: requests
  type: records
  searchable: true
  pageSize: 25
  source:
    kind: view
    viewId: res401
  display:
    kind: table
    columnIds:
      - res301
  rowNavigate:
    kind: navigate
    pageId: request
    history: push
    params:
      request_id: { source: ROW, path: id }
  rowActions:
    - id: approve-row
      label: Approve request
      icon: check
      showLabel: true
      kind: workflow
      launcherId: res701
      inputs:
        request_id: { source: ROW, path: id }
# Bounded inline query
- id: totals
  type: metrics
  source:
    kind: gql
    query: |
      from table "Certificate requests"
      aggregate count(*) as requests

# Grouped and bounded chart
- id: requests-by-state
  type: chart
  title: Requests by state
  chartType: bar
  source:
    kind: gql
    query: |
      from table "Certificate requests"
      group by "State"
      aggregate count(*) as requests
  limit: 20

# Existing form with server-fixed context
- id: request-form
  type: form
  formId: res501
  fixedValues: {}
  onSuccessNavigate:
    kind: navigate
    pageId: request
    params:
      request_id: { source: RESULT, path: recordId }

# Current page record with a permitted direct-edit subset
- id: request
  type: record
  fieldIds:
    - res301
  editableFieldIds:
    - res301
  documents:
    templateIds:
      - res601

# Existing HTML template field on the current page record
- id: equipment-card
  type: html
  fieldId: res701
  height: normal

# Comments on the current page record
- id: discussion
  type: comments

# Navigation and enabled workflow launchers
- id: actions
  type: actions
  actions:
    - id: approve
      label: Approve and generate
      icon: certificate
      kind: workflow
      launcherId: res701
      inputs:
        request_id: { source: RECORD, path: id }
```

`documents.templateIds` is an exact publication allowlist for existing generated PDFs. It does not generate a document; point an Actions block at a Workflow launcher when generation is part of the flow.

Metrics and Chart read a saved view or bounded inline GQL. Metrics requires ungrouped aggregates. Chart derives its categories and values from grouped aggregate output and declares one of `donut`, `bar`, or `line`. Refer to `apps reference --json` for the exact installed contract.

Inline GQL automatically receives `@auth`, declared `@params`, `@page`, `@app`, `@base`, and `@time` context. Unknown namespaces and undeclared page parameters fail validation. Values are bound separately from query text and are never interpolated into it.

Autocomplete can derive those exact keys from a saved draft page without enabling them in the raw query console:

```bash
cld grids gql autocomplete MyBase \
  --app "Certificate requests" \
  --page request \
  --query 'where @' \
  --caret 7 \
  --json
```

Use a standalone Actions block for page-level navigation and workflows. Use `rowActions` for up to six workflows that act on one Records or Referenced records result row in either table or Cards presentation. Cards may instead be read-only or only navigate; no separate card action model exists. Every row action has a required accessible label, may hide that label only when it has an icon, and may bind `ROW.id` to a compatible record input. Row navigation may instead bind one selected single-relation field to a compatible target page parameter. Form validation and submission behavior remain owned by the referenced Form.

Pages, blocks, Forms, and actions may declare one server-enforced availability query:

```yaml
availableWhen:
  query: |
    from table "Certificate requests"
    where record.id = @params.request_id and Status = 'Submitted'
    limit 1
```

At least one returned row means available. An empty result, invalid query, missing context, timeout, or cancellation means unavailable. The runtime omits unavailable resources and rechecks Forms and actions immediately before execution.

## Validate and plan {icon="list-check"}

```bash
cld grids apps validate MyBase --source-file certificate-app.yaml --json
cld grids apps plan MyBase --source-file certificate-app.yaml --json
cld grids apps apply MyBase --source-file certificate-app.yaml --dry-run --json
```

`validate` checks schema, IDs, references, types, query bounds, navigation, and block invariants without writing. `plan` runs the same compiler and also compares the definition with the saved draft. Its deterministic output contains the action, concrete changes, diagnostics, and the derived publication capabilities.

`apply --dry-run` is a convenience spelling of that same plan operation. It returns the same `CustomAppPlan` and never calls the apply endpoint, so agents can use one final command shape before removing `--dry-run`.

A missing or inaccessible resource is an error, not a guessed name match. Plans never publish or invoke app operations.

Diagnostics use stable definition paths such as `pages[request].rows[detail].columns[request].blocks[actions].actions[approve].launcherId`. Fix the first owning path, validate again, and only then review the new plan. Agents must not suppress an error by removing an access-sensitive block or weakening its resource scope unless the builder explicitly requested that product change.

## Apply without publishing {icon="database-import"}

```bash
cld grids apps apply MyBase --source-file certificate-app.yaml --json
```

`apply` creates or updates the draft identified by the supplied app public ID. Applying the same canonical definition again is a no-op and does not create another app. It never changes the published snapshot.

Use `plan` or `apply --dry-run` to observe the `noop` result explicitly. A subsequent ordinary `apply` of that definition leaves the stored app and its update timestamp unchanged.

The command runs as the signed-in Cloud account and requires Base Admin. It cannot grant itself Base or Grids App access.

## Export and review {icon="file-export"}

```bash
cld grids apps export app001 \
  --out certificate-app.yaml
cld grids apps export app001 \
  --published \
  --out certificate-app-live.yaml
```

Export emits canonical key ordering, canonical public resource IDs, and no secrets. A visual-builder edit followed by export must retain the same semantics as a CLI edit followed by apply.

## Publish {icon="rocket"}

```bash
cld grids apps publish app001 --yes --json
```

Publish reruns preflight and replaces the published snapshot only when it succeeds. It is an explicit state change and requires `--yes` in non-interactive use.

Restore discards pending draft changes and copies the live definition back into the draft. Unpublish removes only the live snapshot and keeps the draft. Delete moves the app out of normal listings and removes its live route. These destructive commands require `--yes`:

```bash
cld grids apps restore app001 --yes --json
cld grids apps unpublish app001 --yes --json
cld grids apps delete app001 --yes --json
```

The command surface is:

```text
apps reference|list|create|get|validate|plan|apply|export|publish|unpublish|restore|delete
```

Use [Publish & permissions](/app/grids/help/grids-publish-custom-app) to review the access boundary before an agent publishes an app.
