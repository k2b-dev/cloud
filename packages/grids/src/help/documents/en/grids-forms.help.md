---
id: grids-forms
title: Forms
icon: ti ti-forms
description: Build focused and validated record-entry flows.
order: 130
---
Forms validate and write records into one table. Use a Grids App for multi-page flows.

Before sending, Forms check required inputs, value formats and configured field limits in your browser. Errors appear beside the inputs; submitting focuses the first invalid field and sends no request. After that, errors update as you correct the values. The server still validates every submission, including permissions and references to other records.

Number inputs omit insignificant trailing zeros: `1.0000` appears as `1`. Fractional quantities and exact decimal values remain supported; the text you are typing stays intact until you leave the input.
Unsaved or submitting forms warn before leaving the page.

**Calculated values** shows up to 20 read-only formulas from visible inputs. Labels allow 200 characters, hints 2,000. Incomplete values show a dash; empty lists hide the summary. Errors remain visible.

**Field width** sets `width: "fullWidth"` (default) or `"compact"` on `user_input`, `computedFields`, `inlineCreate.fields`, and object-list columns. Consecutive compact fields share space and wrap in order; full width starts a full row. Object-list tables use widths to budget space for inline controls; the entry dialog uses the form layout. `detailsOnly` calculations appear in the entry dialog.

For object-list columns, **Rules and calculation → Default value** suggests a value only when adding an entry. Existing values stay unchanged. In configuration, set a literal `defaultValue` on the column, using option IDs for selects. It must satisfy the column's rules; calculated columns cannot have defaults. API writes do not fill missing cells from these suggestions.

## Edit object lists {icon="table"}

Object lists show compact rows. Switching to editing keeps row heights and column widths stable. Long display values are shortened; open the entry editor to read them in full. Validation messages appear below the table and identify the entry and field. Click a value to edit that row; new entries open directly for input. Tab moves between fields and rows. In single-line text and numeric inputs, Enter finishes the row, Escape undoes its edits, and Ctrl/Cmd+Enter adds another entry.

If the available space is too narrow, click an entry summary to open its editor. Simple text lists can stay inline on a phone. **Edit entry** also opens long text, multiple selections, additional details, and move/remove actions. **Apply** returns to the form; **Apply & add another** keeps entry going. Cancel discards changes to this entry only. All entries are saved together with the form.

## Create a focused form {icon="forms"}

Each table has a virtual default form. Custom forms control its inputs, labels, hints, defaults and public access.

A date input's `{"kind":"now"}` default is shown when a creation form opens, using your date timezone. Review it before saving. Editing preserves stored dates.

In a custom form you can:

- choose the title, description, title image, submit label, and success message;
- arrange user inputs and explain what each answer means;
- require one compatible number, duration, date, or date-time input to be before, after, equal to, or different from another input;
- apply hidden values that the person submitting cannot change, such as a fixed request status;
- allow configured relation fields to create related records inline;
- redirect after a successful submission;
- pause submissions without deleting the form.

A signed-in Base user can submit with Base Write. A narrower authenticated audience submits only through a Grids App that explicitly includes the Form. The public token remains the standalone anonymous submission path.

Turn on **Public form** only when anonymous submissions are intended. The unique public URL accepts only the form's configured fields and always applies its hidden values. Turning public access off invalidates the existing link; enabling it again creates a new one.

Before sharing, test invalid input, required fields, relation creation, success text and redirects.

Cross-field validation belongs to the Form when two answers must agree before any record may be created. For example, require **Start date** to be on or before **Due date**. The browser explains a failed rule next to its field and the server evaluates the same rule again. Use a Workflow instead when validation depends on other records, current capacity, permissions, or effects that can change concurrently.

## Reuse a Form in a Grids App {icon="app-window"}

A Grids App may render an existing active Form as one block. The Form keeps ownership of its inputs and validation. The app may add fixed relation values from declared page parameters, assign the current signed-in user to a Principal input, and navigate to another page after a successful submission.

Rendering and submission check the published capability and `availableWhen`. Inactive or undeclared Forms remain unavailable.

