---
id: grids-forms
title: Forms
icon: ti ti-forms
description: Build focused and validated record-entry flows.
order: 130
---
Forms validate and write records into one table. Use a Grids App for multi-page flows.
Unsaved or submitting forms warn before leaving the page.

**Calculated values** shows up to 20 read-only formulas from visible inputs. Labels allow 200 characters, hints 2,000. Incomplete values show a dash; empty lists hide the summary. Errors remain visible.

**Field width** sets `width: "fullWidth"` (default) or `"compact"` on `user_input`, `computedFields`, `inlineCreate.fields`, and object-list columns. Consecutive compact fields share space and wrap in order; full width starts a full row. Calculated columns use the same layout. `detailsOnly` calculations appear on demand, only with existing rows.

For object-list columns, **Rules and calculation → Default value** suggests a value only when adding an entry. Existing values stay unchanged. In configuration, set a literal `defaultValue` on the column, using option IDs for selects. It must satisfy the column's rules; calculated columns cannot have defaults. API writes do not fill missing cells from these suggestions.

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
