---
id: grids-custom-app-pages-blocks
title: Grids App pages & blocks
icon: ti ti-layout-grid
description: Compose responsive pages from typed, resource-backed blocks.
order: 134
---
A Grids App is a small composition of existing Grids resources. Its page tree controls layout and navigation; its blocks control which resources appear and which already-defined operations a person may start.

## Use stable definition IDs {icon="id"}

Apps, pages, rows, columns, blocks, and actions have stable IDs. Labels may change without breaking links or state.

- The app ID is one immutable 6-character public ID.
- Page, row, column, block, and action IDs are lowercase local identifiers unique inside their parent.
- Resource references use canonical Grids public IDs, never display names.

A page route is `/apps/<id>/<pageId>`. Declared page parameters are query parameters, for example `/apps/a1b2c3/request?request_id=<record-id>`.

App identity is intentionally restrained to a name and supported icon. Pages and blocks use standard Cloud typography, spacing, colors, and interaction patterns. Custom CSS and arbitrary branding are not part of the definition.

## Declare page context {icon="brackets"}

A page declares every URL parameter before a block can use it. This release supports required Record parameters only. Each parameter declares one table in the same Base; its URL and `@params.<name>` value are record public IDs, and the server verifies that the referenced record belongs to that table before loading page data.

A page may load one **page record** from a Record parameter. In the visual builder, add the parameter ID and Record table under **Route parameters**, then add a Record or Rendered HTML block; Grids binds that same parameter automatically instead of exposing a second Page Record control. The load is permission-checked and fail-closed. An invalid, missing, deleted, or inaccessible record shows the page's standard unavailable state without disclosing which case occurred.

A route-only page may instead keep the declared Record parameter as context without rendering that record. Records GQL and Form fixed values can then reuse the same authorized parent ID. Pages with required parameters never appear in navigation and cannot be the app's start page. The visual builder therefore disables **Add record parameter** on the current start page and explains that another parameter-free page must become the start page first.

Implemented blocks bind contextual record values through a typed reference:

```yaml
source: PARAMS
path: request_id
```

| Source | Available in | Example path |
| --- | --- | --- |
| `PARAMS` | Current page | `request_id` |
| `RECORD` | Current page record | `id` |
| `ROW` | One Records row link or row action | `id` |
| `RESULT` | Form success navigation | `recordId` |

The builder shows only references valid in the current location. YAML validation applies the same scope and type rules. References cannot read arbitrary URL values, another block's internal state, or undeclared data.

## Build responsive rows and columns {icon="columns"}

Each page contains rows; each row contains columns; each column contains blocks. A column span is an integer from 1 to 12. Columns keep their order and stack to full width when the available space is too narrow.

Use the simplest layout that preserves task order:

- 12 for one primary task;
- 8 + 4 for main content and supporting context;
- 6 + 6 for two peers;
- several small columns for compact metrics.

Do not encode separate desktop and mobile layouts. Check the same draft at wide and narrow workspace widths before publication.

## Configure resource-backed blocks {icon="blocks"}

### Markdown

Markdown renders headings, lists, links, and safe images. It does not run HTML, scripts, styles, or embedded application code. The inline and large editors autocomplete the current page's `@auth`, `@params`, `@page`, `@app`, `@base`, and `@time` placeholders. For example, `Hello @auth.name` inserts the signed-in display name on the server; anonymous auth values become empty text. Inserted values are escaped before Markdown rendering, and there are no Liquid conditions or loops.

### Records

Records reads either an existing saved view or an inline GQL query. A saved View can use an explicit table field selection or reuse that View's existing Cards configuration, including its file cover. Cards may be read-only, navigate to a row page, or expose row actions, and are pinned with the saved View when the App is published. Inline GQL displays its selected ordinary-record columns, including aliases. A non-empty table `columnIds` list may keep selected field columns available to behavior while showing only the listed field IDs. Use Metrics or Chart for aggregate results. Both Records sources support empty copy, optional row navigation, and optional server-side search.

`pageSize` controls how many rows the server returns at once. Readers move through protected cursor pages; search and pagination run on the server and never load the full result into the browser. A GQL `limit` caps the complete result when the author intentionally wants only the first N matching rows. Shared query budgets remain enforced independently.

