---
id: grids-evidence-exports
title: Export an evidence package
icon: ti ti-package-export
description: Create and verify a bounded package of the evidence that Grids currently holds.
order: 147
---
An evidence export captures one Base or one table at a stated cut. It packages the selected current and historical sources with a manifest and SHA-256 hashes. Use it when another person or system needs a reviewable handoff, not an editable CSV or JSON dataset.

:::warning Not a compliance certificate
An evidence package reports the evidence that Grids has and names missing history. It does not reconstruct events from before Durable History was enabled.
:::

You need **Manage** access to the Base. Grids Apps, workflows, API clients, and the CLI cannot bypass this requirement.

## Check the available evidence {icon="chart-bar"}

Open **Base settings → Evidence exports**. Grids calculates **Available evidence** from the Base when the page opens. It is not a saved score, and it does not enable or change anything.

The summary counts current and deleted records, saved revisions and audit events, stored file and document bytes, number series, and durable number allocations. To inspect each table, choose **Review Table coverage**. The **History** column shows one of these states:

:::reference
- **Active since** a date: Durable History has completed its baseline. The date is the earliest coverage that Grids can claim.
- **Building baseline:** The activation is still copying the current baseline. Coverage is not complete yet.
- **Earlier states unavailable:** The table already had records when Durable History was enabled. Grids cannot reconstruct earlier states.
- **Not enabled:** An empty table has no durable revision history yet.
- **Incomplete:** The saved activation state and the baseline completion do not agree. Treat the coverage as incomplete and ask the operator to investigate.
:::

The **Finalized** column is separate, because enabling Durable History does not finalize records. It shows **Not enabled** or the number of records that are currently finalized. Tables in the trash stay visible as evidence sources, but you cannot open them from this list.

## Create a package {icon="package-export"}

:::steps
1. Open **Base settings → Evidence exports**.
2. Choose **New export**.
3. Choose **Complete Base** or one table.
4. Optional: Set a **Period** for revisions, audit events, documents, and number allocations. Current records and live relations always come from the export cut.
5. Keep all evidence selected, or clear the sections that the recipient does not need.
6. Read the scope check. If the known scope exceeds a package budget, narrow the table, the period, or the sections.
7. Choose **Queue export**. The list of recent packages shows the job as **Queued**, **Running**, or **Completed**.
8. Choose **Download** while the completed package is available.
:::

The package expires after seven days. Expiry removes its stored bytes. If the recipient still needs a package, create a new export.

## Understand what the package includes {icon="list-check"}

| Section | Evidence source |
| --- | --- |
| **Records** | Current and deleted stored records at the cut, including the finalization state |
| **Durable History** | Available immutable record revisions and their schema meaning |
| **Audit** | Saved mutation events, actor labels, answers, and request context |
| **Schema and configuration** | Base, tables, fields, policies, finalization settings, templates, and schema snapshots |
| **Relations** | Current links that relations and **Referenced by** use. Historical relation state stays in the revisions. |
| **Files** | Current and revision-protected attachment bytes with their saved hashes |
| **Document artifacts** | Exact stored document bytes, record snapshots, render data, renderer metadata, validation evidence, and every exact artifact. Grids renders nothing again. |
| **Number allocations** | Number series, format versions, and allocated values |

References to Grids resources use their six-character public IDs. A UUID-shaped value without a public ID in the selected Grids scope appears as a stable private reference. This keeps internal identifiers private. The same source value receives the same private reference within the package.

Every document belongs to a Grids table and a record. With **Document artifacts** selected, a table-scoped package includes that table's Documents within the selected date range. A Base-scoped package covers the tables of the Base. Both include the exact stored artifacts and their metadata.

## Create a package from the CLI {icon="terminal-2"}

The CLI offers `cld grids evidence preflight`, `create`, `list`, `get`, `retry`, `cancel`, and `download`. `preflight` and `create` accept `--base` and an optional `--body-file` with `tableId`, `from`, `to`, and `sections`. `create`, `retry`, and `cancel` require `--yes`. You need the same **Manage** access to the Base.

Check the returned status before you download. An accepted request does not mean that the package is complete.

## Verify the download {icon="shield-check"}

:::steps
1. Before you download, choose **Details** on the package.
2. Keep the **Package SHA-256** and **Manifest SHA-256** values with the handoff.
3. Download the package.
4. In **Package details**, choose **Copy command** under **Offline verification**.
5. Run the copied command where the TAR file is stored.
:::

```bash
cld grids evidence verify package.tar \
  --sha256 <package-sha256> \
  --manifest-sha256 <manifest-sha256>
```

The verifier reads the TAR locally. It does not upload or extract it. It validates the safe archive shape and checks every file that the manifest declares. It prints the scope, cut, sections, counts, and available history coverage. Use `--json` for a machine-readable result. A failed check exits with a non-zero status.

The command runs offline. It needs no configured Cloud server and no sign-in. If `cld` is unavailable, do the same checks manually:

:::steps
1. Calculate the SHA-256 of the complete TAR file. Compare it with **Package SHA-256**.
2. Extract the TAR without editing it.
3. Calculate the SHA-256 of `manifest.json`. Compare it with **Manifest SHA-256**.
4. For each file that you rely on, calculate its SHA-256. Compare it with the matching manifest entry.
5. Read the scope, cut, selected sections, counts, limits, and history coverage in the manifest before you draw conclusions.
:::

A successful verification shows that the bytes match the package manifest and any expected hashes from the handoff. It does not show who had the file after the download. It does not prove authorship or custody, and it makes no legal claim about the records.

## Recover from a failed or incomplete request {icon="lifebuoy"}

:::reference
- **Scope could not be checked:** Choose **Retry**. If it fails again, keep the chosen scope and the error message for the operator.
- **Known scope is too large:** Choose one table, shorten the period, or export fewer sections. Grids fails the job when a package crosses a runtime limit. It never truncates a package silently.
- **Failed** or **Canceled:** Choose **Retry** to queue a fresh attempt. A retry takes a new cut, so it is not the same package.
- **Queued** or **Running**, but no longer needed: Choose **Cancel**. The cancellation can take a moment while the current bounded read stops.
- **Expired:** Create a new export. You cannot download the bytes of an expired package again.
:::

Ordinary CSV and JSON exports are unchanged. Use them for data transfer or analysis, when you do not need a hash-verifiable evidence handoff.
