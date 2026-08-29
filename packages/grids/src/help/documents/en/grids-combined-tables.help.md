---
id: grids-combined-tables
title: Combined tables
icon: ti ti-table-share
description: Publish one governed read-only table across several bases.
order: 122
---
A Combined table presents records from several stored tables as one governed, read-only table. It is useful when teams should keep operating in separate bases but another audience needs one consistent dataset for audit, reporting, search, Grids Apps, documents, workflows, or export.

For example, regional teams can keep different Inventory bases while an audit base publishes one **All inventory** table. Readers query its canonical Name, Status, and Location fields even when the source tables use different names or select options.

Do not use a Combined table merely to show a subset from one table; use a view for that. Do not use it when readers must edit the source records through the combined surface, because publication is deliberately read-only.

## What a Combined table changes {icon="table"}

The target Base owns the Combined table, its canonical fields, and its Views. Source admins explicitly authorize selected source tables and field mappings. Target Base readers, or readers of a Grids App that includes the Combined result, need no access to the source Bases. Search, filters, sorting, pagination, grouping, aggregation, Grids Apps, and exports work across all published sources as they do for a stored table.

:::reference
- **Canonical fields:** Create the fields readers should see, then map each source field to the matching canonical field. Missing mappings return null for that source.
- **Independent publication:** Target readers receive only canonical data. They do not inherit source navigation, hidden source fields, or editing rights.
- **Read-only result:** Use the table in GQL, saved views, Grids Apps, documents, workflows, and exports. Record creation, forms, imports, uploads, edits, and deletes are unavailable.
- **Fail-closed publication:** A revoked, deleted, or incompatible source makes the complete published revision unavailable. Grids never returns a silently smaller partial result.
:::

## Create and publish {icon="square-plus"}

:::steps
1. **Create the Combined table:** Choose New table, select Combined table, and add the canonical fields that consumers should query.
2. **Choose sources:** Open Combined data in edit mode. The picker lists only stored tables whose base you may administer.
3. **Map fields and select options:** Map stable source fields by identity. Select fields also require an explicit mapping for every source option.
4. **Validate and publish:** Validation reports incomplete or incompatible mappings without changing the active publication. Publish only after every diagnostic is resolved.
5. **Operate the published table:** Grant access to the target Base or include the result in a Grids App. Source admins can inspect the exact published field scope and revoke it independently.
:::

:::note Publication authority
Publishing always requires admin access to the target base. Source-base admin access is required only for source scope that is new, broadened, or being restored after revocation. Existing unrevoked mappings may be retained, narrowed, or removed without reauthorization. A published grant remains valid if the authorizing admin later loses their role; a source-base admin can explicitly revoke it.
:::

## Query and downstream behavior {icon="search"}

GQL has no special Combined-table syntax. Autocomplete exposes only the canonical target fields, and the same query can back a records page, saved view, Grids App block, document source, workflow read, or streaming export.

**Company-wide inventory**

```gql
from table "All inventory"
where Status = 'Available'
search 'camera'
sort Name asc
```

:::reference
- **Relations:** A canonical relation must point to one common stored target or to another explicitly published Combined target containing the related records.
- **Files:** Target Base readers and compiled Grids App capabilities can preview and download mapped files through the Combined publication boundary. Source file metadata and file mutation remain private.
- **Computed data:** Canonical formulas can use the combined fields. A computed source field can be mapped only when its result is compatible with the canonical field.
- **Live data and export:** Source changes appear automatically. CSV and JSON exports can continue across all matching records.
:::

## Diagnostics and repair {icon="lifebuoy"}

Draft diagnostics identify the affected source, canonical field, and source field. A published table shows Action required when its fields or source access are no longer valid. Repair the source or mappings, validate the draft, and publish a complete new revision. Revoked access is restored only by publishing a newly authorized revision.

:::reference
- **No automatic matching:** Labels, positions, and similar field types are never guessed. Every exposed mapping is deliberate.
- **No nested Combined sources:** A Combined table can source stored tables only. Use a canonical relation when related records also need federation.
- **No source write-through:** A Combined table cannot edit its source records. Workflows may read Combined data but cannot change the Combined target.
- **Explicit limits:** One Combined table supports up to 50 source tables and 200 canonical fields.
:::

## Deleted records and history {icon="history"}

Combined tables preserve the lifecycle of published records without granting access to their source Bases. A target Base reader can choose **Show deleted** to inspect records that were deleted in a source table. Their detail panel is read-only and identifies the published source by Base and table name. Restore or edit the original record from its source Base.

The record detail shows its published history. Target Base readers can also choose **Actions → Audit trail** to browse and filter history across all published records. A Grids App reader receives only the history explicitly included by the published capability snapshot.

:::reference
- **Current publication:** History is projected through the active canonical mappings. Fields removed from the publication no longer appear, including in older events.
- **Lifecycle events:** Created, updated, imported, deleted, and restored events remain visible while their source is actively published.
- **Required explanations:** Answers collected by an audit policy, such as a required deletion reason, remain attached to the event with their question labels.
- **Private source details:** Unpublished fields and values, technical request details, and source-base navigation are not exposed through the Combined table.
- **Changed select options:** An old source option that no longer has an active canonical mapping is shown as unavailable instead of exposing its source identifier.
- **Fail closed:** Revoked, degraded, or incompatible publications return no partial history. Repair and republish the Combined table before continuing.
:::

## CLI lifecycle {icon="code"}

The CLI accepts exact names or 6-character public IDs. The mapping body is JSON rather than a separate configuration language. Use `cld grids tables combined candidates` to discover authorizable sources, then validate before saving or publishing.

**Create, inspect, publish, and revoke**

```text
cld grids tables create Reporting --name "All inventory" --kind federated --json
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

:::note Source-admin control
Source admins can inspect grants with `cld grids tables combined publications` and revoke one with `cld grids tables combined revoke`. The revoke command resolves the stored source from its base and table arguments and takes the Combined table public ID from `--target-table`. Revocation immediately makes the target revision unavailable.
:::