An inline query receives typed `@auth.id`, `@auth.name`, `@auth.username`, `@auth.email`, `@auth.subjects`, `@params`, `@page`, `@app`, `@base`, and `@time` context automatically. `@auth.subjects` contains the signed-in user UUID plus effective group UUIDs and is empty for anonymous readers. Values are bound separately from query text. Unknown namespaces and undeclared page parameters fail publication.

Use `ROW.id` only for that Records block's row link or workflow row actions. A row link may instead bind `{ source: ROW, path: relation, fieldId: ... }` when the field is a selected single relation to the destination parameter's table. A row action is rechecked against the exact published query result before its workflow starts. Configure up to six actions with a required accessible label and an optional icon; tables and Cards may show the label, the icon, or both.

### Referenced records

Referenced records is available only on a Record page. It shows rows from one pinned source table whose pinned Relation field contains the current page record. Choose the exact displayed fields, table or Cards presentation, search, page size, and optional row workflows in the block. Publication compiles this into the same bounded GQL and `recordQueries` capability used by Records; the App grant remains the outer access gate. It does not expand the page record or expose an unrestricted reverse lookup.

### Metrics and Chart

Metrics and Chart read either an existing saved view or an inline GQL query. The runtime applies shared query budgets.

Metrics accepts an ungrouped aggregate query and renders up to 12 named scalar results. Chart accepts a grouped aggregate query and renders a donut, bar, or line chart with at least one aggregate value series. A Chart block may render at most 100 groups through its `limit`.

The published capability records the exact tables and fields behind the block. App readers need no Base access, and the runtime cannot query sources outside that immutable capability. Republish after changing a saved View's source.

### Form

Form references one existing Grids form. The form owns visible fields, validation, required inputs, defaults, and record creation.

The block may supply trusted values to any user-input field. Use `LITERAL` for a validated fixed value. Compatible relation fields may use a declared Record `PARAMS` value or the current page `RECORD.id`. A Principal field may use `AUTH.currentUser` to assign the signed-in person without displaying another picker. Supplied inputs are omitted from the rendered Form, resolved again by the server, and cannot be overridden by the browser. This supports flows such as “add another article to this list” without asking for the same relation again.

After success, the block may stay on the page or replace-navigate inside the same app. Navigation parameters may preserve declared `PARAMS` values or use the created Form record's `RESULT.recordId`.

One app may publish up to 24 Form blocks. Each referenced Form may expose up to 100 inputs, of which up to 30 may be supplied by the page.

### Record

Record requires a page record. It renders the explicit `fieldIds` list and may allow direct editing through an explicit `editableFieldIds` subset. Every editable field must also be displayed and must be a writable stored field; computed and system fields fail publication.

The Edit action appears only when the publication includes that writable field and the block is available. Submission rechecks the app grant, immutable field allowlist, `availableWhen`, live field type, table audit questions, and current record version. Fields outside the block's editable subset remain read-only.

An editable File field uses the same audited Add, atomic Replace, and **Remove from record** lifecycle as the Base workspace. The App grant remains the outer gate and the published editable-field capability narrows it further. Removal detaches the current attachment; protected history or artifacts may retain the exact bytes, while unprotected files may be cleaned up.

An optional `documents.templateIds` allowlist shows existing generated PDFs linked to the current record. Every template must belong to the page record table when the app is published. The runtime uses the immutable capability and protected document download route. The block does not generate documents or create public links; use a Workflow for generation.

### Rendered HTML

Rendered HTML requires a page record and references exactly one `html_template` field from that record's table. It displays the field's already rendered value without exposing sibling record fields. Choose `compact`, `normal`, or `large` height; the iframe does not resize itself from template content.

The output runs in a sandbox without scripts, forms, popups, parent-page access, or pointer interaction. A deny-by-default content policy also blocks remote images, fonts, media, frames, connections, and navigation; only inline styles and `data:` images are available. Use a Record, Form, or Actions block for interactions. Changing the field type, removing the field, or a template render failure produces a local unavailable state and never falls back to raw HTML in the app page.

### Comments

Comments requires a page record and a signed-in App reader. It loads a bounded first page only when the block is rendered, then fetches older comments with keyset pagination. The published Comments block and current App grant authorize creating comments without Base or record Write access. Authors may edit and delete their own comments; Base administrators may moderate any comment. Deleted comments remain as a timestamped placeholder so the conversation order stays understandable.

Comments inherit record visibility. They do not introduce a separate audience or permission store.

### Actions

