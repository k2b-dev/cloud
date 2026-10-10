---
id: grids-permissions
title: Control access
icon: ti ti-lock
description: Choose between complete access to a Base and a bounded Grids App.
order: 145
---
Grids controls access in two places. Access to a **Base** covers its complete raw workspace. Access to a **Grids App** covers only that published, task-focused app. Tables, views, forms, document templates, and workflows have no separate Cloud access.

Cloud administrators are not automatic Grids superusers. They can configure Grids in the administration area, but normal Grids pages still require access to the Base.

## Give access to a Base {icon="database"}

Access to a Base applies to every table, field, record, view, form, document template, and workflow in that Base.

You can give access to users, groups, service accounts, and all signed-in accounts. You cannot give public access to a Base.

| Level | CLI value | What it allows |
| --- | --- | --- |
| **View** | `read` | Read the complete schema and every record in the Base, including views, GQL results, exports, and generated output. |
| **Edit** | `write` | Everything in **View**. Create, update, and delete records, submit forms, generate documents, and run allowed Base operations. |
| **Manage** | `admin` | Everything in **Edit**. Change the schema and the configuration, change access, and create, edit, or publish Grids Apps. |
| **No access** | `none` | Deny access to the Base explicitly. |

### Keep a manager on the Base

A Base always keeps at least one manager. A manager is a **Manage** entry for a person, a group, all signed-in accounts, or a standalone or agent service account. API keys bound to the Base do not count.

- Grids refuses to lower or remove the last manager.
- Grids refuses **No access** for the same person, group, or account as that manager.
- A **Manage** entry does not count while the same person, group, or account also has **No access**.
- When only one manager counts, the access settings lock that entry.

To hand a Base over, give the new manager **Manage** access first. A Base can still lose its manager, for example when the account is deleted. Then a Cloud administrator adds a new manager in the administration area.

Grids counts a group's **Manage** entry without checking its members. For a member, the member's own entry, or **No access** for another of their groups, still decides first. So when you hand a Base over, give **Manage** access to the person directly.

### Narrow access with an app or a separate Base

You cannot limit access to a Base to one table, view, form, workflow, or creator. If an audience can see only selected data or actions, publish a Grids App or move the data to another Base.

The creator of a record stays available as normal data. For example, GQL in a Grids App can compare `record.createdBy` with `@auth.id`. That query controls the published result. It is not a hidden system for row access.

## Share a Grids App {icon="app-window"}

A Grids App has its own access. Its only level is **Open** (`read`), and `none` denies access. You can give access to a user, a group, all signed-in accounts, or the public. Public access includes anonymous visitors. You cannot give a service account direct access to a Grids App. Delegated credentials use their user identity.

People who use the app do not need access to the Base. They receive only the data, forms, fields, documents, and actions that are compiled into the immutable published snapshot. Access to an app never gives the raw Grids workspace, direct table or record APIs, arbitrary GQL, or an editable source view.

Editing, previewing, publishing, resetting, or deleting a Grids App, and changing its access, require **Manage** access to the Base. Drafts and previews are never public.

Before you publish to the public, review the capability summary in the builder. It lists the data sources, writable form fields, and other operations that the publication exposes. Use separate public and signed-in apps when the two audiences need different capabilities.

## Understand server enforcement {icon="shield-lock"}

The server enforces the published definition and the capability snapshot. It checks again whether a page, block, form, or action is available each time someone requests it. Hiding a control in the browser is not authorization.

An unavailable page, block, form, or action returns a not-found error. Its query or mutation does not run. Public app reads and submissions use the same boundary with an anonymous context. Workflow actions require a signed-in account.

## Keep narrow public links narrow {icon="world"}

Public forms and expiring document links stay token-based:

- A public form token allows submissions to that form. It does not allow browsing the Base.
- An expiring document link allows downloading one generated document until the link expires or someone revokes it.

These links do not create Cloud access to a table, form, or template.

## Change access from the CLI {icon="terminal-2"}

```text
cld grids access set base MyBase --group "Operations" --permission write
cld grids access grant app MyBase "Public catalog" --public --permission read
cld grids access list app MyBase "Public catalog"
cld grids access revoke app MyBase "Public catalog" --public --yes
```

Run `cld grids access reference` for the installed contract of resources, access levels, and principals.
