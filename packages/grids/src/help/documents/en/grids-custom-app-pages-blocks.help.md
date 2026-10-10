---
id: grids-custom-app-pages-blocks
title: Grids App pages & blocks
icon: ti ti-layout-grid
description: Compose responsive pages from typed blocks that use existing resources.
order: 134
---
A Grids App arranges existing resources into pages. Its blocks decide which resources appear and which defined operations a person can start.

## Set up pages and layout {icon="layout-grid"}

Use stable IDs, not labels, for links. A page URL is `/apps/<id>/<pageId>`. Declared Record parameters go in the query string. The [Custom App API reference](/app/grids/help/grids-custom-app-api) lists the ID rules, the layout limits, and every binding shape.

This release supports required Record parameters only. Each parameter declares a table in the same Base; its URL and `@params.<name>` value are record public IDs.

Under **Route parameters**, choose a parameter ID and its table. Adding a Record or Rendered HTML block binds that parameter automatically. A route-only page can also use the authorized parameter in GQL or in fixed form values without displaying the record. Pages with required parameters stay out of the navigation and cannot be the start page. Missing or inaccessible records show the standard unavailable state.

Pages contain rows, columns, and blocks. Use width 12 for one task, 8 + 4 for main content and context, and 6 + 6 for peers. On narrow screens, columns stack in the same order. Check both widths before you publish. You need no separate mobile layout.

Keep the next action next to the information that it needs. Use a dialog for a short task that a button opens. Keep a form embedded when people work in it together with the context of the page.

For secondary information, give any block `disclosure: { label: "More details" }`. Readers open its heading to see the content. `defaultOpen: true` starts it expanded. In the builder, configure this under **Progressive disclosure**. Collapsing a block does not defer loading and does not change access. Use `availableWhen` to control availability.

## Configure blocks {icon="blocks"}

### Markdown

Markdown renders headings, lists, links, and safe images. It runs no scripts and no embedded code. The inline and the large editor autocomplete the `@auth`, `@params`, `@page`, `@app`, `@base`, and `@time` placeholders of the current page. For example, `Hello @auth.name` inserts the display name of the signed-in person on the server. Anonymous auth values become empty text. Grids escapes inserted values before it renders the Markdown, and there are no Liquid conditions or loops.

In a published app, use Cloud notice cards for short explanations or warnings. Add them inside an ordinary Markdown block. No new block type is needed:

```markdown
:::info Payments to confirm
Check the entries against your bank transactions. Only confirmed payments change the outstanding amount.
:::
```

The supported tones are `note`, `info`, `success`, `warning`, and `danger`. Write the title after the tone, in the language of the app. The server sanitizes published Markdown and removes scripts and unsafe links. The editor keeps the Markdown source and the highlighting of context placeholders.

### Records

Records reads an existing saved view or an inline GQL query.

- A saved view can use an explicit selection of table fields, or reuse the Cards configuration of that view, including its file cover.
- Cards can be read-only, navigate to a row page, or offer row actions. Publishing pins them with the saved view.
- Inline GQL displays its selected ordinary-record columns, including aliases. A non-empty table `columnIds` list can keep selected field columns available to behavior while it shows only the listed field IDs.
- Use Metrics or Chart for aggregate results.

Both sources support empty text, optional row navigation, and optional server-side search. An empty table result shows the block title and the empty text inline. Empty search results keep the table and the search controls, so readers can change the search. Loading and error states stay distinct from an empty result.

For the table presentation, `display.relativeDateColumnIds` adds “today”, “tomorrow”, or a distance in calendar days next to the absolute date. Only date-only columns qualify. The labels use the configured time zone. They do not mark an entry as overdue.

Use `display.mobile: { titleColumnId, detailColumnIds }` to choose a row heading and its supporting values on narrow screens. Wider screens keep the table. Both presentations use the same row links, workflow actions, search, and pagination. These references must point to visible columns: public field IDs for a saved view, and unique output labels from the query preview for GQL. Each reference must be unique within its date list or mobile configuration.

`pageSize` controls how many rows the server returns at once. Readers move through protected cursor pages. Search and pagination run on the server and never load the full result into the browser. A GQL `limit` caps the complete result when the author wants only the first N matching rows. Shared query budgets stay enforced independently.

