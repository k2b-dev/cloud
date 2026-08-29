---
id: grids-build-custom-app
title: Build your first Grids App
icon: ti ti-certificate
description: Build a request app with progress, comments, and a generated certificate.
order: 133
---
This guide builds a certificate-request app. A requester can submit a request, see their requests, open one request, discuss it, follow its status, and download the generated certificate. A responsible group can process every request through the same base.

The app uses one table and three pages. Existing Forms, Views, Workflows, and document templates continue to own their respective behavior.

## Before you start {icon="list-check"}

You must be a base administrator. Prepare these resources in the same base:

| Resource | Required configuration |
| --- | --- |
| **Certificate requests** table | Title, Engagement details, Status, and Processing note fields |
| **Request a certificate** form | Creates Certificate requests; Status is fixed to Submitted |
| **My certificate requests** view | Shows Title, Status, Processing note, and Updated |
| **Certificate** document template | Uses one Certificate requests record |
| **Approve and generate certificate** workflow launcher | Validates the request, updates it, generates the document, then notifies the requester |

Do not add a requester field only to duplicate identity. Every record already stores its creator, and the app's GQL can compare `record.createdBy` with `@auth.id`. Generated PDFs stay attached as Documents instead of being copied into another file field.

## Configure access first {icon="lock"}

Choose the audience boundaries before composing pages:

| Audience | Boundary | Result |
| --- | --- | --- |
| Requesters | Grids App Read | Use only the published pages, personal GQL result, included Form, comments, and documents. |
| Responsible group | Base Write, or a separate staff Grids App | Process all requests without widening the requester app. |

Grids App access does not grant raw Base access. The immutable publication lists the exact data and operations available to requesters. Exercise the requester app and the staff surface with separate real test accounts before publishing.

**Checkpoint:** a requester can submit the Form and the app's Records query returns only `record.createdBy = @auth.id`; the responsible group can process all requests through its separate boundary. If this fails, correct the query or split the audience before building more pages.

## Open the builder {icon="apps"}

Turn on **Edit mode**, open the base, and choose **New app** under **Apps**. The builder creates one Home page that you can rename or extend. You can also create or replace the same canonical definition with [YAML & CLI](/app/grids/help/grids-custom-app-yaml-cli). Only base administrators see these controls.

The builder edits the same canonical draft used by YAML and CLI. Every structurally complete change is saved automatically; semantic diagnostics remain attached to the draft and block publishing instead of discarding your work. The status beside the app name distinguishes **Live**, **Unpublished changes**, **Draft only**, and a draft that needs attention. The Pages notice shows saving failures, publishes the latest saved draft, and can restore the draft to the current live version after confirming that all draft changes will be discarded. Its external-link icon opens that live version.

The canvas is the current draft page: saved View and parameter-free GQL results for its draft pages are resolved on the server, Records use the shared Data Table, Metrics and Charts render aggregate results, and Forms use the complete shared Form UI with submission disabled while authoring. Referenced records shows a contextual placeholder because its result depends on the current record in the published route. Rendered HTML follows the same contextual-preview rule. Hover or focus a block to reveal its compact move handle. Drag to a horizontal edge to stack it before or after another block, or to a vertical edge to place it beside one block, a neighboring pair, or the complete stack. Pointer, touch, and keyboard use the same named targets and announcements. Rows, columns, empty layout containers, and balanced widths are created or removed automatically; only blocks are selected and edited. **Add block** groups ordinary content, page-record blocks, and advanced insights/actions. Data blocks prefer an accessible saved View when one exists and otherwise start with a bounded GQL source from an available table. Unavailable prerequisites stay visible in the menu instead of creating an unusable block.

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

Page IDs are stable definition identifiers. You may edit them in Page settings; the builder updates navigation references atomically. Labels may change without breaking navigation. The hidden detail page is reached from a row or successful form submission.

**Checkpoint:** the draft opens on Apply, shows Apply and My requests in navigation, and keeps Request detail out of navigation. If not, correct the start page, each page's visibility, and the page array order.

## Build Apply {icon="forms"}

Add one full-width row with:

1. a Markdown block explaining what information is needed and the expected processing time;
2. a Form block using **Request a certificate**.

