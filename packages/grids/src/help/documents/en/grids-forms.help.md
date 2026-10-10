---
id: grids-forms
title: Forms
icon: ti ti-forms
description: Build focused, validated flows for entering records.
order: 130
---
A form validates records and writes them into one table. Use a Grids App for flows with several pages.

Before sending, the browser checks required inputs, value formats, and configured field limits. Errors appear next to the inputs. When you submit with an error, the form focuses the first invalid field and sends no request. After that, the errors update while you correct the values. The server still validates every submission, including access and references to other records.

Number inputs hide trailing zeros that carry no meaning: `1.0000` appears as `1`. Fractional quantities and exact decimal values stay supported. The text that you type stays intact until you leave the input.

A form warns before you leave the page while it has unsaved changes or is still submitting.

**Calculated values** shows up to 20 read-only formulas from visible inputs. Labels allow 200 characters, hints 2,000. Incomplete values show a dash. Empty lists hide the summary. Errors stay visible.

**Field width** sets `width: "fullWidth"` (default) or `"compact"` on `user_input`, `computedFields`, `inlineCreate.fields`, and object-list columns. Consecutive compact fields share the space and wrap in order. A full-width field starts a new row. Object-list tables use the widths to share space between inline controls. The entry dialog uses the form layout. `detailsOnly` calculations appear in the entry dialog.

For object-list columns, **Rules and calculation → Default value** suggests a value only when someone adds an entry. Existing values stay unchanged. In the configuration, set a literal `defaultValue` on the column. Select columns use option IDs. The value must meet the rules of the column. Calculated columns cannot have defaults. API writes do not fill missing cells from these suggestions.

## Edit object lists {icon="table"}

Object lists show compact rows. When you switch to editing, row heights and column widths stay stable. Long display values are shortened. Open the entry editor to read them in full. Validation messages appear below the table and name the entry and the field.

- Choose a value to edit its row. A new entry opens directly for input.
- **Tab** moves between fields and rows.
- In single-line text and number inputs, **Enter** finishes the row.
- **Escape** undoes the edits of the row.
- **Ctrl+Enter** or **Cmd+Enter** adds another entry.

If the space is too narrow, choose the summary of an entry to open its editor. Simple text lists can stay inline on a phone. **Edit entry** also opens long text, multiple selections, additional details, and the actions to move or remove the entry.

- **Apply** returns to the form.
- **Apply & add another** keeps you entering.
- **Cancel** discards the changes to this entry only.

Grids saves all entries together with the form.

## Create a focused form {icon="forms"}

Each table has a virtual default form. A custom form controls its inputs, labels, hints, defaults, and public access.

**Create** saves a new custom form right away and opens its editor. Adjust it and choose **Save**, or choose **Done** to keep it as it was created.

A date input with the default `{"kind":"now"}` shows the current time when a creation form opens, in your date timezone. Review it before you save. Editing a record keeps its stored dates.

In a custom form, you can:

- choose the title, description, title image, submit label, and success message;
- arrange user inputs and explain what each answer means;
- require that one compatible number, duration, date, or date-time input is before, after, equal to, or different from another input;
- apply hidden values that the person who submits cannot change, such as a fixed request status;
- let configured relation fields create related records inline;
- redirect after a successful submission;
- pause submissions without deleting the form, with the **Active** switch.

A signed-in person with **Edit** access to the Base can submit a form. A narrower signed-in audience can submit only through a Grids App that explicitly includes the form. The public token stays the separate path for anonymous submissions.

Turn on **Public** only when you want anonymous submissions. The unique URL of a public form accepts only the configured fields of the form and always applies its hidden values.

:::warning Turning public access off breaks the link
When you turn public access off, the existing link stops working. When you turn it on again, Grids creates a new link.
:::

Before you share a form, test invalid input, required fields, relation creation, the success text, and redirects.

Cross-field validation belongs in the form when two answers must agree before Grids creates a record. For example, require that **Start date** is on or before **Due date**. The browser explains a failed rule next to its field, and the server checks the same rule again. Use a workflow instead when the validation depends on other records, the current capacity, access, or effects that can change at the same time.

## Reuse a form in a Grids App {icon="app-window"}

A Grids App can show an existing active form as one block. The form keeps its inputs and validation. The app can:

- add fixed relation values from declared page parameters;
- assign the current signed-in user to a principal input;
- open another page after a successful submission.

Showing and submitting the form check the published capability and `availableWhen`. Inactive or undeclared forms stay unavailable.