Actions contains buttons that either navigate inside the same Grids App or start an existing enabled Grids App workflow launcher. A workflow action may bind JSON `LITERAL` values, declared Record `PARAMS`, or the current page `RECORD.id` to compatible workflow inputs. Fixed launchers use their stored bindings and do not accept action inputs.

The block cannot call arbitrary URLs, update records directly, or invoke a workflow that was not included in the published capability set.
Starting a workflow is asynchronous. The button follows its scoped run and reports the sanitized workflow result message when it succeeds or fails. It never exposes generic workflow history or raw errors. Navigation after a workflow belongs in the workflow or a later page-state transition; Actions does not bind arbitrary workflow results.

The runtime revalidates the published app grant, exact page, block, action, launcher, workflow revision, page records, and `availableWhen` query. An action missing from the immutable publication capability set is omitted. Workflow actions require an authenticated account.

### Scanner

Scanner embeds one existing enabled Scanner run option. Signed-in app readers may scan with the camera or enter a code manually; public anonymous readers see a sign-in prompt instead. Session values are asked once when the scanner opens, and after-scan values are asked for each code.

The app publishes the exact block, launcher, workflow revision, and scanner configuration hash. Every invocation and status read rechecks that snapshot and the reader's App grant. Changing the run option or workflow requires republishing the app. Scanner run results stay scoped to the reader who started them.

Scanner blocks support scalar session and after-scan inputs. Record and record-list prompts remain available on the full Workflow scanner, but are rejected for an embedded App scanner because an App reader may not have direct Base access for a record picker. The scanned input itself may still resolve to a record through a generated scan code or configured unique field.

## Keep navigation explicit {icon="arrow-right"}

Navigation has a target page ID, history behavior, and a mapping for every target parameter:

```yaml
kind: navigate
pageId: request
history: push
params:
  request_id: { source: ROW, path: id }
```

Use `push` for normal movement and `replace` after a successful create operation. A navigation target is valid only when all required target parameters are supplied with compatible types.

For repeated entry, preserve the parent as a page parameter:

```text
/apps/<id>/add-article?list_id=<record-id>
```

The Form fixes its List relation from `PARAMS.list_id`. After success, one button navigates back to the same page with the same parameter; another navigates to the list detail. This needs no app-specific batch or wizard primitive.

## Enforce availability with GQL {icon="adjustments"}

A page, block, Form, or action may declare one `availableWhen.query`. The server supplies the same implicit context as data queries and considers the resource available only when the bounded query returns at least one row.

```yaml
availableWhen:
  query: |
    from table "Certificate requests"
    where record.id = @params.request_id and Status = 'Submitted'
    limit 1
```

An empty result, invalid query, missing context, timeout, or cancellation means unavailable. The runtime omits the resource, does not execute its data source, and rechecks the guard before every Form submission or action invocation. Browser visibility is never the enforcement boundary.

In the visual builder, optional availability stays collapsed until you add a rule. Its summary says **Always**, **Custom rule**, or **Needs attention**. Edit short queries in the inspector or choose **Open large editor** for the same automatically saved draft value. Both editors use only the implicit context available on the selected page; the raw GQL console deliberately does not offer Grids App `@…` context.

## Design local states {icon="info-circle"}

Every data-backed block owns its local loading, empty, and recoverable error state. Standard denied and unavailable states are supplied by Grids and deliberately do not reveal whether a resource or record exists.

Customize empty copy only when it can tell the person what to do next. Do not replace a local empty state with a page-wide spinner or make unrelated blocks wait for one slow source.

Only the active page resolves. Within that request, identical authorized resource reads are deduplicated and every source remains bounded.

## Know the deliberate limits {icon="barrier-block"}

The first release has no app-global variables, general expression graph, reusable block definitions, arbitrary external fetch or action targets, cross-base resources, raw queries outside GQL, inline app-authored HTML, CSS, JavaScript, Liquid control flow, or domain-specific request, cart, batch, or loan blocks. A Rendered HTML block may only select an existing HTML template field; its template and CSS remain owned and validated by that field. Sanitized Markdown may still contain ordinary links and the documented request-context placeholders.

Compose repeated flows from typed page parameters, fixed Form values, bounded sources, navigation, and existing Workflows. If those primitives cannot express a process safely, extend the owning Grids resource rather than adding application-specific behavior to the page runtime.

Continue with [Publish & permissions](/app/grids/help/grids-publish-custom-app) before making the app available to others.