In the Form block's **After success** settings, choose **Navigate**, target the `request` page, and bind:

```text
request_id = RESULT.recordId
```

Enable **Replace history** so Back does not return to a completed submission state. The Form continues to own required fields, validation, fixed Status, and record creation.

**Checkpoint:** a successful submission opens the new request's detail URL. If creation succeeds but navigation does not, fix the success binding rather than the Form.

## Build My requests {icon="list-details"}

Add a Records block using **My certificate requests**. Show only the fields needed to identify a request. Use a compact table or cards according to the expected screen width.

Set the row target to page `request` and bind:

```text
request_id = ROW.id
```

The published GQL must keep `record.createdBy = @auth.id` in the server-executed source. The rows shown by the table are presentation, never an access control.

**Checkpoint:** selecting any visible row opens its detail page, while changing the URL to another request does not reveal that record. Fix row navigation separately from row authorization.

## Build Request detail {icon="file-description"}

Under **Route parameters**, add one Record parameter with ID `request_id` and table **Certificate requests**. Then add the Record block. The builder binds that same route parameter as the page record automatically; there is no separate Page Record setting:

```text
PARAMS.request_id
```

Arrange the page in task order:

1. A Record block showing Title, Status, Processing note, and submitted details.
2. A Comments block for the page record.
3. Generated documents inside the Record block, limited to the Certificate template.
4. An Actions block only when the current audience has an appropriate enabled workflow launcher.

Requester fields should normally be read-only after submission. If corrections are allowed, add only those fields to **Editable fields**. Status, approval data, and generated output remain workflow-owned.

When the page record is missing, the Record block can show configured empty text. An existing request with no generated certificate simply has no download entry; the current schema has no document-specific empty copy.

**Checkpoint:** status, comments, and generated Documents remain attached to the same request after reload. A failure belongs to the Record binding, Comments access, or Document named by the failing block.

## Keep processing outside the layout {icon="route"}

The responsible group can process requests in the Grids workspace or a second ordinary Grids App. No special admin-app type is needed.

The workflow must re-read and validate the request before changing it. Related record changes use the workflow's atomic record-change boundary; external effects begin only after those changes commit. This keeps concurrent reviewers from silently applying a stale transition.

## Test the complete journey {icon="shield-check"}

Save the draft, grant it only to dedicated test accounts representing each audience, and verify:

:::steps
1. As a requester, submit a valid request and confirm that its detail page opens immediately.
2. Reload the detail URL and confirm that the same request opens.
3. Use another request ID and confirm that no record existence or data is disclosed.
4. Confirm the empty list, no-comments, awaiting-document, completed, missing-parameter, and denied states.
5. As the responsible group, confirm that the intended processing records and actions are available.
6. Repeat the journey at desktop and narrow widths using keyboard navigation.
:::

The app is ready when the requester journey is understandable without the Grids workspace or knowledge of the underlying table. There is no impersonation or anonymous-preview mode in the builder; test public access only on a deliberately published test app.

## Take an app offline or delete it {icon="alert-triangle"}

Open **App settings**, then expand **Danger zone**. **Unpublish app** removes the live snapshot immediately while preserving the draft and access grants, so you can edit and publish it again later. **Delete app** removes the app and its live URL but does not delete Base tables or records. Both actions show a destructive confirmation before anything changes; deletion cannot be undone in the builder.

## Publish and verify {icon="rocket"}

Run the publish preflight, review every requested capability, and publish. Open the standalone URL and repeat the requester journey against the published snapshot.

When something fails, fix the owning layer:

| Symptom | Owner |
| --- | --- |
| Missing or invalid `request_id` | Page parameter or navigation binding |
| Missing or unavailable request | Published query, page parameter, or `availableWhen` |
| Rejected input | Form |
| Stale transition or partial record change | Workflow |
| Missing PDF | Document template or Document |
| Unavailable action | Published capability, launcher state, or permission |

Read [Pages & blocks](/app/grids/help/grids-custom-app-pages-blocks) for every setting, [Publish & permissions](/app/grids/help/grids-publish-custom-app) for preflight behavior, and [YAML & CLI](/app/grids/help/grids-custom-app-yaml-cli) for the equivalent agent workflow.
