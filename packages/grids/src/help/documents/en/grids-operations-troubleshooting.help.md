---
id: grids-operations-troubleshooting
title: Operations & troubleshooting
icon: ti ti-bolt
description: Diagnose common problems without guessing or losing work.
order: 150
---
## Reload after the Base structure changed {icon="refresh"}

When someone else changes the structure of the area you work in, one **Reload** notice appears. The page never reloads on its own, and saving keeps working.

Structure means the name and fields of a table, the source and table of a view, or the definition of an app. Column widths, display modes, view layouts, field order, and changes elsewhere in the Base show no notice. Your own edits in this tab never show the notice.

Open inputs stay intact until you confirm **Reload**. If a save no longer fits the current structure, for example a value for a deleted field, the server rejects it with a clear message. When you lose access, or an active resource is deleted, Grids hides the affected workspace immediately.

## Open a missing resource {icon="lifebuoy"}

Check that the resource is not in the trash and not disabled. Then find the boundary:

- Raw tables, views, forms, documents, and workflows require access to the Base that owns them.
- A published Grids App requires its own **Open** access.
- Being a Cloud administrator does not bypass Grids access on normal app pages.

For a Grids App, confirm that the requested page or block is part of the published snapshot. Also confirm that its `availableWhen` query returns a row. An unavailable resource returns a not-found error on purpose and runs no data source or action.

## Find missing, duplicated, or unordered records {icon="lifebuoy"}

Read the active search, filters, source view, deleted-record mode, and `limit`. Search applies within the current query, so it cannot find records that a filter already removed.

Use exact filters for calculated values, lookups, rollups, files, dates, and empty values. Add a meaningful sort before you rely on page order or `offset`. Each page is a live read, so changes between page requests can move matching records.

Record results refresh in place, also after a reconnect. If the table has a search field, its magnifier turns into a small spinner while records load or refresh. Grids recalculates filters, sorting, and totals, so records can leave the result. Open edit dialogs keep their drafts and flag competing changes. If an automatic refresh fails, choose **Updates available** next to the record count to try again. If live updates stop, reload the page.

## Save a rejected record edit {icon="table"}

Another person or tab can have saved a newer version. The edit dialog keeps your input.

:::steps
1. Choose **Compare current record**.
2. Review the latest values.
3. Keep your edits on that version explicitly.
4. Save again.
:::

Fields that you did not change take their current values. This prevents an older form from overwriting newer work silently.

If the message asks for change context, answer the questions configured in **Table settings → Data integrity**. Protected updates, trash actions, and restores cannot continue without the required answers.

The message can say that this source cannot change the table. Then a person with **Manage** access to the Base must allow the matching source in **Table settings → Data integrity → Record changes**. The Base interface, the API, the CLI, forms, workflows, and Grids App actions all follow this setting. A retry through another client does not bypass it.

### Write safely from an integration

For API or CLI integrations, patch only the fields that the integration owns. Send the current positive record version as `If-Match` or `--if-version` when a stale projection must not overwrite a newer edit. A stale version returns a conflict. Grids rejects a malformed version as input. If the normalized scalar and relation values are already current, Grids returns the record. It creates no new version, durable history revision, audit entry, or live event.

For a connector that projects the same external object again and again, use the external record upsert. Do not search a visible field and then create a record. The provider, provider account, resource kind, and external ID form one case-sensitive binding. The record keeps its separate public Grids ID.

- Reuse the same idempotency key only for an uncertain retry of the same request.
- A later projection uses a new key and the current record version.
- Reusing a key with different input, leaving out the version for an existing binding, or sending a stale version returns a conflict. No duplicate is created.
- The result is an immutable receipt with the public record ID and the version that this request produced. Read the record separately for the current values.
- Retry receipts expire after 30 days. The identity binding does not expire.

For up to 100 independent projections, `cld grids records upsert-external-batch` applies the same contract one item after the other. Every item has its own idempotency key and ordered outcome. One conflict does not roll back successful siblings. If the request is interrupted, retry the complete unchanged batch: committed items replay, and the remaining items continue. `records import` is different. It creates one all-or-nothing batch and is not the retry-safe path for external identities.