Choose **Edit this page's record** for a form on a matching record page. People can then revise an existing draft together with its configured related inputs. Creating stays the default. Public links and global sidebar forms always create. Editing existing related records requires exclusive links to that parent in the same Base. Removing a related row detaches it and does not delete it. Finalized records stay read-only.

Saving checks versions and commits the related edits together. After a connection failure, retry in the open dialog. After a version conflict, reload and review before you save. The [API reference](/app/grids/help/grids-custom-app-api) describes CLI and API versions, idempotency keys, payloads, and limits.

## Configure forms from the CLI or API {icon="code"}

The form `config` uses these keys. Public APIs accept public field IDs, not internal UUIDs.

| Key | Meaning |
| --- | --- |
| `title`, `description` | Optional text above the inputs |
| `fields` | Ordered entries for inputs and hidden values; do not repeat a field |
| `computedFields` | At most 20 read-only summaries: `{fieldId, label?, helpText?, width?}`; label up to 200 characters, hint up to 2,000 |
| `validations` | At most 20 cross-field rules, described below |
| `submitLabel`, `successMessage` | Optional action and success text |
| `redirectUrl` | Optional destination after a successful submission; null means no redirect |
| `titleImage` | Optional image data URL, at most 1,000,000 characters |

A visible entry is `{kind:"user_input", fieldId, label?, helpText?, required?, defaultValue?, width?, inlineCreate?, relationFilter?}`. A hidden entry is `{kind:"form_value", fieldId, value}`. The server applies that fixed value and does not trust submitted data for it.

A rule is `{leftFieldId, operator, rightFieldId, message, errorFieldId?}`. The operators are `eq`, `neq`, `lt`, `lte`, `gt`, and `gte`. The message has 1–240 characters. Compare compatible number, duration, or date inputs. `errorFieldId` chooses the input that shows the error. For two relation inputs, `anyPresent` requires at least one selection across the pair. The form editor offers this rule. The browser and the server show the same configured error.

### Filter the choices of a relation input

For a relation input, `relationFilter` accepts the existing record filter tree, limited to fields of its target table. For example, combine `{fieldId:"PUBLIC",op:"=",value:true}` and `{fieldId:"STATUS",op:"is",value:"available"}` under `{op:"AND",filters:[...]}`. Replace these example IDs with the public IDs of the target fields.

Configure selection filters through the API or a template. The form editor keeps them but has no filter editor. A filtered input requires a stored target table in the same Base and cannot enable `inlineCreate`. Its picker returns only eligible labels. On submission, Grids checks every selected record again under a lock. A selection that is deleted, excluded by the filter, or no longer available rejects the whole submission. A selection does not reserve an item. Use a workflow for a reservation or a handover.

The filter applies in a published Grids App, in the signed-in Base form, and in the form with an active public token. A public token therefore shows the presentable labels of the matching records.

:::warning A public token shows matching labels
Enable public access only when everyone with the link can see these labels.
:::

The existing access to the form is enough. Grids adds no access to the target table. When you change the filter or the configuration of a field that it references, you must publish an affected Grids App again. A preview without an authorized lookup disables filtered selection.

Filtered pickers use `GET /api/grids/forms/:formId/relations/:fieldId/lookup` with **Edit** access to the Base, or `/api/grids/forms/public/:token/relations/:fieldId/lookup` with an active share token. The query options are `_search` (up to 200 characters), `_limit` (1–50, default 10), and `_exclude` (comma-separated public record IDs, at most 1,000). The response is `{items:[{id,label}]}`. Grids Apps use their existing published form endpoint.

### Create related records inline

For an eligible relation input, `inlineCreate: {enabled:true, fields:[...]}` selects the target inputs. Each entry has `fieldId` and optional `label`, `helpText`, `width`, `required`, and `defaultValue`. Inline creation is one level deep. It cannot nest further relations, upload file fields, or accept system or calculated values.

### Use defaults safely

Form defaults suggest initial answers. Object-list column defaults suggest values for newly added cells. Neither is an access rule or a replacement for hidden values. Set safe conveniences, such as quantity 1. Do not invent a price, a bank account, a payment confirmation, or an approval.

For stored field defaults and all scalar configuration options, read [Field configuration reference](/app/grids/help/grids-field-configuration). For published app payloads, optimistic versions, and assignments of the current user, read [Custom App API reference](/app/grids/help/grids-custom-app-api).
