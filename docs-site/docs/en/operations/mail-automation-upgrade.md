---
title: Replace Mail rules with mailbox Code
navTitle: Mail automation upgrade
section: Operations
order: 1195
description: Export old Mail rules, drain their effects, and rebuild reviewed mailbox Code before activation.
tags: [operations, upgrades, mail, code]
updated: 2026-11-07
---

# Replace Mail rules with mailbox Code

Mail automations now use [mailbox Code](/en/docs/platform/mail-code-automations).
Guided incoming rules, YAML workflows, their timers and backfills, and rule
Undo/Redo are retired. Automatic replies are removed without replacement,
including out-of-office replies, office-hours replies, and reference
acknowledgements. Ordinary Mail sending and reference numbers remain available.

## Export before upgrading

Use the export-capable old release to export each mailbox’s definitions with
`cld mail automation export`. Keep the exact exported source and immutable
versions. Back up run history, logs, commands and outbox evidence separately;
definition exports do not contain that history.

Stop old authoring, activation, incoming admission, timers and backfills. Keep
replacement Code inactive while old effects drain. Reconcile accepted or
ambiguous sends using provider evidence. Never bypass an old command’s fence
or replay an accepted send to make the upgrade proceed.

The cut image refuses startup while legacy commands or sends remain unresolved.
Finish reconciliation on the export-capable release; an accepted send must never
be retried to bypass this check. Once retired, the schema marker prevents an old
Mail image from restarting. Timer registrations are deleted and recorded
backfills cancelled before ordinary workers start. The migration waits for shared
workflow transactions; if startup reports a lock timeout, let those transactions
finish and restart Mail.

Treat this as a coordinated cut, with old Mail workers stopped before the new
image starts. Do not mix old and new workers during the transition. Keep the
pre-upgrade backup and compatible image for recovery.

## Rebuild and review

Ask Gustav to rebuild an exported rule as mailbox Code. Review the source,
capability grants, effects and ordering. No old definition automatically becomes
active Code. Several old rules may become several handlers in one mailbox
Code; their declared order determines which handler runs first for a message.

Preview a chosen real message before activation. The preview reports capability
calls without performing their effects. Record the final receipt covered by old
rules and the first receipt covered by Code. Use a deliberate, bounded catch-up
selection for any gap, and inspect its progress and runs before continuing.

## Read earlier history

Earlier rule logs remain read-only under **Retired rule history** in the mailbox
menu. Choose a UTC day and open an entry to inspect its recorded effects and
decision chain. Earlier runs have a separate, paged read-only list; opening a run
shows its source, receipt and step evidence. Whole-mailbox read access is
required for run evidence, which may cover several conversations. Undo and Redo
are unavailable. Existing run history and source names remain evidence; they grant no execution authority. The existing 30-day
rule-log retention and shared engine payload expiry still apply. Back up evidence
before upgrading if the installation requires a longer archive.

Mail commands, drafts, contacts, tags, summaries, reference numbers and provider
sync continue through their ordinary services. Grids workflows and the public
`@k2b/cloud/workflows` engine remain available.

Before a rollback, disable replacement Code. Restoring old data must not start
old rules beside active Code.