### Follow changes from an integration

For a resumable integration, keep the latest opaque cursor from `cld grids records changes`. The feed contains public Base, table, and record IDs and the committed event type and record version. It contains no snapshot of field values. Read each current record again before you project it.

**View** access to the Base is checked on every page. `--table` only narrows the feed of that Base. A change appears once every earlier write has ended. A long import therefore delays the later changes. They are not skipped. If the feed stays empty while records change, ask the operator about a transaction left open on the database server.

Cursors cover the last 30 days. If a cursor expires, scan all records again and start from the new feed position. Bound automated catch-up with `--all --max-events N`.

## Correct a wrong view or Grids App result {icon="layout"}

Open the source query and verify it before you change the presentation:

- Use filters before the grouping for source records and `having` for aggregate rows.
- Confirm that a chart source is grouped and contains the expected aggregate values.
- Check whether a widget uses a saved view or its own local GQL.
- Aggregate-only and grouped results are summaries, not editable records.

An empty result is different from a failed result. Query diagnostics explain syntax errors, unknown names, incompatible operations, and access failures.

## Submit a form that fails {icon="forms"}

Confirm that the form is active. Then check the path:

- A person who works in the Base needs **Edit** access to the Base.
- A submission through a Grids App must use a form block that the app includes and that is available.
- A public form must still be enabled for token access and opened through its current public URL.

Check required fields, the rules for creating related records inline, and hidden values. People who submit the form cannot override its hidden values.

If an old public URL stopped working after someone disabled public access, share the newly generated URL. Grids does not restore the old link, on purpose.

## Fix a document preview or download {icon="lifebuoy"}

Choose a preview record. Then inspect the template in this order:

:::steps
1. **Source** shows the GQL after Grids inserted the Liquid values of the current record.
2. **Data** shows the exact paths that Liquid can use.
3. **Preview** shows the rendered PDF.
:::

Correct the source when rows are empty. Copy paths from **Data** instead of guessing them. For barcodes, check both the symbol ID and a compatible value that is not empty. For output with several pages, test with enough rows. Keep repeated letterhead or page numbers in the header and footer parts.

New generated documents download their exact stored PDF bytes. Later changes to the record, template, or renderer cannot rewrite an existing artifact.

If generation returns an uncertain result, keep the dialog open and choose **Retry generation**. It retries the same request and does not create a new document. Closing the dialog ends that retry context. Check **All documents** before you start a new attempt.

## Investigate an unexpected workflow result {icon="route"}

Open the run detail before you retry. Check its revision, mode, channel, inputs, step outcomes, saved outputs, and error. The run executed the revision that it pinned at its start. This is not necessarily the YAML on screen now. Open the linked revision of the run to read what actually ran.

If a Grids App action cannot retrieve its result, choose **Check status** while the page stays open. This follows the existing operation and does not start another workflow. A status error does not prove that the workflow failed.

A `dryRun` records predicted effects but performs no writes and no external requests. An `execute` retry must use a deliberate idempotency key. External HTTP receivers must also handle duplicate requests without repeating their effects.

For scanner, bulk, and Grids App actions, inspect the diagnostics of the saved run option after you change workflow inputs.

## Find a workflow run that never appeared {icon="route"}

An automatic run exists only if the published revision of the workflow was listening for that occurrence. If nothing was listening, there is no failed run to open. There is no run at all. Check these conditions in order:

:::steps
1. **Enabled:** A disabled workflow refuses every execute run, including schedules and record events.
2. **Published:** The trigger must be in the published YAML. Editing the source without saving changes nothing that fires.
3. **Trigger match:** Compare the record event, its optional table restriction, and its filter with your change. Compare the cron expression and timezone with the expected time.
4. **Activation window:** Grids picks up a record change only if it happened after the trigger became active. Enabling the workflow, or publishing a changed record-event trigger, restarts that window. Grids does not replay earlier changes.
5. **Missed schedule:** A slot that passes while Grids is unavailable is skipped and not caught up. The next slot runs normally.
6. **Owner access:** Schedules and record events run as the workflow owner. Grids refuses the invocation before it creates a run if the owner lost **Edit** access to the Base. It also refuses it if the owner cannot read a record that the trigger binds to an input.
:::