An inline query receives the typed context `@auth.id`, `@auth.name`, `@auth.username`, `@auth.email`, `@auth.subjects`, `@params`, `@page`, `@app`, `@base`, and `@time` automatically. `@auth.subjects` contains the UUID of the signed-in user and the UUIDs of their effective groups. It is empty for anonymous readers. Grids binds the values separately from the query text. Unknown namespaces and undeclared page parameters fail the publication.

Use `ROW.id` only for the row link or the workflow row actions of that Records block. A row link can bind `{ source: ROW, path: relation, fieldId: ... }` instead, when the field is a selected single relation to the table of the destination parameter. Before its workflow starts, Grids checks a row action again against the exact published query result. Configure up to six actions, each with a required accessible label and an optional icon. Tables and Cards can show the label, the icon, or both.

### Referenced records

Referenced records is available only on a Record page. It shows rows from one pinned source table whose pinned relation field contains the current page record. In the block, choose the exact displayed fields, a table or Cards presentation, search, page size, and optional row workflows. Publishing compiles this into the same bounded GQL and `recordQueries` capability that Records uses. Access to the app stays the outer gate. The block does not expand the page record and does not expose an unrestricted reverse lookup.

### Metrics and Chart

Metrics and Chart read an existing saved view or an inline GQL query. The runtime applies shared query budgets.

Metrics normally take the number formatting from the selected fields. For aggregate expressions without field metadata, set a common `valueFormat`, such as `{ style: "number", decimalPlaces: 2, unit: "EUR" }`. This override applies to every value in the block. Grids does not infer a currency from the query. The format changes only the display and keeps the exact calculated values.

- Metrics accepts an ungrouped aggregate query and shows up to 12 named scalar results.
- Chart accepts a grouped aggregate query and shows a donut, bar, or line chart with at least one series of aggregate values. A Chart block shows at most 100 groups through its `limit`.

Bar and line charts show the optional x-axis and y-axis labels. Donut charts ignore them. Category names and axis labels that do not fit beside or below the chart are shortened. Hover over one to see it in full. With more than 12 groups, the chart shows at most 12 evenly spaced names.

The published capability records the exact tables and fields behind the block. People who use the app need no access to the Base. The runtime cannot query sources outside that immutable capability. Publish again after you change the source of a saved view.

### Form

The form owns the inputs, validation, defaults, and creation. People who use the app can select related records without access to the Base. The search exposes only IDs and the published presentable labels of the configured target. Changing those labels, or their formula dependencies, requires a new publication.

A form is embedded by default. Set `presentation.kind` to `dialog` and choose a button label to open it over the current page. The same defaults, fixed values, validation, and access rules apply. Readers must confirm before they discard unsaved input. They cannot close the dialog while it saves.

Dialog buttons fit their content. Choose `presentation.variant: primary` for the main next action, or `secondary` (the default) for a supporting action.

For example, on a page bound to a bill, this block opens a payment form with the bill already assigned. Replace the example IDs with the IDs of your form and relation field:

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

Choose **Form action → Edit this page's record** to edit an existing draft. The page must bind a record from the table of the form. The server loads its inputs and configured inline rows before rendering. Saving checks the versions of the parent and of the edited rows together. Removing an inline row detaches it from the parent. It does not delete the underlying record. Shared rows and finalized records cannot be edited this way. Related tables must belong to the same Base. Existing form blocks keep creating new records until you change this action and publish the app again.

The block can supply trusted values to any user-input field:

- Use `LITERAL` for a validated fixed value.
- Compatible relation fields can use a declared Record value from `PARAMS` or the `RECORD.id` of the current page.
- A principal field can use `AUTH.currentUser` to assign the signed-in person without showing another picker.

Supplied inputs are left out of the rendered form. The server resolves them again, and the browser cannot override them. This supports flows such as “add another article to this list” without asking for the same relation again.

Forms linked to saved-state actions through `actionsBlockId` must stay embedded, so the workflow status stays visible. They cannot use the dialog presentation.

After success, an embedded form can stay on the page. A dialog closes and refreshes the page that opened it. An explicit `onSuccessNavigate` takes precedence and navigates inside the same app, replacing the history entry. Navigation parameters can keep declared `PARAMS` values or use `RESULT.recordId` of the created form record.

One app can publish up to 24 form blocks. Each referenced form can expose up to 100 inputs. The page can supply up to 30 of them.

#### Show a form with context

A form linked through `actionsBlockId` shows its inputs next to the live summary and the next actions. Both use the same draft. The last configured computed field appears first, as the headline value. You can jump to missing inputs directly. Primary actions stay disabled until the inputs are valid and saved. Saving reloads the confirmed record. The server-side checks stay authoritative.

