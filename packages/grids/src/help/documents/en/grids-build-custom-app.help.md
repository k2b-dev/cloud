---
id: grids-build-custom-app
title: Build your first Grids App
icon: ti ti-certificate
description: Build a request app with progress, comments, and a generated certificate.
order: 133
---
This guide builds a certificate-request app. A requester can submit a request, see their requests, open one request, discuss it, follow its status, and download the generated certificate. A responsible group processes every request in the same Base.

The app uses one table and three pages. Existing forms, views, workflows, and document templates keep their own behavior.

## Prepare the resources {icon="list-check"}

You need **Manage** access to the Base. Prepare these resources in the same Base:

| Resource | Required configuration |
| --- | --- |
| **Certificate requests** table | Title, Engagement details, Status, and Processing note fields |
| **Request a certificate** form | Creates Certificate requests; Status is fixed to Submitted |
| **My certificate requests** view | Shows Title, Status, Processing note, and Updated |
| **Certificate** document template | Uses one Certificate requests record |
| **Approve and generate certificate** workflow launcher | Validates the request, updates it, generates the document, then notifies the requester |

Do not add a requester field that only repeats the identity. Every record already stores its creator, and the GQL of the app can compare `record.createdBy` with `@auth.id`. Generated PDFs stay attached as documents. Do not copy them into another file field.

## Configure access first {icon="lock"}

Choose the boundaries of each audience before you build pages:

| Audience | Boundary | Result |
| --- | --- | --- |
| Requesters | **Open** access to the Grids App | Use only the published pages, the personal GQL result, the included form, comments, and documents. |
| Responsible group | **Edit** access to the Base, or a separate staff Grids App | Process all requests without widening the requester app. |

Access to a Grids App gives no raw access to the Base. The immutable publication lists the exact data and operations that requesters can use. Before you publish, try the requester app and the staff surface with separate real test accounts.

**Checkpoint:** A requester can submit the form, and the Records query of the app returns only `record.createdBy = @auth.id`. The responsible group can process all requests through its separate boundary. If this fails, correct the query or split the audience before you build more pages.

## Open the builder {icon="apps"}

You need **Manage** access to the Base to see these controls.

:::steps
1. Turn on **Edit mode**.
2. Open the Base.
3. Under **Apps**, choose **New app**.
:::

The builder creates one Home page that you can rename or extend. You can also create or replace the same canonical definition with [Grids App YAML & CLI](/app/grids/help/grids-custom-app-yaml-cli).

### Work with the draft

The builder edits the same canonical draft as YAML and the CLI. It saves every structurally complete change automatically. Semantic diagnostics stay on the draft and block publishing, so your work is never discarded.

The notice under **Pages** shows the state of the draft: **This app is a draft**, **Changes are in a draft**, or **Used resources changed**. It shows saving failures and publishes the latest saved draft. It can also restore the draft to the current live version. Before that, it asks you to confirm that all draft changes will be discarded. **Open live app** opens the live version.

If saving fails, choose **Retry save** in the notice. When you follow a link to another Cloud page in the same tab, Grids first waits until pending changes are saved. This also applies when you leave **Edit mode**. If saving fails, the builder stays open. When you reload or close the tab, the browser warns about unsaved changes. Cancel the warning and retry saving to keep your edits.

If a data preview fails to load, choose **Reload preview** in that block. This tries again without reloading the builder.

Charts show date-typed categories as localized calendar dates. Text categories keep their original labels, even when they look like dates.

### Arrange blocks on the canvas

The canvas shows the current draft page:

- The server resolves the results of a saved view and of GQL without parameters for the draft pages.
- Records use the shared data table. Metrics and Charts show aggregate results.
- Forms use the complete shared form interface. Submitting is disabled while you author.
- Referenced records shows a contextual placeholder, because its result depends on the current record in the published route. Rendered HTML follows the same rule.

Hover over or focus a block to show its compact move handle. Drag the block to a horizontal edge to stack it before or after another block. Drag it to a vertical edge to place it beside one block, a neighboring pair, or the complete stack. Pointer, touch, and keyboard use the same named targets and announcements. Grids creates and removes rows, columns, empty layout containers, and balanced widths automatically. You select and edit only blocks.

**Add block** groups ordinary content, blocks for the page record, and advanced insights and actions. A data block uses an accessible saved view when one exists. Otherwise, it starts with a bounded GQL source from an available table. A block whose prerequisites are missing stays visible in the menu and does not create an unusable block.

### Configure the app

**App settings** contains **General**, **Access**, and **Lifecycle**. Name and icon edits use the same autosaved draft. Choose an existing entry under **Actions** to edit a sidebar form action, or choose **New action** to add one. The inspector holds its label, form, fixed values, availability, and success navigation. Inline GQL and Markdown can be opened in a larger editor without creating a second draft or a separate save step.

Set:

- **Name:** Certificate requests
- **Icon:** Certificate
- **Start page:** Apply

Create these pages, then inspect and refine them in the builder:

| Page ID | Title | Navigation | Parameters |
| --- | --- | --- | --- |
| `apply` | Apply | Visible | None |
| `requests` | My requests | Visible | None |
| `request` | Request detail | Hidden | Required `request_id`, type Record, Certificate requests table |

