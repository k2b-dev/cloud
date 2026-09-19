---
id: grids-custom-app-pages-blocks
title: Grids App pages & blocks
icon: ti ti-layout-grid
description: Compose responsive pages from typed, resource-backed blocks.
order: 134
---
A Grids App arranges existing resources into pages and exposes selected operations through blocks.

## Set up pages and layout {icon="layout-grid"}

Use stable IDs, not labels, for links. A page URL is `/apps/<id>/<pageId>`; declared Record parameters go in the query string. The [API reference](/app/grids/help/grids-custom-app-api) lists ID rules, layout limits and every binding shape.

This release supports required Record parameters only. Each parameter declares a table in the same Base; its URL and `@params.<name>` value are record public IDs.

Under **Route parameters**, choose a parameter ID and its table. Adding a Record or Rendered HTML block binds that parameter automatically. A route-only page can also use the authorized parameter in GQL or fixed Form values without displaying the record. Required-parameter pages stay out of navigation and cannot be the start page. Missing or inaccessible records show the standard unavailable state.

Pages contain rows, columns and blocks: width 12 for one task, 8 + 4 for main content and context, 6 + 6 for peers. Columns stack on narrow screens; check both widths before publishing.

Keep the next action beside the information needed to perform it. Use a dialog for a short task opened by a button; leave a Form embedded when readers should work in it alongside the page's context.

For secondary information, give any block `disclosure: { label: "More details" }`. Readers open its heading to see the content; `defaultOpen: true` starts it expanded. In the Builder, configure this under **Progressive disclosure**. Collapsing a block does not defer loading or change permissions. Use `availableWhen` to control availability.

## Configure resource-backed blocks {icon="blocks"}

### Markdown

Markdown renders headings, lists, links, and safe images. It does not run scripts or embedded application code. The inline and large editors autocomplete the current page's `@auth`, `@params`, `@page`, `@app`, `@base`, and `@time` placeholders. For example, `Hello @auth.name` inserts the signed-in display name on the server; anonymous auth values become empty text. Inserted values are escaped before Markdown rendering, and there are no Liquid conditions or loops.

In a published App, use Cloud notice cards for short explanations or warnings. Add them inside an ordinary Markdown block; no new block type is needed:

```markdown
:::info Payments to confirm
Check the entries against your bank transactions. Only confirmed payments change the outstanding amount.
:::
```

Supported tones are `note`, `info`, `success`, `warning`, and `danger`. Write the title after the tone in the App's language. Published Markdown is sanitized on the server; scripts and unsafe links are removed. The editor keeps the Markdown source and context-placeholder highlighting.

### Records

Records reads either an existing saved view or an inline GQL query. A saved View can use an explicit table field selection or reuse that View's existing Cards configuration, including its file cover. Cards may be read-only, navigate to a row page, or expose row actions, and are pinned with the saved View when the App is published. Inline GQL displays its selected ordinary-record columns, including aliases. A non-empty table `columnIds` list may keep selected field columns available to behavior while showing only the listed field IDs. Use Metrics or Chart for aggregate results. Both Records sources support empty copy, optional row navigation, and optional server-side search.

An empty table result shows the block title and empty text inline. Empty search results keep the table and search controls so readers can change the search. Loading and error states remain distinct from an empty result.

For table presentation, `display.relativeDateColumnIds` adds “today”, “tomorrow”, or a calendar-day distance beside the absolute date. Only date-only columns qualify. Labels use the configured time zone; they do not classify an entry as overdue.

Use `display.mobile: { titleColumnId, detailColumnIds }` to choose a row heading and its supporting values on narrow screens. Wider screens retain the table. Both presentations use the same row links, workflow actions, search, and pagination. Presentation references must point to visible columns: public field IDs for a saved View, unique output labels from the query preview for GQL. Each reference must be unique within its date list or mobile configuration.

`pageSize` controls how many rows the server returns at once. Readers move through protected cursor pages; search and pagination run on the server and never load the full result into the browser. A GQL `limit` caps the complete result when the author intentionally wants only the first N matching rows. Shared query budgets remain enforced independently.

An inline query receives typed `@auth.id`, `@auth.name`, `@auth.username`, `@auth.email`, `@auth.subjects`, `@params`, `@page`, `@app`, `@base`, and `@time` context automatically. `@auth.subjects` contains the signed-in user UUID plus effective group UUIDs and is empty for anonymous readers. Values are bound separately from query text. Unknown namespaces and undeclared page parameters fail publication.

