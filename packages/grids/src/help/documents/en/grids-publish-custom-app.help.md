---
id: grids-publish-custom-app
title: Publish a Grids App
icon: ti ti-rocket
description: Test access, review capabilities, and publish an app snapshot that fails closed.
order: 135
---
Publishing makes one reviewed snapshot of a Grids App available at its stable URL. Public access to an app makes only that compiled snapshot public. It never opens the raw Base.

You need **Manage** access to the Base to edit or publish a Grids App.

## Understand the published boundary {icon="shield-lock"}

A caller can use a resource only when every boundary that applies allows it:

| Boundary | Question |
| --- | --- |
| Access to the app | Can this user, group, signed-in caller, or public caller open the app? |
| Published capability | Can this immutable snapshot use this exact data source, field, form, template, or launcher? |
| Availability | Does the server-run `availableWhen` query of this page, block, form, or action return at least one row? |
| Authentication | Is the caller signed in when they run a workflow action? |

Wider access at one boundary never overrides a denial or a narrower boundary elsewhere. People who use the app do not need access to the Base. Access to the Base does not replace access to the app.

You cannot give a service account direct access to a Grids App. Delegated credentials open the app through their user identity.

The app exposes only the resources that its published blocks and actions name. It does not expose the Base workspace, the schema, sibling apps, or unrelated resources. Denied blocks and actions fail without revealing their labels, their configuration, or whether a referenced record exists.

Grids derives the capability set of a publication from the app definition. The set lists exact resource IDs and operations, including form submission, editable record fields, document templates, and workflow launchers. The builder and `apps plan` show the derived set. Authors do not keep a second capability list by hand.

## Review GQL for each audience {icon="filter-lock"}

Use the immutable published query to select the data of an audience. For example, a personal page for signed-in people can use `record.createdBy = @auth.id`. An anonymous page can test `@auth.id = null`. These filters are normal GQL compiled into the app capability. They are not hidden row access in the Base.

Use separate apps when public and signed-in audiences need different data or actions. Do not build access lists for each page. Do not rely on navigation visibility as authorization.

## Test before you publish {icon="device-desktop-check"}

Use the saved draft with dedicated test accounts where possible. The builder cannot act as another audience. To test public behavior or a missing access, publish a test app on purpose. Check:

- desktop and narrow widths;
- the current account and an ordinary test account;
- the anonymous public presentation and the presentation without access on the test publication; neither can reveal undeclared metadata;
- valid, missing, malformed, deleted, and inaccessible page parameters;
- empty, loading, error, and success states;
- every direct edit, form submission, document action, and workflow launcher.

The draft rendering and the published runtime both enforce capability and availability rules on the server. Neither offers a way to bypass them by acting as someone else.

## Read the preflight {icon="list-check"}

The publish preflight compiles the same typed definition that the runtime and the CLI use. It blocks the publication when:

- a referenced resource, field, page, parameter, template, or launcher is missing;
- a value reference is out of scope or has the wrong type;
- navigation leaves out a required target parameter;
- an inline or `availableWhen` query is invalid or unbounded, or references unknown context;
- a Record block exposes an editable field that it does not display;
- a Comments block has no page record;
- the derived capability set cannot represent a resource operation;
- an unknown schema key or an unsupported schema version is present.

For an invalid definition, the preflight returns diagnostics for each path. The CLI plan reports its action and the concrete changes. It has no separate warning class.

## Publish one snapshot {icon="copy-check"}

The builder saves changes to a draft automatically. When the draft differs from the live version, the notice in **Pages** offers **Publish changes** and **Restore live version**.

- **Publish changes** first waits for the latest autosave. Then it stores the validated definition and its derived capability set as the new published snapshot.
- **Restore live version** copies the current published snapshot back into the draft.

The stable `/apps/<id>` route serves only the published snapshot.

A published app keeps using the referenced Grids resources through its immutable capabilities. Changes to access to the app take effect immediately. If someone later disables, deletes, or incompatibly changes a referenced resource, the affected page, block, or action fails closed. The rest of the page stays usable.

### Publish again after a used resource changes

A change to a referenced view, form, template, field, or workflow can change what the live app can read, write, or start. Then the builder offers **Publish changes**, even if the app definition is unchanged. If the draft has no other changes, the notice reads **Used resources changed**.

If the change breaks the draft, for example because someone deactivated a form, **Review draft** names the affected part. Fix it before you publish. Until you publish again, the live app keeps its last reviewed capabilities, so affected parts can stay unavailable. Publishing derives the capability set from the current resources.

`cld grids apps get` reports this state as `used resources changed: yes`. A change that keeps those capabilities, such as a new form label, reaches the live app right away.

## Verify the published journey {icon="checks"}

After the publication:

:::steps
1. Open the stable URL as an ordinary account, not only with **Manage** access to the Base.
2. Complete every primary journey, including a refresh and the browser's Back button.
3. Confirm that copied detail URLs keep only declared parameters.
4. Try an inaccessible record ID. Verify that the response reveals no record details.
5. Confirm that comments load page by page and that record lists stay bounded.
6. Confirm that unrelated blocks render independently.
7. Change the draft. Confirm that the published route stays unchanged until the next successful publication.
:::

For automated review and publication, use [Grids App YAML & CLI](/app/grids/help/grids-custom-app-yaml-cli).
