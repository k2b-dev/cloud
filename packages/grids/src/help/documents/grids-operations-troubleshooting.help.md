---
id: grids-operations-troubleshooting
title: Operations & troubleshooting
icon: ti ti-bolt
description: Diagnose common problems without guessing or losing work.
order: 150
---
When Grids behaves differently than expected, identify the surface first: table, view, form, Grids App, document, workflow, or Combined table. Then check its current query, state, and access before changing the underlying data.

Grids rejects ambiguous queries, stale writes, invalid automation, and unauthorized access rather than silently choosing a different result.

## A resource is missing or will not open {icon="lifebuoy"}

Check that it is not in trash or disabled, then identify the boundary. Raw tables, Views, Forms, documents, and Workflows require the owning Base permission. A published Grids App requires its own Read grant. Cloud administrator status does not bypass Grids access on normal app pages.

For a Grids App, confirm that the requested page or block is part of the published snapshot and that its `availableWhen` query returns a row. An unavailable resource deliberately returns **Not Found** and executes no data source or action.

## Records are missing, duplicated, or out of order {icon="lifebuoy"}

Read the active search, filters, source view, deleted-record mode, and `limit`. Search respects the current query, so it cannot find records already filtered out.

Use exact filters for calculated values, lookups, rollups, files, dates, and empty values. Add a meaningful sort before relying on page order or `offset`. Pages are live reads; changes made between page requests can move matching records.

If a change is not visible, reload once. Live updates keep the current query rules: a changed record can legitimately disappear when it no longer matches.

## A record edit was rejected {icon="table"}

Another user or tab may have saved a newer version. Reload the record, compare the new values, and apply your change again. This prevents an older form from overwriting newer work.

If the message asks for change context, answer the questions configured under **Table settings → Data integrity**. Protected updates, trash actions, and restores cannot proceed without the required answers.

If the message says this source is not allowed to change the table, a Base admin must open **Table settings → Data integrity → Record changes** and allow the matching source. The Base UI, API, CLI, Forms, Workflows, and Grids App actions all follow this setting; retrying through another client does not bypass it.

For API or CLI integrations, patch only the fields the integration owns. Send the current positive Record version as `If-Match` or `--if-version` when a stale projection must not overwrite a newer edit. A stale version returns a conflict; a malformed version is rejected as input. If the normalized scalar and Relation values are already current, Grids returns the Record without creating a new version, Durable History revision, audit entry, or live event.

For a connector that repeatedly projects the same external object, use the external Record upsert instead of searching a visible field and then creating. Its provider, provider account, resource kind, and external ID form one case-sensitive binding; the Record keeps its separate public Grids ID. Reuse the same idempotency key only for an uncertain retry of the same request. A later projection uses a new key and the current Record version. Reusing a key with different input, omitting the version for an existing binding, or sending a stale version returns a conflict without creating a duplicate. The result is an immutable receipt with the public Record ID and the version produced by that request; read the Record separately for current values. Retry receipts expire after 30 days, but the identity binding does not.

For a resumable integration, keep the latest opaque cursor from `cld grids records changes`. The feed contains public Base, Table, and Record IDs plus the committed event type and Record version, not a field-value snapshot. Reread each current Record before projecting it. Base Read access is checked on every page; `--table` only narrows that Base feed. Cursors cover the last 30 days. If a cursor expires, make a fresh full Record scan and start from the new feed position. Bound automated catch-up with `--all --max-events N`.

## A view or Grids App result is wrong {icon="layout"}

Open the source query and verify it before changing presentation:

- use pre-group filters for source records and `having` for aggregate rows;
- confirm a chart source is grouped and contains the expected aggregate values;
- check whether a widget uses a saved view or its own local GQL;
- remember that aggregate-only and grouped results are summaries, not editable records.

An empty result is different from a failed result. Query diagnostics explain syntax, unknown names, incompatible operations, and permission failures.

## A form will not submit {icon="forms"}

Confirm that the Form is active. A raw Base user needs Base Write. A Grids App submission must use an included available Form block. A public Form must still be enabled for token access and opened through its current public URL.

Check required fields, relation inline-create rules, and hidden values. People submitting the form cannot override its hidden values.

If an old public URL stopped working after public access was disabled, share the newly generated URL. The old link is intentionally not restored.

## A document preview or download fails {icon="lifebuoy"}

Choose a preview record, then inspect the template in this order:

:::steps
1. **Source** shows the GQL after current-record Liquid values were inserted.
2. **Data** shows the exact paths available to Liquid.
3. **Preview** shows the rendered PDF.
:::

Correct the source when rows are empty, and copy paths from Data instead of guessing. For barcodes, verify both the symbol id and a non-empty compatible value. For multipage output, test with enough rows and keep repeated letterhead or page-number content in header and footer parts.

New generated documents download their exact stored PDF bytes. Later record, template, or renderer changes cannot rewrite an existing artifact.

## A workflow did not do what you expected {icon="route"}

Open the run detail rather than immediately retrying. Check its revision, mode, channel, inputs, step outcomes, saved outputs, and error. The run executed the revision it pinned when it started, which is not necessarily the YAML on screen now — open the run's linked revision to read what actually ran.

A `dryRun` records predicted effects but does not perform writes or external requests. An `execute` retry should use a deliberate idempotency key; external HTTP receivers should also handle duplicate requests safely.

For scanner, bulk, and Grids App actions, inspect the saved run option's diagnostics after changing workflow inputs.

## A workflow run never appeared {icon="route"}

An automatic run only exists if the workflow's published revision was listening for that occurrence. When nothing was listening, there is no failed run to open — there is no run at all. Work through the conditions in order:

:::steps
1. **Enabled:** A disabled workflow refuses every execute run, schedules and record events included.
2. **Published:** The trigger has to be in the published YAML. Editing the source in the editor without saving changes nothing that fires.
3. **Trigger match:** Compare the record event, its optional table restriction, and its filter against the change you made; compare the cron expression and timezone against the time you expected.
4. **Activation window:** A record change is only picked up if it happened after the trigger became active. Enabling the workflow or publishing a changed record-event trigger restarts that window — changes from before it are not replayed.
5. **Missed schedule:** A slot that passes while Grids is unavailable is skipped, not caught up later. The next slot runs normally.
6. **Owner permission:** Schedules and record events run as the workflow owner. If the owner no longer has Base Write, or cannot read a record the trigger binds to an input, the invocation is refused before any run is created.
:::

If all six hold and there is still nothing, ask a Cloud administrator to check **Observability → Workflows**, which lists recorded occurrences that never became runs.

## A workflow run needs attention {icon="alert-triangle"}

`needs_attention` is not a failure. It means a step performed something outside Grids and nothing can establish whether it landed — in practice, an `httpRequest` that left the process without a complete response coming back. Grids deliberately neither retries it nor calls it failed: retrying is how a receiver is charged twice, and calling it failed would claim it did not arrive.

Check the receiving system for the request, then decide. If it did not arrive, start a new run. If it did, no further action is needed and the run stays as the record of what happened. Nothing in the run detail can answer this for you, which is exactly why it stopped for a person.

Record changes, generated documents, and sent email never end this way — those steps are either undone by the interruption or safe to resume once.

## A dry run reported indeterminate {icon="lifebuoy"}

A dry run ends indeterminate when the plan could not be decided, not when something went wrong. The run reads `failed` with a dry-run error code, and the step that could not be planned carries the reason.

Two causes account for most of it. A step naming a template, table, field, or record that is deleted, ambiguous, or beyond the run identity's access reports that reference as the reason. Separately, a condition Grids could not evaluate while planning makes an `if` or `switch` undecidable; the dry run then plans **every** branch and marks the control step. Read those branches as alternatives, not as work that will all happen.

Fix the named reference. For an undecidable branch, accept that a plan cannot settle it and verify the behaviour with a small execute run instead.

## A Combined table needs attention {icon="lifebuoy"}

A Combined table fails closed when a published source, mapping, or source permission is no longer valid. It does not return a smaller partial dataset.

Open **Combined data**, inspect the affected source and field diagnostics, repair the draft, validate it, and publish a complete new revision. A revoked source must be authorized again before republishing.

## Files, exports, and large results {icon="paperclip"}

Files follow the owning Base or the exact published Grids App capability. Store facts people need to search or filter in normal fields rather than only in a filename.

Exports and result pages load in pages. A query without `limit` can continue through all matching rows; a `limit` intentionally caps the complete result. Use bounded exports and CLI `--max-rows` options when an automated process must enforce its own maximum.

:::note Preserve the failing context
Before editing a query, template, or workflow, keep the diagnostic and the input that produced it. A precise error plus the active source is more useful than a screenshot of an empty result.
:::