Use `ROW.id` only for that Records block's row link or workflow row actions. A row link may instead bind `{ source: ROW, path: relation, fieldId: ... }` when the field is a selected single relation to the destination parameter's table. A row action is rechecked against the exact published query result before its workflow starts. Configure up to six actions with a required accessible label and an optional icon; tables and Cards may show the label, the icon, or both.

### Referenced records

Referenced records is available only on a Record page. It shows rows from one pinned source table whose pinned Relation field contains the current page record. Choose the exact displayed fields, table or Cards presentation, search, page size, and optional row workflows in the block. Publication compiles this into the same bounded GQL and `recordQueries` capability used by Records; the App grant remains the outer access gate. It does not expand the page record or expose an unrestricted reverse lookup.

### Metrics and Chart

Metrics and Chart read either an existing saved view or an inline GQL query. The runtime applies shared query budgets.

Metrics normally infer number formatting from selected fields. For aggregate expressions without field metadata, set a common `valueFormat`, such as `{ style: "number", decimalPlaces: 2, unit: "EUR" }`. This explicit override applies to every value in the block; Grids does not infer a currency from the query. It changes display only, preserving exact calculation values.

Metrics accepts an ungrouped aggregate query and renders up to 12 named scalar results. Chart accepts a grouped aggregate query and renders a donut, bar, or line chart with at least one aggregate value series. A Chart block may render at most 100 groups through its `limit`.

The published capability records the exact tables and fields behind the block. App readers need no Base access, and the runtime cannot query sources outside that immutable capability. Republish after changing a saved View's source.

### Form

Form owns inputs, validation, defaults, and creation. App readers can select related records without Base access: search exposes only IDs and published presentable labels from the configured target. Changing those labels or their formula dependencies requires republishing.

A Form is embedded by default. Set `presentation.kind` to `dialog` and choose a button label to open it over the current page. The same defaults, fixed values, validation, and permissions apply. Readers must confirm before discarding unsaved input and cannot close the dialog while it is saving.

Dialog buttons fit their content. Choose `presentation.variant: primary` for the main next action or `secondary` (the default) for a supporting action.

For example, on a page bound to a bill, this block opens a payment form with the bill already assigned. Replace the example IDs with your Form and relation field IDs:

```yaml
id: record-payment
type: form
formId: PayFrm
presentation:
  kind: dialog
  label: Record payment
  icon: plus
  variant: primary
fixedValues:
  BillFk:
    source: RECORD
    path: id
```

Choose **Form action → Edit this page's record** to edit an existing draft. The page must bind a record from the Form's table. The server loads its inputs and configured inline rows before rendering; saving checks the versions of the parent and edited rows together. Removing an inline row detaches it from the parent, but does not delete the underlying record. Shared rows and finalized records cannot be edited this way. Related tables must belong to the same Base. Existing Form blocks keep creating new records unless you change this action and publish the App again.

The block may supply trusted values to any user-input field. Use `LITERAL` for a validated fixed value. Compatible relation fields may use a declared Record `PARAMS` value or the current page `RECORD.id`. A Principal field may use `AUTH.currentUser` to assign the signed-in person without displaying another picker. Supplied inputs are omitted from the rendered Form, resolved again by the server, and cannot be overridden by the browser. This supports flows such as “add another article to this list” without asking for the same relation again.

Forms linked to saved-state actions through `actionsBlockId` must stay embedded, so workflow status remains visible. They cannot use dialog presentation.

After success, an embedded Form may stay on the page. A dialog closes and refreshes its originating page. An explicit `onSuccessNavigate` takes precedence and replace-navigates inside the same app. Navigation parameters may preserve declared `PARAMS` values or use the created Form record's `RESULT.recordId`.

One app may publish up to 24 Form blocks. Each referenced Form may expose up to 100 inputs, of which up to 30 may be supplied by the page.

#### Forms with context

A form linked through `actionsBlockId` shows its inputs beside the live summary
and next actions. Both use the same draft. The final configured computed field is
shown first as the headline value. Missing inputs can be focused directly; primary
actions stay disabled until inputs are valid and saved. Saving reloads the confirmed
record. Server-side checks remain authoritative.

