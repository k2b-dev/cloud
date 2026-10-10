---
id: grids-retention-preservation
title: Retention and preservation
icon: ti ti-archive
description: Set a technical retention floor, preserve a Base or table, or destroy eligible unreferenced file bytes.
order: 148
---
A retention floor is an optional technical minimum for trashed records and newly unreferenced files in a Base.

:::warning A floor is not a legal decision
A retention floor does not delete anything and does not schedule a cleanup. It does not decide whether destruction is appropriate, and it does not establish legal compliance.
:::

You need **Manage** access to the Base. Grids Apps, workflows, API clients, and the CLI cannot bypass this access check.

## Set the floor {icon="calendar-time"}

:::steps
1. Open **Base settings → Retention**.
2. Enter **Minimum retention days**, from 1 to 36,500.
3. Review the live **Retention preview**.
4. Choose **Review Records** to inspect the complete list, page by page.
5. Choose **Review Files** to search and filter every file that is currently unreferenced.
6. Choose **Save changes**.
:::

The **Retention preview** separates three groups: records and unreferenced files that the proposed floor still keeps, items that have reached the floor, and evidence that is protected independently.

In **Review Records**, **Open in Trash** opens the existing Trash view of the table for restoring or other record actions. In **Review Files**, you can preview supported formats or download the exact stored bytes.

Existing Bases have no retention floor by default, so their behavior does not change. The clock starts when someone moves a record to the trash. If someone restores the record and moves it to the trash again, a new clock starts from the new trash time.

You can inspect and change the same Base setting from the Cloud CLI. Use the 6-character Base ID or the exact Base name:

```bash
cld grids bases retention 8yMtTb --json
cld grids bases retention preview 8yMtTb --days 30 --json
cld grids bases retention records list 8yMtTb --days 30 --status retained --page 1 --per-page 25 --json
cld grids bases retention files list 8yMtTb --days 30 --status retained --page 1 --per-page 25 --json
cld grids bases retention set 8yMtTb --days 30 --json
```

Shortening an existing floor requires `--yes`. Removing it always requires `--yes`:

```bash
cld grids bases retention set 8yMtTb --days 14 --yes --json
cld grids bases retention remove 8yMtTb --yes --json
```

The CLI calls the same API as Base settings, which requires **Manage** access. A script, workflow, Grids App, or direct API client cannot bypass the floor or its access check.

The preview uses one stated observation time and returns bounded examples. **Floor reached** means only that the configured number of days has passed. It does not mean that Grids deleted the record or file, and it does not mean that deletion is allowed.

**Review Records** and `bases retention records list` search by record ID, table ID, or table name. They filter the current Trash set on the server. Finalized records carry the label of independently protected records. The review does not repeat the Trash actions. Use **Open in Trash** to inspect or restore a record through the normal table view.

## Understand file retention {icon="paperclip"}

When an attachment loses its last current or protected reference, Grids normally cleans up its stored bytes. While a retention floor is active, Grids keeps newly unreferenced bytes until the same minimum time has passed.

The ledger shows how many unreferenced files Grids keeps until later, how many have reached the floor, and their total stored size. **Review Files** opens the complete current list of candidates. It offers a server-side search by filename or file ID, a filter for the floor status, and pagination. You can view supported formats read-only and download every listed file. The list uses the proposed number of days, including an unsaved draft.

The CLI uses the same list and download boundary, which requires **Manage** access:

```bash
cld grids bases retention files list 8yMtTb --days 30 --search invoice --status all --json
cld grids bases retention files download 8yMtTb HeUB3M --out ./retained-file.bin
```

The owners of current attachments, Durable History, and immutable documents protect their files. These files do not appear as unreferenced candidates.

Replacing or removing an attachment can create a candidate. A new protection removes it from the list. When the last protection is later released, its retention clock starts again. Review and download stay inside this retention area, which requires **Manage** access. The normal record API still cannot expose an unreferenced file.

## Change or remove the floor {icon="edit"}

A higher number keeps affected trashed records and unreferenced files longer. A shorter floor or no floor can make future controlled destruction eligible earlier, so Grids asks for a confirmation. Neither change deletes anything immediately.

