---
id: grids-combined-tables
title: Combined tables
icon: ti ti-table-share
description: Publish one governed, read-only table across several Bases.
order: 122
---
A Combined table shows records from several stored tables as one governed, read-only table. Use it when teams keep working in separate Bases, but another audience needs one consistent dataset. That audience can use it for audit, reporting, search, Grids Apps, documents, workflows, or export.

For example, regional teams keep different Inventory Bases, and an audit Base publishes one **All inventory** table. Readers query its canonical Name, Status, and Location fields, even when the source tables use different names or select options.

Do not use a Combined table only to show a subset of one table. Use a view for that. Do not use it when readers must edit the source records through it, because the publication is read-only on purpose.

## Understand what a Combined table changes {icon="table"}

The target Base owns the Combined table, its canonical fields, and its views. People with **Manage** access to a source Base explicitly authorize selected source tables and field mappings. People with access to the target Base, or to a Grids App that includes the combined result, need no access to the source Bases. Search, filters, sorting, pagination, grouping, aggregation, Grids Apps, and exports work across all published sources, as they do for a stored table.

:::reference
- **Canonical fields:** Create the fields that readers see. Then map each source field to the matching canonical field. A missing mapping returns null for that source.
- **Independent publication:** Readers of the target receive only canonical data. They do not inherit the source navigation, hidden source fields, or the right to edit.
- **Read-only result:** Use the table in GQL, saved views, Grids Apps, documents, workflows, and exports. Creating records, forms, imports, uploads, edits, and deletes are unavailable.
- **Fail-closed publication:** A revoked, deleted, or incompatible source makes the complete published revision unavailable. Grids never returns a smaller partial result silently.
:::

## Create and publish a Combined table {icon="square-plus"}

You need **Manage** access to the target Base. To add a new source, you also need **Manage** access to the source Base.

:::steps
1. **Create the table:** Choose **New table** and select **Combined table**.
2. **Add canonical fields:** Add the fields that consumers query.
3. **Choose sources:** In **Edit mode**, open **Combined data**. The picker lists only stored tables in Bases where you have **Manage** access.
4. **Map fields:** Map stable source fields by identity.
5. **Map select options:** For each select field, map every source option explicitly.
6. **Validate:** Validation reports incomplete or incompatible mappings. It does not change the active publication.
7. **Publish:** Publish only after you resolve every diagnostic.
8. **Give access:** Give access to the target Base, or include the result in a Grids App.
:::

People with **Manage** access to a source Base can inspect the exact published field scope and revoke it independently.

:::note Who can publish
Publishing always requires **Manage** access to the target Base. **Manage** access to the source Base is required only for source scope that is new, wider, or restored after a revocation. You can keep, narrow, or remove existing mappings that were not revoked without a new authorization. A published authorization stays valid when the person who authorized it later loses that access. A person with **Manage** access to the source Base can revoke it explicitly.
:::

## Query the table and use it downstream {icon="search"}

GQL has no special syntax for Combined tables. Autocomplete shows only the canonical target fields. The same query can feed a records page, a saved view, a Grids App block, a document source, a workflow read, or a streaming export.

**Company-wide inventory**

```gql
from table "All inventory"
where Status = 'Available'
search 'camera'
sort Name asc
```

:::reference
- **Relations:** A canonical relation must point to one common stored target, or to another explicitly published Combined target that contains the related records.
- **Files:** People with access to the target Base and compiled Grids App capabilities can preview and download mapped files through the Combined publication boundary. Source file metadata and file changes stay private.
- **Computed data:** Mapped results need compatible types. Finalized source values stay frozen. Canonical formulas still calculate from them.
- **Object lists:** Source and target need identical column definitions, including IDs, types, units, and calculations. There is no mapping of single subcolumns.
- **Live data and export:** Source changes appear automatically. CSV and JSON exports can continue across all matching records.
:::

## Fix diagnostics {icon="lifebuoy"}

Draft diagnostics name the affected source, canonical field, and source field. A published table shows **Action required** when its fields or its access to a source are no longer valid.

:::steps
1. Repair the source or the mappings.
2. Validate the draft.
3. Publish a complete new revision.
:::

Revoked access returns only when you publish a newly authorized revision.

:::reference
- **No automatic matching:** Grids never guesses from labels, positions, or similar field types. Every exposed mapping is deliberate.
- **No nested Combined sources:** A Combined table can use only stored tables as sources. Use a canonical relation when related records also need federation.
- **No write-through to sources:** A Combined table cannot edit its source records. Workflows can read Combined data but cannot change the Combined target.
- **Explicit limits:** One Combined table supports up to 50 source tables and 200 canonical fields.
:::

## Inspect deleted records and history {icon="history"}

Combined tables keep the lifecycle of published records without giving access to their source Bases. A person with access to the target Base can choose **Show deleted** to inspect records that were deleted in a source table. Their detail panel is read-only and names the published source by Base and table name. To restore or edit the original record, use its source Base.

The record detail shows its published history. People with access to the target Base can also choose **Actions → Audit trail** to browse and filter the history of all published records. A person who uses a Grids App receives only the history that the published capability snapshot explicitly includes.

:::reference
- **Current publication:** Grids projects the history through the active canonical mappings. Fields removed from the publication no longer appear, also in older events.
- **Lifecycle events:** Created, updated, imported, deleted, and restored events stay visible while their source is actively published.
- **Required explanations:** Answers that an audit policy collects, such as a required deletion reason, stay attached to the event with their question labels.
- **Private source details:** The Combined table does not expose unpublished fields and values, technical request details, or the navigation of the source Base.
- **Changed select options:** An old source option without an active canonical mapping appears as unavailable. Grids does not expose its source identifier.
- **Fail closed:** Revoked, degraded, or incompatible publications return no partial history. Repair the Combined table and publish it again before you continue.
:::

## Run the lifecycle from the CLI {icon="code"}

The CLI accepts exact names or 6-character public IDs. The mapping body is JSON, not a separate configuration language. Run `cld grids tables combined candidates` to discover sources that you can authorize. Validate before you save or publish.

**Create, inspect, publish, and revoke**

```text
cld grids tables add Reporting --name "All inventory" --kind federated --json
cld grids fields create Reporting "All inventory" --name Name --type text --json
cld grids tables combined candidates Reporting "All inventory" --json
cld grids tables combined validate Reporting "All inventory" --body-file combined.json --json
cld grids tables combined draft Reporting "All inventory" --body-file combined.json --json
cld grids tables combined get Reporting "All inventory" --json
cld grids tables combined publish Reporting "All inventory" --json

cld grids tables combined publications "Warehouse East" Items --json
cld grids tables combined revoke "Warehouse East" Items \
  --target-table <combined-table-id> \
  --yes

cld grids records audit list Reporting "All inventory" --action deleted
```

**Friendly mapping body**

```text
{
  "sources": [
    {
      "base": "Warehouse East",
      "table": "Items",
      "mappings": [
        { "target": "Name", "source": "Title" },
        {
          "target": "Status",
          "source": "State",
          "options": { "In stock": "Available" }
        }
      ]
    }
  ]
}
```

:::note Control a source Base
People with **Manage** access to a source Base can inspect its publications with `cld grids tables combined publications`. They can revoke one with `cld grids tables combined revoke`. The revoke command resolves the stored source from its Base and table arguments. It takes the public ID of the Combined table from `--target-table`. A revocation makes the target revision unavailable immediately.
:::