The optional `workspace` object accepts `summaryTitle`, `summaryDescription`,
`helpTitle`, and `helpText`. Put infrequent background information in the help
section. This option requires an Actions block and cannot be used in a dialog.

A record heading may use `heading.title` while the record is editable. Its heading
field becomes the subtitle. An issued document number takes precedence, and
finalized records never use the draft title.

### Record

Record requires a page record. It renders the explicit `fieldIds` list and may allow direct editing through an explicit `editableFieldIds` subset. Every editable field must also be displayed and must be a writable stored field; computed and system fields fail publication.

Choose `layout: grid` (the default), `rows` for paired labels and values, or `compact` for short metadata. Use `summary` for totals: values align to the end and the final row is emphasized. Put the total last in `fieldIds`.

Read-only Object lists occupy a framed, rounded table within the block. The field name and row count share its toolbar. Secondary columns remain under additional details and longer lists are split into pages.

Add a subset of the displayed field IDs to `relativeDates` to annotate date-only values, for example `17.09.2026 (today)`. The absolute value remains visible. Date-time fields are not supported; duplicate fields or fields outside `fieldIds` fail validation.

Use `heading: { fieldId }` to identify a record with one of its displayed fields, such as a customer or subject. The field moves into the heading instead of appearing twice. With `heading: { fieldId, documentNumber: true }` and a `documents` template allowlist, an existing document number becomes the heading and the field stays visible below it. Drafts keep their field heading unless `heading.title` provides a task heading. Document downloads stay visible as labeled buttons.

The Edit action appears only when the publication includes that writable field and the block is available. Submission rechecks the app grant, immutable field allowlist, `availableWhen`, live field type, table audit questions, and current record version. Fields outside the block's editable subset remain read-only.

An editable File field uses the same audited Add, atomic Replace, and **Remove from record** lifecycle as the Base workspace. The App grant remains the outer gate and the published editable-field capability narrows it further. Removal detaches the current attachment; protected history or artifacts may retain the exact bytes, while unprotected files may be cleaned up.

`documents.templateIds` shows linked documents from templates belonging to the page record's table. Downloads are protected; issuance requires a Workflow. Optional draft previews require an explicit grant: see [the API reference](/app/grids/help/grids-custom-app-api). This block creates no public links.

### Rendered HTML

Rendered HTML requires a page record and references exactly one `html_template` field from that record's table. It displays the field's already rendered value without exposing sibling record fields. Choose `compact`, `normal`, or `large` height; the iframe does not resize itself from template content.

The output runs in a sandbox without scripts, forms, popups, parent-page access, or pointer interaction. A deny-by-default content policy also blocks remote images, fonts, media, frames, connections, and navigation; only inline styles and `data:` images are available. Use a Record, Form, or Actions block for interactions. Changing the field type, removing the field, or a template render failure produces a local unavailable state and never falls back to raw HTML in the app page.

### Comments

Comments requires a page record and a signed-in App reader. It loads a bounded first page only when the block is rendered, then fetches older comments with keyset pagination. The published Comments block and current App grant authorize creating comments without Base or record Write access. Authors may edit and delete their own comments; Base administrators may moderate any comment. Deleted comments remain as a timestamped placeholder so the conversation order stays understandable.

Comments inherit record visibility. They do not introduce a separate audience or permission store.

### Actions

Actions contains buttons that either navigate inside the same Grids App or start an existing enabled Grids App workflow launcher. A workflow action may bind JSON `LITERAL` values, declared Record `PARAMS`, or the current page `RECORD.id` to compatible workflow inputs. Fixed launchers use their stored bindings and do not accept action inputs. For a short task, choose **Ask in dialog** for unbound scalar inputs. The dialog uses workflow labels and validation, submits once, and refreshes the page after success. Keep the current record bound by the server. On an uncertain response, check the same operation again rather than submitting a new one. Optional guidance and a success message describe the task in user terms.

The block cannot call arbitrary URLs, update records directly, or invoke a workflow that was not included in the published capability set.
Starting a workflow is asynchronous. The button follows its scoped run and reports the sanitized workflow result message when it succeeds or fails. It never exposes generic workflow history or raw errors. Navigation after a workflow belongs in the workflow or a later page-state transition; Actions does not bind arbitrary workflow results.