Page IDs are stable identifiers of the definition. You can edit them in **Page settings**. The builder then updates navigation references atomically. Labels can change without breaking navigation. People reach the hidden detail page from a row or after a successful form submission.

**Checkpoint:** The draft opens on Apply, shows Apply and My requests in the navigation, and keeps Request detail out of it. If not, correct the start page, the visibility of each page, and the order of the page array.

## Build the Apply page {icon="forms"}

:::steps
1. Add one full-width row.
2. Add a Markdown block that explains the needed information and the expected processing time.
3. Add a Form block with **Request a certificate**.
4. In **After submission** of the Form block, set **Target page** to `request`.
5. Bind `request_id` to **Created Form record**.
:::

The binding is:

```text
request_id = RESULT.recordId
```

A successful submission replaces the history entry, so Back does not return to the completed submission. The form keeps its required fields, validation, fixed Status, and record creation.

**Checkpoint:** A successful submission opens the detail URL of the new request. If creation succeeds but navigation fails, fix the success binding, not the form.

## Build the My requests page {icon="list-details"}

Add a Records block with the saved view **My certificate requests**. Show only the fields that identify a request. Use a compact table or cards, depending on the expected screen width.

Set **Open row on page** to `request` and bind:

```text
request_id = ROW.id
```

The published GQL must keep `record.createdBy = @auth.id` in the source that the server runs. The rows that the table shows are presentation, never access control.

**Checkpoint:** Selecting a visible row opens its detail page. Changing the URL to another request does not reveal that record. Fix row navigation separately from row authorization.

## Build the Request detail page {icon="file-description"}

Under **Route parameters**, add one Record parameter with the ID `request_id` and the table **Certificate requests**. Then add the Record block. The builder binds the same route parameter as the page record automatically, so there is no separate Page Record setting:

```text
PARAMS.request_id
```

Arrange the page in task order:

1. A Record block with Title, Status, Processing note, and the submitted details.
2. A Comments block for the page record.
3. Generated documents inside the Record block, limited to the Certificate template.
4. An Actions block, only when the current audience has a suitable enabled workflow launcher.

Fields of the requester are normally read-only after submission. If corrections are allowed, add only those fields to **Editable fields**. Status, approval data, and generated output stay with the workflow.

When the page record is missing, the Record block can show a configured empty text. An existing request without a generated certificate has no download entry. The current schema has no separate empty text for documents.

**Checkpoint:** Status, comments, and generated documents stay attached to the same request after a reload. A failure belongs to the Record binding, the Comments access, or the document that the failing block names.

## Keep processing outside the layout {icon="route"}

The responsible group can process requests in the Grids workspace or in a second ordinary Grids App. No special app type for administration is needed.

The workflow must read and validate the request again before it changes it. Related record changes use the atomic record-change boundary of the workflow. External effects start only after those changes commit. This keeps concurrent reviewers from applying a stale transition silently.

## Test the complete journey {icon="shield-check"}

Save the draft. Give access only to dedicated test accounts, one for each audience. Then verify:

:::steps
1. As a requester, submit a valid request. Confirm that its detail page opens immediately.
2. Reload the detail URL. Confirm that the same request opens.
3. Use another request ID. Confirm that neither the record nor its existence is disclosed.
4. Check the states: empty list, no comments, awaiting document, completed, missing parameter, and denied.
5. As the responsible group, confirm that the intended records and actions for processing are available.
6. Repeat the journey at desktop and narrow widths with keyboard navigation.
:::

The app is ready when a requester understands the journey without the Grids workspace and without knowing the table behind it. The builder has no mode to act as someone else and no anonymous preview. Test public access only on a test app that you publish on purpose.

## Take an app offline or delete it {icon="alert-triangle"}

:::warning You cannot undo deletion in the builder
Both actions show a confirmation before anything changes. Deleting cannot be undone in the builder.
:::

Open **App settings → Lifecycle**:

- **Unpublish app** removes the live snapshot immediately. It keeps the draft and the access entries, so you can edit and publish the app again later.
- **Delete app** removes the app and its live URL. It does not delete Base tables or records.

## Publish and verify {icon="rocket"}

:::steps
1. Run the publish preflight.
2. Review every requested capability.
3. Publish the app.
4. Open the standalone URL.
5. Repeat the requester journey on the published snapshot.
:::

When something fails, fix the layer that owns it:

| Symptom | Owner |
| --- | --- |
| Missing or invalid `request_id` | Page parameter or navigation binding |
| Missing or unavailable request | Published query, page parameter, or `availableWhen` |
| Rejected input | Form |
| Stale transition or partial record change | Workflow |
| Missing PDF | Document template or Document |
| Unavailable action | Published capability, launcher state, or access |

Read [Grids App pages & blocks](/app/grids/help/grids-custom-app-pages-blocks) for every setting, [Publish a Grids App](/app/grids/help/grids-publish-custom-app) for the preflight, and [Grids App YAML & CLI](/app/grids/help/grids-custom-app-yaml-cli) for the same workflow for agents.
