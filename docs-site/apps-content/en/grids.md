---
title: Grids
navTitle: Grids
section: Work
order: 140
description: Structured data with Bases, Views, Forms, Custom Apps, documents, and workflows.
tags: [grids, tables, workflows]
updated: 2026-08-19
---

# Grids

Grids builds structured applications from tables and records. A base can grow
from a simple shared dataset into forms, saved views, dashboards, generated
documents, and workflows without splitting the domain across unrelated tools.

## Use Grids

- Create a base for one operational domain, then define tables, fields, and
  relationships around its records.
- Review Table structure, indexed and unique fields, write paths, Durable
  History, and Finalization together in the admin-only **Tables** Base setting.
  Record totals stay out of this lightweight catalog.
- Save filtered or grouped views for recurring work and reporting.
- Publish Forms for guided record creation and Custom Apps for focused metrics,
  lists, instructions, and actions.
- Reuse a saved View's Cards layout and image cover in a Custom App, and expose
  bounded workflow row actions on Records blocks. Published Apps pin the View
  contract and recheck selected records server-side.
- Let signed-in App readers manage explicitly editable File fields from Record details
  without granting access to the Base record API.
- Replace or remove a record attachment without rewriting file history. Removal
  detaches it from the current record; protected revisions or artifacts can
  retain exact bytes, while unprotected files can be cleaned up.
- Let a Base admin set one optional retention floor for trashed Records and
  newly unreferenced Files. The retention preview opens paginated,
  server-filtered Record and File lists. Record review links into the existing
  table Trash view; File review supports read-only preview and exact-byte
  download. It neither deletes data nor makes a compliance claim.
- Let a Base admin create multiple preservation holds for the entire Base or
  one active Table, with a recorded reason for creation and release. A Base
  hold covers every Table. A Table hold covers only that Table and also blocks
  destruction of its parent Base so the hold cannot be bypassed. Records remain
  editable, access and Finalization do not change, and releasing a hold never
  starts deletion.
- Let a Base admin preview and start a durable, irreversible destruction run
  for at most 100 exact unreferenced File candidates whose retention floor has
  been reached. The admin confirms the exact Base name; every File is rechecked
  for retention, references, origin Table, and preservation holds immediately
  before deletion. Records, Documents, evidence exports, and Durable History
  are excluded. Remaining work can be canceled, but destroyed bytes cannot be
  recovered.
- Irreversibly enable Durable History for a stored table when every future
  Record, Relation, and File state must remain inspectable from an honest
  activation baseline. Existing tables stay unchanged until an admin opts in.
- Choose Direct Finalization for a Table when writers may lock reviewed Records
  themselves, or require Four-eyes Finalization with one Cloud approver group.
  The mode and approver group are applied atomically when Finalization is enabled.
  Four-eyes requests bind the exact current Record state, including Relations and Files; a different current
  group member with Write access approves and finalizes it through the same
  central service. Changing values, Relations, Files, trash state, or the policy
  invalidates open requests and never changes already finalized Records.
- Filter Records by **Draft**, **Awaiting review**, or **Finalized** in the
  Records metadata filter, GQL, or the CLI. Awaiting review means a current
  Four-eyes request still matches the Record and Table policy; it does not
  imply that the current viewer can approve it.
- Create the **Close selected Records** workflow starter for a stored Table
  when a reviewed selection of up to 100 Records should be closed together. Its Records
  action freezes the exact selected public IDs: Direct mode finalizes each
  eligible Record, while Four-eyes mode requests approval and never bypasses
  the configured approver. The preview also pins the complete Finalization
  policy revision, so a mode or approver change stops later steps instead of
  mixing policies. It does not close a period or capture Records added later.
- Keep the default open mutation policy, or let a Base admin limit record,
  Relation, and File changes to direct editing and APIs, Forms, or Workflows
  and actions. Every client follows the same server-enforced policy.
- Open a record's **Referenced by** section to page through permission-aware
  incoming Relations, or pin the same relationship as a Referenced records
  block in a Custom App.
- Keep relationships between compatible Form inputs, such as a start date that
  must not follow its due date, in server-enforced cross-field validation.
- Generate documents or PDFs from reviewed templates and record data.
- Download exact stored PDF bytes for completed document runs. **Generate again** creates a new immutable artifact.
- Use automatically provisioned durable number series for sequential ID fields
  and numbered Documents. Allocations are atomic and never reused; technical
  gaps are possible, and formatting changes affect future values only.
- Let a Base admin create a bounded evidence package for one Base or table.
  The short-lived TAR contains the selected current and historical sources,
  exact stored File and Document bytes, public Grids IDs, coverage statements,
  and SHA-256 hashes. It reports unavailable history rather than reconstructing
  it or making a compliance claim; ordinary CSV and JSON exports remain unchanged.
- Generate a per-record HTML value from Liquid and inline CSS when an email body, product description, or bounded export column should stay attached to the row rather than become a Document artifact.
- Run typed, versioned workflows for repeatable record changes, document
  generation, email delivery, and bounded HTTP calls.

Use formulas for derived values and workflows for multi-step effects that need
inputs, permissions, revisions, and observable runs.

## Understand the Grids model

| Resource | Responsibility |
| --- | --- |
| Base | Permission boundary and catalog for one structured application |
| Table, field, and record | Schema, typed columns, and stored domain rows |
| View and form | Reusable read perspective and guided record submission |
| Custom App | Immutable published capability surface for a focused audience |
| Document and workflow | Generated output and a versioned sequence of checked effects |

Base access opens the complete raw workspace and every record in that Base.
Tables, Views, Forms, document templates, and Workflows do not have separate
Cloud grants. Use a published Custom App when an authenticated or public
audience needs only selected data, Forms, documents, and actions. App readers
do not need Base access, and an app grant never opens raw Grids APIs or GQL.
Base grants support service accounts. Custom App grants support users, groups,
all authenticated accounts, or the public, but not service accounts. Delegated
credentials access a Custom App through their user identity.

Custom App pages, blocks, Forms, and actions can use server-enforced GQL
availability rules with request context such as `@auth.id`, `@auth.subjects`,
`@params.*`, and `@time.now`. A Principal field stores typed user and group
references. `@auth.subjects` flattens the signed-in user plus effective groups
to UUIDs, so `oneof(Participants, @auth.subjects)` supports individual and team
participation without exposing group membership. Public apps receive
`@auth.id = null` and `@auth.subjects = []`; Workflow actions still require an
authenticated account.

## How Grids fits Cloud

Grids owns its bases, schema, records, queries, views, forms, dashboards,
documents, and workflows. Cloud supplies identity, resource access,
notifications, background execution, audit and observability primitives, PDF
rendering, application discovery, and shared Help and administration surfaces.

## Find detailed product help

Open **Help** inside Grids for the core model, schema, formulas, Views, Forms,
Custom Apps, public publishing, documents, evidence exports, permissions, GQL,
workflows, and troubleshooting.
Developers can read [Resource authorization](/en/docs/identity/authorization),
[Workflow overview](/en/docs/automation/workflow-overview), and
[PDF and templates](/en/docs/platform/pdf-and-templates) for shared contracts
Grids adopts.

## Automate Grids from the terminal

Grids provides a native CLI module for every major resource area. These
read-oriented commands list bases and records from a chosen table:

```bash
cld grids list --json
cld grids records list --base "Operations" --table "Requests" --limit 20 --json
```

Run `cld grids help` for bases, schema, records, views, forms, Custom Apps,
documents, templates, and workflows. Run `cld grids <area> <command> --help`
before changing schema, data, access, or automation.