Durable History revisions, finalized records, immutable documents, number allocations, protected files, preservation holds, and the actual controlled destruction keep their own lifecycle rules.

## Destroy eligible unreferenced files {icon="trash-x"}

Controlled file destruction permanently removes the stored bytes of newly unreferenced files after the retention floor of the Base is reached. It never includes records, trashed records, documents, evidence exports, Durable History, or indirect references that another owner protects.

You need **Manage** access and an active retention floor. Open **Base settings → Controlled destruction**. The preview shows the current eligible total. It separates files that are still retained, blocked by a preservation hold, or not safe to destroy. One run contains at most 100 exact file candidates.

:::danger You cannot undo destruction
Destroyed file bytes cannot be recovered.
:::

:::steps
1. Choose **Destroy eligible Files**.
2. Read the irreversible consequence.
3. Type the exact Base name.
4. Choose **Start destruction**.
:::

Grids queues a durable run and checks every file again immediately before deletion. If the retention floor, the references, the origin table, or the preservation holds of a file changed, Grids skips that file. The run can therefore end as **Partially completed**. It never weakens a hold and never deletes a newly referenced file.

The list of recent runs shows the destroyed, skipped, and failed counts. **Cancel remaining** stops the files that Grids has not processed yet. Bytes that are already destroyed stay destroyed. To start another bounded batch, refresh the preview.

The Cloud CLI uses the same preview and run, which require **Manage** access:

```bash
cld grids bases destruction preview 8yMtTb --json
cld grids bases destruction run 8yMtTb --confirm "Example Base" --json
cld grids bases destruction status 8yMtTb RUN001 --json
cld grids bases destruction cancel 8yMtTb RUN001 --yes --json
```

`run` always fetches a fresh preview and selects only that bounded set. The command refuses an empty batch and a `--confirm` value that does not match the Base name exactly. You can cancel a queued run immediately. A running run stops its remaining work at the next safe boundary.

## Preserve a Base or one table {icon="lock"}

A preservation hold blocks future controlled destruction in its scope. A Base hold covers every table. A table hold covers only the selected table. It also blocks the destruction of its parent Base, so nobody can bypass the table hold.

A hold does not lock records, stop normal edits, give access, change finalization, or expire automatically. It does not decide that the Base meets a legal requirement.

You need **Manage** access.

:::steps
1. Open **Base settings → Preservation holds**.
2. Choose **Create hold**.
3. Choose **Entire Base** or **One Table**.
4. For one table, search for it. The server-side search lists the active tables in this Base.
5. Enter a reason that tells other people with **Manage** access why the hold exists.
6. Create the hold.
:::

The list of active holds shows the scope, public ID, creator, creation time, and reason.

Several holds can be active at the same time. Releasing one hold requires a new reason and keeps every other hold active. Releasing the last hold only removes that block. It does not delete anything and does not start a cleanup.

Search active holds by reason, table name, creator, or hold ID. The list is paginated, so every matching hold stays reachable. If creating or releasing a hold fails, the dialog keeps your reason and shows the error, so you can try again.

The Cloud CLI uses the same API, which requires **Manage** access:

```bash
cld grids bases preservation-holds list 8yMtTb --status active --json
cld grids bases preservation-holds list 8yMtTb --search "Invoice dispute" --page 1 --json
cld grids bases preservation-holds create 8yMtTb --reason "Annual review" --json
cld grids bases preservation-holds create 8yMtTb --scope table --table Invoices --reason "Invoice dispute" --json
cld grids bases preservation-holds list 8yMtTb --scope table --table Invoices --status active --json
cld grids bases preservation-holds release 8yMtTb HOLD01 --reason "Review completed" --yes --json
```

`create` uses `--scope base` by default. Use `--status released` or `--status all` to inspect older holds. Use `--scope base|table|all` to narrow the list. An exact table name resolves an active table. Its six-character public ID can still filter the hold history after the table is no longer active. Table lookup, filtering, and pagination run on the server. A workflow, Grids App, direct API client, or background action cannot release or bypass an active hold through another path.