Choose **Edit this page's record** for a Form on a matching Record page when users should revise an existing draft and its configured related inputs together. Creation remains the default; public links and global sidebar Forms always create. Existing related edits require exclusive links to that parent within the same Base. Removing a related row detaches it, not deletes it. Finalized records remain read-only.

Saving checks versions and commits related edits together. Retry connection failures in the open dialog; after version conflicts, reload and review before saving. For CLI/API versions, idempotency keys, payloads and limits, see the [API reference](/app/grids/help/grids-custom-app-api).

## Configuration for CLI and API authors {icon="code"}

Form `config` uses the following keys. Public APIs accept public field IDs, not internal UUIDs.

| Key | Meaning |
| --- | --- |
| `title`, `description` | Optional text above the inputs |
| `fields` | Ordered input/hidden-value entries; do not repeat a field |
| `computedFields` | At most 20 read-only summaries: `{fieldId, label?, helpText?, width?}`; label up to 200 characters, hint up to 2,000 |
| `validations` | At most 20 cross-field rules, described below |
| `submitLabel`, `successMessage` | Optional action and success text |
| `redirectUrl` | Optional destination after successful submission; null means no redirect |
| `titleImage` | Optional image data URL, at most 1,000,000 characters |

A visible entry is `{kind:"user_input", fieldId, label?, helpText?, required?, defaultValue?, width?, inlineCreate?, relationFilter?}`. A hidden entry is `{kind:"form_value", fieldId, value}`: the server applies that fixed value instead of trusting submitted data.

A rule is `{leftFieldId, operator, rightFieldId, message, errorFieldId?}`. Operators: `eq`, `neq`, `lt`, `lte`, `gt`, `gte`. The message is 1–240 characters. Compare compatible number/duration/date inputs; `errorFieldId` chooses the input showing the error. For two Relation inputs, `anyPresent` requires at least one selection across the pair. The Form editor offers this rule; the browser and server show the same configured error.

For a Relation input, `relationFilter` accepts the existing record filter tree, scoped to fields of its target table. For example, combine `{fieldId:"PUBLIC",op:"=",value:true}` and `{fieldId:"STATUS",op:"is",value:"available"}` under `{op:"AND",filters:[...]}`. Replace these example IDs with public IDs of the target fields.

Configure selection filters through the API or a template; the Form editor preserves them but has no filter editor. Filtered inputs require a stored target table in the same Base and cannot enable `inlineCreate`. Their picker returns only eligible labels. Submission checks every selected record again under a lock; deleted, hidden-by-filter, or newly unavailable selections reject the whole submission. Selection does not reserve an item. Use a Workflow for reservation or handover.

The filter applies in a published Grids App, the authenticated Base form, and the active public-token form. A public token therefore exposes the matching records' presentable labels: only enable public access when intended. The existing Form permission is sufficient; no target-table grant is added. Changing the filter or its referenced field configuration requires republishing an affected Grids App. Preview mode without an authorized lookup disables filtered selection.

Filtered form pickers use `GET /api/grids/forms/:formId/relations/:fieldId/lookup` with Base Write, or `/api/grids/forms/public/:token/relations/:fieldId/lookup` with an active share token. Query options are `_search` (up to 200 characters), `_limit` (1–50, default 10), and `_exclude` (comma-separated public record IDs, at most 1,000). The response is `{items:[{id,label}]}`. Custom Apps use their existing published Form endpoint.

For an eligible Relation input, `inlineCreate: {enabled:true, fields:[...]}` selects the target inputs. Each entry has `fieldId` and optional `label`, `helpText`, `width`, `required`, `defaultValue`. Inline creation is one level deep; it cannot nest further relations, upload file fields, or accept system/calculated values.

Form defaults suggest initial answers. Object-list column defaults suggest newly added cells. Neither is an authorization rule or a substitute for hidden values. Set safe conveniences such as quantity 1; do not invent a price, bank account, payment confirmation or approval.

For stored field defaults and all scalar configuration options, read [Field configuration](/app/grids/help/grids-field-configuration). For published app payloads, optimistic versions and current-user assignments, read [Grids App API](/app/grids/help/grids-custom-app-api).