The optional `workspace` object accepts `summaryTitle`, `summaryDescription`, `helpTitle`, and `helpText`. Put rarely needed background information in the help section. This option requires an Actions block and cannot be used in a dialog.

A record heading can use `heading.title` while the record is editable. Its heading field then becomes the subtitle. An issued document number takes precedence. Finalized records never use the draft title.

### Record

Record requires a page record. It shows the explicit `fieldIds` list. It can allow direct editing through an explicit `editableFieldIds` subset. Every editable field must also be displayed and must be a writable stored field. Computed and system fields fail the publication.

Choose a layout:

- `grid` (the default);
- `rows` for paired labels and values;
- `compact` for short metadata;
- `summary` for totals: values align to the end, and the last row is emphasized. Put the total last in `fieldIds`;
- `context` for a compact related record, such as the original document.

Read-only object lists use a framed, rounded table inside the block. The field name and the row count share its toolbar. Secondary columns stay under additional details. Longer lists are split into pages.

Add a subset of the displayed field IDs to `relativeDates` to annotate date-only values, for example `17.09.2026 (today)`. The absolute value stays visible. Date-time fields are not supported. Duplicate fields, or fields outside `fieldIds`, fail validation.

Use `heading: { fieldId }` to identify a record with one of its displayed fields, such as a customer or a subject. The field moves into the heading and does not appear twice. With `heading: { fieldId, documentNumber: true }` and a `documents` template allowlist, an existing document number becomes the heading, and the field stays visible below it. Drafts keep their field heading unless `heading.title` provides a task heading. Document downloads stay visible as labeled buttons.

The Edit action appears only when the publication includes that writable field and the block is available. On submission, Grids checks these again: the access to the app, the immutable field allowlist, `availableWhen`, the live field type, the audit questions of the table, and the current record version. Fields outside the block's editable subset remain read-only.

An editable file field uses the same audited lifecycle as the Base workspace: add, atomic replace, and **Remove from record**. Access to the app stays the outer gate, and the published editable-field capability narrows it further. Removing detaches the current attachment. Protected history or artifacts can keep the exact bytes. Grids can clean up unprotected files.

`documents.templateIds` shows linked documents from templates that belong to the table of the page record. Downloads are protected. Issuing requires a workflow. Optional draft previews must be enabled explicitly: see the [Custom App API reference](/app/grids/help/grids-custom-app-api). This block creates no public links.

### Rendered HTML

Rendered HTML requires a page record and references exactly one `html_template` field of the table of that record. It shows the already rendered value of the field and does not expose other fields of the record. Choose the height `compact`, `normal`, or `large`. The iframe does not resize itself to the template content.

The output runs in a sandbox without scripts, forms, popups, access to the parent page, or pointer interaction. A content policy that denies by default also blocks remote images, fonts, media, frames, connections, and navigation. Only inline styles and `data:` images work. Use a Record, Form, or Actions block for interactions. When the field type changes, the field is removed, or the template fails to render, the block shows a local unavailable state. It never falls back to raw HTML in the app page.

### Comments

Comments requires a page record and a signed-in person who uses the app. It loads a bounded first page only when the block renders. It then fetches older comments with keyset pagination. The published Comments block and the current access to the app allow creating comments without **Edit** access to the Base or the record. Authors can edit and delete their own comments. People with **Manage** access to the Base can moderate any comment. Deleted comments stay as a placeholder with a timestamp, so the order of the conversation stays understandable.

Comments inherit the visibility of the record. They add no separate audience and no separate access store.

### Actions

Actions contains buttons that either navigate inside the same Grids App or start an existing enabled Grids App workflow launcher. A workflow action can bind JSON `LITERAL` values, declared Record values from `PARAMS`, or `RECORD.id` of the current page to compatible workflow inputs. Fixed launchers use their stored bindings and accept no action inputs.

For a short task, choose **Ask in dialog** for unbound scalar inputs. The dialog uses the labels and validation of the workflow, submits once, and refreshes the page after success. Keep the current record bound by the server. After an uncertain response, check the same operation again. Do not submit a new one. Optional guidance and a success message describe the task in the words of the user.

The block cannot call arbitrary URLs, update records directly, or run a workflow that the published capability set does not include.

Starting a workflow is asynchronous. The button follows its own run and reports the sanitized result message of the workflow on success or failure. It never exposes the general workflow history or raw errors. Navigation after a workflow belongs in the workflow or in a later change of the page state. Actions does not bind arbitrary workflow results.

