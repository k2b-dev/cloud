---
id: grids-permissions
title: Permissions
icon: ti ti-lock
description: Choose between complete Base access and a bounded Grids App.
order: 145
---
Grids has two Cloud permission boundaries: a **Base** for the complete raw workspace and a **Grids App** for one published, task-focused surface. Tables, Views, Forms, document templates, and Workflows do not have separate Cloud grants.

Cloud administrators are not automatic Grids superusers. They can manage Grids from the administration area, but normal Grids pages still require Base access.

## Grant access to a Base {icon="database"}

A Base grant applies to every table, field, record, View, Form, document template, and Workflow in that Base.

Base grants support users, groups, service accounts, and all authenticated accounts. They do not support public principals.

| Level | What it allows |
| --- | --- |
| **Read** | Read the complete schema and every record in the Base, including Views, GQL results, exports, and generated output. |
| **Write** | Read plus create, update, and delete records, submit Forms, generate documents, and run allowed Base operations. |
| **Admin** | Write plus change schema and configuration, manage access, and create, edit, or publish Grids Apps. |
| **None** | Explicitly deny Base access. |

Base access cannot be narrowed to one table, View, Form, Workflow, or creator. If an audience must see only selected data or actions, publish a Grids App or separate the data into another Base.

Record creator metadata remains available as normal data. For example, GQL can compare `record.createdBy` with `@auth.id` inside a Grids App. That query controls the published result; it is not a hidden row-permission system.

## Share a Grids App {icon="app-window"}

A Grids App has its own **Read** or **None** grants. Grant it to a user, group, all authenticated accounts, or the public. A public grant includes anonymous visitors. Grids App grants do not support service accounts; delegated credentials use their user identity.

App readers do not need Base access. They receive only the data, Forms, fields, documents, and actions compiled into the immutable published snapshot. App access never grants the raw Grids workspace, direct table or record APIs, arbitrary GQL, or an editable source View.

Only a Base administrator can edit, preview, publish, reset, delete, or manage access for a Grids App. Drafts and previews are never public.

Before publishing publicly, review the capability summary in the builder. It identifies the data sources, writable Form fields, and other operations exposed by the publication. Use separate public and authenticated apps when the two audiences need different capabilities.

## Understand server enforcement {icon="shield-lock"}

The published definition and capability snapshot are enforced on the server. Page, block, Form, and action availability is checked again when the resource is requested; hiding a control in the browser is not authorization.

An unavailable page, block, Form, or action returns **Not Found** and does not execute its query or mutation. Public app reads and submissions use the same boundary with anonymous context. Workflow actions require an authenticated account.

## Keep narrow public links narrow {icon="world"}

Public Forms and expiring document links remain token-based surfaces:

- a public Form token allows submission to that Form, not browsing the Base;
- an expiring document link allows downloading one generated document until it expires or is revoked.

These links do not create table-, Form-, or template-level Cloud permissions.

## Manage access from the CLI {icon="terminal-2"}

```text
cld grids access set base MyBase --group "Operations" --permission write
cld grids access grant app MyBase "Public catalog" --public --permission read
cld grids access list app MyBase "Public catalog"
cld grids access revoke app MyBase "Public catalog" --public --yes
```

Use `cld grids access reference` for the installed resource, permission, and principal contract.
