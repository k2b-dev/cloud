---
id: grids-publish-custom-app
title: Publish a Grids App
icon: ti ti-rocket
description: Test access, review capabilities, and publish a fail-closed app snapshot.
order: 135
---
Publishing makes one reviewed Grids App snapshot available at its stable URL. A public app grant makes only that compiled snapshot public; it never opens the raw Base.

Only a base administrator can edit or publish a Grids App.

## Understand the published boundary {icon="shield-lock"}

A caller can use a resource only when every applicable boundary allows it:

| Boundary | Question |
| --- | --- |
| App grant | May this user, group, authenticated caller, or public caller open the app? |
| Published capability | May this immutable snapshot use this exact data source, field, Form, template, or launcher? |
| Availability | Does this page, block, Form, or action return at least one row from its server-run `availableWhen` query? |
| Authentication | Is the caller signed in when invoking a Workflow action? |

A broader permission at one boundary never overrides a denial or narrower boundary elsewhere. Base access is not required for an app reader and does not replace the app grant.

Grids App grants do not support service accounts. Delegated credentials access the app through their user identity.

The app exposes only resources named by its published blocks and actions. It does not expose the base workspace, schema, sibling apps, or unrelated resources. Denied blocks and actions fail without revealing their labels, configuration, or whether a referenced record exists.

The publication capability set is derived from the app definition. It lists exact resource IDs and operations, including form submission, editable record fields, document templates, and workflow launchers. The builder and `apps plan` show the derived set; authors do not maintain a second capability list by hand.

## Review audience-specific GQL {icon="filter-lock"}

Use the immutable published query to select audience data. For example, an authenticated personal page can use `record.createdBy = @auth.id`; an anonymous page can test `@auth.id = null`. These filters are normal GQL compiled into the app capability, not hidden Base row permissions.

Use separate apps when public and authenticated audiences need different data or actions. Do not build per-page ACLs or rely on navigation visibility as authorization.

## Test before publishing {icon="device-desktop-check"}

Use the saved draft with dedicated test accounts where possible. For public or no-access behavior, use a deliberately published test app because the builder does not impersonate another audience. Check:

- desktop and narrow widths;
- the current account and an ordinary test account;
- the anonymous public presentation and the no-access presentation on the test publication, neither of which may reveal undeclared metadata;
- valid, missing, malformed, deleted, and inaccessible page parameters;
- empty, loading, error, and success states;
- every direct edit, form submission, document action, and workflow launcher.

Draft rendering and published runtime both keep capability and availability rules server-enforced. Neither provides an impersonation bypass.

## Read the preflight {icon="list-check"}

Publish preflight compiles the same typed definition used by runtime and CLI. Publication is blocked when:

- a referenced resource, field, page, parameter, template, or launcher is missing;
- a value reference is out of scope or has the wrong type;
- navigation omits a required target parameter;
- an inline or `availableWhen` query is invalid, unbounded, or references unknown context;
- a Record block exposes an editable field it does not display;
- a Comments block has no page record;
- a resource operation cannot be represented by the derived capability set;
- an unknown schema key or unsupported schema version is present.

Preflight returns path-specific diagnostics for invalid definitions. The CLI plan reports its action and concrete changes; it does not have a separate warning class.

## Publish one snapshot {icon="copy-check"}

The builder saves changes automatically into a draft. When that draft differs from the live version, the Pages notice offers **Publish changes** and **Restore live version**. Publishing first waits for the latest autosave, then stores the validated definition and its derived capability set as the new published snapshot. Restore copies the current published snapshot back into the draft. The stable `/apps/<id>` route serves only the published snapshot.

Published apps continue to use the referenced Grids resources through their immutable capabilities. App grant changes take effect immediately. If a referenced resource is later disabled, deleted, or changed incompatibly, the affected page, block, or action fails closed. The rest of the page remains usable.

Run preflight again after changing a referenced View, Form, template, field, or workflow launcher. Republish when the app definition or derived capability set must change.

## Verify the published journey {icon="checks"}

After publication:

:::steps
1. Open the stable URL as an ordinary account, not only as a base administrator.
2. Complete every primary journey, including refresh and browser Back.
3. Confirm that copied detail URLs preserve only declared parameters.
4. Try an inaccessible record ID and verify that the response reveals no record details.
5. Confirm that comments paginate, record lists remain bounded, and unrelated blocks render independently.
6. Change the draft and confirm that the published route remains unchanged until the next successful publication.
:::

For automated review and publication, use [YAML & CLI](/app/grids/help/grids-custom-app-yaml-cli).