The runtime validates again the published access to the app, the exact page, block, action, launcher, workflow revision, page records, and the `availableWhen` query. Grids leaves out an action that is missing from the immutable capability set of the publication. Workflow actions require a signed-in account.

#### Create documents in the background

Set the `background` of a workflow action to `{ acceptedMessage, documentBlockId, documentTemplateId }` for a document created from the page record. The referenced Record block must show that template without an availability condition. A page with a background document has one result template. Several actions can create it. The configured message appears after acceptance, and the user can keep working.

The action recovers its status after navigation or a reload. It opens the stored file when the file is ready. If an authorized, visible Record block already shows the exact ready document, Grids leaves out the duplicate completion action. Otherwise, the ready action stays available.

Concurrent requests for the same published action, page records, and inputs join the active run, also from another authorized person who uses the app. People see the document state, not the workflow inputs, outputs, or raw errors of another user. While the run needs review (`needs_attention`), no new start is possible.

A table Records block with `workflowStatus: true` shows these states next to its rows. It requires direct `ROW.id` navigation to the unconditional Record page of the document. The list stays paginated and searchable. The runtime refreshes visible running entries. It does not wait for completion before it shows the page.

### Scanner

Scanner embeds one existing enabled Scanner run option. Signed-in people who use the app can scan with the camera or enter a code manually. Public anonymous readers see a sign-in prompt instead. The scanner asks for session values once when it opens, and for after-scan values for each code.

The app publishes the exact block, launcher, workflow revision, and the hash of the scanner configuration. Every invocation and every status read checks that snapshot and the access of the reader to the app again. Changing the run option or the workflow requires a new publication of the app. Scanner run results stay visible only to the reader who started them.

Scanner blocks support scalar session and after-scan inputs. Record and record-list prompts stay available on the full workflow scanner. An embedded app scanner rejects them, because a person who uses the app can lack the Base access that a record picker needs. The scanned input itself can still resolve to a record through a generated scan code or a configured unique field.

## Keep navigation explicit {icon="arrow-right"}

Use normal push navigation between pages and replacing navigation after form success. Every target parameter needs a compatible binding. For repeated entry, keep the parent in a declared page parameter and bind the form relation to it.

The [Custom App API reference](/app/grids/help/grids-custom-app-api) lists the exact shapes for navigation and success bindings.

## Enforce availability with GQL {icon="adjustments"}

A page, block, form, or action can declare one `availableWhen.query`. The server supplies the same implicit context as for data queries. The resource is available only when the bounded query returns at least one row.

```yaml
availableWhen:
  query: |
    from table "Certificate requests"
    where record.id = @params.request_id and Status = 'Submitted'
    limit 1
```

An empty result or a query error leaves out the resource and its data source. Submission, invocation, and workflow effects check guards, access, launcher, and publication again. `atomicRecords` checks once after it takes its locks. Its own changes do not invalidate that step. Later effects check again. Enforce the starting state with atomic checks.

In the visual builder, the optional availability stays collapsed until you add a rule. Its summary reads **Always**, **Custom rule**, or **Needs attention**. Edit short queries in the inspector, or choose **Open large editor** for the same automatically saved draft value. Both editors use only the implicit context of the selected page; the raw GQL console deliberately does not offer Grids App `@…` context.

## Design local states {icon="info-circle"}

Blocks show their own loading, empty, and error states. Give empty states a useful next step. Do not block the whole page. Unavailable states never reveal whether a record exists. Only the active page loads, with bounded sources and deduplicated authorized reads.

## Know the deliberate limits {icon="barrier-block"}

The first release has none of these:

- app-global variables or a general expression graph;
- reusable block definitions;
- arbitrary external fetch or action targets;
- resources from other Bases;
- raw queries outside GQL;
- inline HTML, CSS, JavaScript, or Liquid control flow written in the app;
- domain-specific blocks for requests, carts, batches, or loans.

A Rendered HTML block can only select an existing HTML template field. That field owns and validates its template and CSS. Sanitized Markdown can still contain ordinary links and the documented placeholders of the request context.

Compose repeated flows from typed page parameters, fixed form values, bounded sources, navigation, and existing workflows. If these building blocks cannot express a process safely, extend the Grids resource that owns it. Do not add app-specific behavior to the page runtime.

Read [Publish a Grids App](/app/grids/help/grids-publish-custom-app) before you make the app available to others.
