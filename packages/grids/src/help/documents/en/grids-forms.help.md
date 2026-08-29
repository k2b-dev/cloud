---
id: grids-forms
title: Forms
icon: ti ti-forms
description: Build focused and validated record-entry flows.
order: 130
---
Forms simplify how people add records to a base. They keep labels, guidance, required inputs, defaults, and relation handling in one reusable entry flow.

Forms do not replace tables. They validate and write records into one table. Use a Grids App when a task needs several pages, data, instructions, and actions around one or more Forms.

## Create a focused form {icon="forms"}

Every table has a virtual default form based on its fields. Create a custom form when users need different labels, help text, required inputs, defaults, a smaller field set, or a controlled public link.

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

Test a form with incomplete and invalid input before sharing it. Confirm that required fields, relation creation, success text, and redirect behavior are understandable without knowledge of the table.

Cross-field validation belongs to the Form when two answers must agree before any record may be created. For example, require **Start date** to be on or before **Due date**. The browser explains a failed rule next to its field and the server evaluates the same rule again. Use a Workflow instead when validation depends on other records, current capacity, permissions, or effects that can change concurrently.

## Reuse a Form in a Grids App {icon="app-window"}

A Grids App may render an existing active Form as one block. The Form keeps ownership of its inputs and validation. The app may add fixed relation values from declared page parameters, assign the current signed-in user to a Principal input, and navigate to another page after a successful submission.

Use this composition when people need context before entering data, a repeated “add another” flow, or a detail page after creation. Keep the Form useful on its own and put multi-page navigation in the Grids App.

The published capability and the Form block's optional `availableWhen` query are checked when the app renders and again when it submits. App access does not turn an inactive or undeclared Form into a writable endpoint.