The runtime revalidates the published app grant, exact page, block, action, launcher, workflow revision, page records, and `availableWhen` query. An action missing from the immutable publication capability set is omitted. Workflow actions require an authenticated account.

#### Background document actions

Set a workflow action's `background` to `{ acceptedMessage, documentBlockId,
documentTemplateId }` for a document created from the page record. The referenced
Record block must expose that template without an availability condition. One
background document page has one result template; several actions may create it.
The configured message appears after acceptance, and the user can keep working.

The action recovers its status after navigation or reload and opens the stored
file when ready. If the exact ready document is already shown in an authorized,
visible Record block, the duplicate completion action is omitted. Otherwise, the
ready action stays available. Concurrent requests for the same published action, page records,
and inputs join the active run, including requests from another authorized App
reader. Readers see document state, not another user's workflow inputs, outputs,
or raw errors. Administrator attention disables another start.

A table Records block with `workflowStatus: true` shows these states beside its
rows. It requires direct `ROW.id` navigation to the document's unconditional
Record page. The list remains paginated and searchable. The runtime refreshes
visible running entries; it does not wait for completion before showing the page.

### Scanner

Scanner embeds one existing enabled Scanner run option. Signed-in app readers may scan with the camera or enter a code manually; public anonymous readers see a sign-in prompt instead. Session values are asked once when the scanner opens, and after-scan values are asked for each code.

The app publishes the exact block, launcher, workflow revision, and scanner configuration hash. Every invocation and status read rechecks that snapshot and the reader's App grant. Changing the run option or workflow requires republishing the app. Scanner run results stay scoped to the reader who started them.

Scanner blocks support scalar session and after-scan inputs. Record and record-list prompts remain available on the full Workflow scanner, but are rejected for an embedded App scanner because an App reader may not have direct Base access for a record picker. The scanned input itself may still resolve to a record through a generated scan code or configured unique field.

## Keep navigation explicit {icon="arrow-right"}

Use normal push navigation between pages and replacement navigation after Form success. Every target parameter needs a compatible binding. For repeated entry, keep the parent in a declared page parameter and bind the Form relation to it.

The [API reference](/app/grids/help/grids-custom-app-api) lists the exact navigation and success-binding shapes.

## Enforce availability with GQL {icon="adjustments"}

A page, block, Form, or action may declare one `availableWhen.query`. The server supplies the same implicit context as data queries and considers the resource available only when the bounded query returns at least one row.

```yaml
availableWhen:
  query: |
    from table "Certificate requests"
    where record.id = @params.request_id and Status = 'Submitted'
    limit 1
```

Empty results or query errors omit the resource and data source. Submission, invocation and Workflow effects recheck guards, grants, launcher and publication. `atomicRecords` checks once after locks; its own changes do not invalidate that step. Later effects check again. Enforce starting state with atomic checks.

In the visual builder, optional availability stays collapsed until you add a rule. Its summary says **Always**, **Custom rule**, or **Needs attention**. Edit short queries in the inspector or choose **Open large editor** for the same automatically saved draft value. Both editors use only the implicit context available on the selected page; the raw GQL console deliberately does not offer Grids App `@…` context.

## Design local states {icon="info-circle"}

Blocks show their own loading, empty and error states. Give empty states a useful next step; do not block the whole page. Unavailable states never reveal whether a record exists. Only the active page loads, with bounded sources and deduplicated authorized reads.

## Know the deliberate limits {icon="barrier-block"}

The first release has no app-global variables, general expression graph, reusable block definitions, arbitrary external fetch or action targets, cross-base resources, raw queries outside GQL, inline app-authored HTML, CSS, JavaScript, Liquid control flow, or domain-specific request, cart, batch, or loan blocks. A Rendered HTML block may only select an existing HTML template field; its template and CSS remain owned and validated by that field. Sanitized Markdown may still contain ordinary links and the documented request-context placeholders.

Compose repeated flows from typed page parameters, fixed Form values, bounded sources, navigation, and existing Workflows. If those primitives cannot express a process safely, extend the owning Grids resource rather than adding application-specific behavior to the page runtime.

Continue with [Publish & permissions](/app/grids/help/grids-publish-custom-app) before making the app available to others.

Use `layout: "context"` on a Record block for a compact related-record surface, such as the original document.
