---
id: grids-retention-preservation
title: Retention and preservation
icon: ti ti-archive
description: Set a technical retention floor, preserve a Base or Table, or destroy eligible unreferenced File bytes.
order: 148
---
A retention floor is an optional technical minimum for trashed Records and newly unreferenced Files in a Base. It does not delete anything, schedule cleanup, decide whether destruction is appropriate, or establish legal compliance.

You need **Admin** access to the Base. Custom Apps, Workflows, API clients, and the CLI cannot bypass this permission check.

## Set the floor {icon="calendar-time"}

1. Open the Base settings and select **Retention**.
2. Enter **Minimum retention days** between 1 and 36,500.
3. Review the live **Retention preview**. It distinguishes Records and unreferenced Files still retained by the proposed floor, items that have reached the floor, and evidence protected independently.
4. Select **Review Records** to inspect the complete paginated list. **Open in Trash** hands restoration or record actions to the existing table Trash view.
5. Select **Review Files** to search and filter every currently unreferenced File. You can preview supported formats or download the exact stored bytes.
6. Select **Save changes**.

Existing Bases have no retention floor by default, so their behavior does not change. The clock starts when a Record is moved to trash. Restoring and later trashing it starts a new clock from the new trash timestamp.

You can inspect and manage the same Base setting from the Cloud CLI. Use a 6-character Base ID or its exact name:

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

The CLI calls the same Admin-only API as Base settings. A script, Workflow, Custom App, or direct API client cannot bypass the floor or its permission check.

The preview uses one stated observation time and returns bounded examples. **Reached the floor** means only that the configured number of days has elapsed. It does not mean that Grids deleted the Record or File or that deletion is permitted.

**Review Records** and `bases retention records list` search Record ID, Table ID, or Table name and filter the current Trash set on the server. Finalized Records are labelled as independently protected. The review does not duplicate Trash actions: use **Open in Trash** to inspect or restore a Record through the normal table view.

## Understand File retention {icon="paperclip"}

When an attachment loses its last current or protected reference, Grids normally cleans up its stored bytes. With a retention floor active, Grids instead keeps newly unreferenced bytes until the same minimum time has elapsed.

The ledger shows how many unreferenced Files are retained until later, how many have reached the floor, and their total stored size. **Review Files** opens the complete current candidate list with server-side filename or File ID search, a floor-status filter, and pagination. Supported formats can be viewed read-only; every listed File can be downloaded. The list reflects the proposed number of days, including an unsaved draft.

The CLI uses the same Admin-only list and download boundary:

```bash
cld grids bases retention files list 8yMtTb --days 30 --search invoice --status all --json
cld grids bases retention files download 8yMtTb HeUB3M --out ./retained-file.bin
```

Current attachments and Files retained by Durable History or immutable Documents are protected by those owners and are not listed as unreferenced candidates.

Replacing or removing an attachment can create a candidate. A new protection removes it from the list; when the last protection is later released, its retention clock starts again. Review and download stay inside this Admin-only retention surface; the normal Record API still cannot expose an unreferenced File.

## Change or remove the floor {icon="edit"}

Increasing the number preserves affected trashed Records and unreferenced Files longer. Shortening or removing it may make future controlled destruction eligible earlier, so Grids asks for confirmation. Neither action deletes anything immediately.

Durable History revisions, finalized Records, immutable Documents, Number allocations, protected Files, preservation holds, and actual controlled destruction keep their separate lifecycle contracts.

## Destroy eligible unreferenced Files {icon="trash-x"}

Controlled File destruction permanently removes stored bytes for newly unreferenced Files after the Base retention floor has been reached. It never includes Records, trashed Records, Documents, evidence exports, Durable History, or indirect references promised by another owner.

You need **Admin** access and an active retention floor. Open **Base settings → Controlled destruction**. The preview shows the current eligible total and separates Files that are still retained, blocked by a preservation hold, or cannot be destroyed safely. One run contains at most 100 exact File candidates.

Select **Destroy eligible Files**, read the irreversible consequence, and type the exact Base name. Grids queues a durable run and checks every File again immediately before deletion. If its retention floor, references, origin Table, or preservation holds changed, that File is skipped. The run can therefore finish as **partial** without weakening a hold or deleting a newly referenced File.

The recent-run list shows destroyed, skipped, and failed counts. **Cancel remaining** stops Files that have not been processed yet; bytes already destroyed cannot be recovered. Refresh the preview to start another bounded batch.

The Cloud CLI uses the same Admin-only preview and run owner:

```bash
cld grids bases destruction preview 8yMtTb --json
cld grids bases destruction run 8yMtTb --confirm "Example Base" --json
cld grids bases destruction status 8yMtTb RUN001 --json
cld grids bases destruction cancel 8yMtTb RUN001 --yes --json
```

`run` always fetches a fresh preview and selects only that bounded set. The command refuses an empty batch or a `--confirm` value that does not exactly match the Base name. A queued run can be canceled immediately; a running run stops its remaining work at the next safe boundary.

## Preserve a Base or one Table {icon="lock"}

A preservation hold blocks future controlled destruction in its selected scope. A Base hold covers every Table. A Table hold covers only the selected Table and also blocks destruction of its parent Base so the Table hold cannot be bypassed. Holds do not lock Records, stop normal edits, grant access, change Finalization, expire automatically, or decide that the Base meets a legal requirement.

You need **Admin** access. Open **Base settings → Preservation holds**, then select **Create hold**. Choose **Entire Base** or **One Table**. Table search runs on the server and lists active Tables in this Base. Enter a reason that tells other administrators why the hold exists. The active-hold list shows the scope, public ID, creator, creation time, and reason.

More than one hold can be active. Releasing one hold requires a new reason and leaves every other hold active. Releasing the last hold only removes that block; it does not delete anything or start cleanup.

The Cloud CLI uses the same Admin-only API:

```bash
cld grids bases preservation-holds list 8yMtTb --status active --json
cld grids bases preservation-holds create 8yMtTb --reason "Annual review" --json
cld grids bases preservation-holds create 8yMtTb --scope table --table Invoices --reason "Invoice dispute" --json
cld grids bases preservation-holds list 8yMtTb --scope table --table Invoices --status active --json
cld grids bases preservation-holds release 8yMtTb HOLD01 --reason "Review completed" --yes --json
```

Create defaults to `--scope base`. Use `--status released` or `--status all` to inspect older holds, and `--scope base|table|all` to narrow the list. An exact Table name resolves an active Table; its six-character public ID can still filter hold history after the Table is no longer active. Table lookup, filtering, and pagination run on the server. A Workflow, Custom App, direct API client, or background action cannot release or bypass an active hold through another path.