If all six conditions hold and there is still no run, ask a Cloud administrator to check **Observability → Workflows**. It lists recorded occurrences that never became runs.

## Fix a workflow query with an incompatible schema {icon="alert-triangle"}

If a query reports an incompatible schema or binding, review its source and the referenced fields. Then publish the workflow again. Start a new run with the new revision. Existing runs keep their original plan. Reordering columns alone does not invalidate a query.

:::danger Do not edit hashes
Do not edit stored hashes to bypass the check.
:::

This is a failed query, not the `needs_attention` state below.

## Resolve a run that needs attention {icon="alert-triangle"}

`needs_attention` requires a person to inspect the reason before the run continues.

If the reason is `WORKFLOW_MODULE_MISMATCH`, an update changed the available workflow actions. Review the workflow and publish it again. Existing runs keep their original plan, and publishing again does not upgrade them. Check completed steps and external effects before you start a new run.

### Decide about an interrupted HTTP request

For an interrupted `httpRequest`, the request left Grids without a complete response. Grids therefore cannot tell whether the receiver acted on it. Grids neither retries the step nor calls it failed, on purpose. A retry can charge a receiver twice. Calling it failed would claim that the request did not arrive.

:::steps
1. Check the receiving system for the request.
2. If the request did not arrive, start a new run.
3. If it arrived, do nothing more. The run stays as the record of what happened.
:::

The run detail cannot answer this question for you. That is why the run stopped for a person.

Record changes, generated documents, and sent email do not have this uncertain HTTP outcome. The interruption either undoes those steps, or they are safe to resume once.

### Replay stopped record events

Cloud administrators can inspect retained delivery failures with `cld grids record-events failures <base-id> --json`. Stopped workflow events stay in the list until 30 days after their change. Grids keeps the record state that they replay at least that long. Continue with the returned `nextOffset` through `--offset`.

After you fix the cause, `cld grids record-events replay <base-id> <failure-id> --yes` replays one stopped event with its original retained data. Use the exact failure UUID from the list. Acceptance does not mean that processing completed. **Manage** access to the Base alone does not allow this operator action.

## Read an indeterminate dry run {icon="lifebuoy"}

A dry run ends indeterminate when Grids could not decide the plan, not when something went wrong. The run reads `failed` with a dry-run error code. The step that Grids could not plan carries the reason.

Two causes explain most cases:

- A step names a template, table, field, or record that is deleted, ambiguous, or outside the access of the run identity. The step reports that reference as the reason.
- Grids could not evaluate a condition while planning, so an `if` or `switch` is undecidable. The dry run then plans **every** branch and marks the control step. Read those branches as alternatives, not as work that will all happen.

Fix the named reference. For an undecidable branch, accept that a plan cannot settle it. Verify the behavior with a small execute run instead.

## Repair a Combined table {icon="lifebuoy"}

A Combined table fails closed when a published source, mapping, or source access is no longer valid. It does not return a smaller partial dataset.

:::steps
1. Open **Combined data**.
2. Inspect the diagnostics of the affected source and fields.
3. Repair the draft.
4. Validate it.
5. Publish a complete new revision.
:::

A revoked source must be authorized again before you publish again.

## Work with files, exports, and large results {icon="paperclip"}

Files follow the access of the Base that owns them, or the exact published capability of a Grids App. Store facts that people search or filter in normal fields, not only in a filename.

Exports and result pages load in pages. A query without `limit` can continue through all matching rows. A `limit` caps the complete result on purpose. Use bounded exports and the CLI options for `--max-rows` when an automated process must enforce its own maximum.

:::note Keep the failing context
Before you edit a query, template, or workflow, keep the diagnostic and the input that produced it. A precise error with the active source helps more than a screenshot of an empty result.
:::
