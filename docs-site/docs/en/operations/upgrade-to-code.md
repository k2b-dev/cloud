---
title: Upgrade to Code (Gustav release)
navTitle: Upgrade to Code
section: Operations
order: 1194
description: Export, freeze, upgrade and rebuild when Studio, Mail rules, automatic replies and routines give way to Code.
tags: [operations, upgrades, code, migrations]
updated: 2026-11-08
---

# Upgrade to Code (Gustav release)

In this release, Code replaces four older automation products. The upgrade is a
**one-way, coordinated cut**: old and new paths never run at the same time,
and nothing old becomes active Code by itself. Plan a maintenance window, take
the exports below on the old release, and let people rebuild what they need
with Gustav afterwards.

| Before | After the upgrade | Replacement |
| --- | --- | --- |
| Studio apps, their revisions, publications, sharing, app storage, files and RSQL databases | Removed with their data | None. A new lasting program is new Code; nothing is transferred. |
| Mail rules: guided incoming rules, YAML workflows, their timers, backfills and Undo/Redo | Stopped; rule logs and runs stay readable | [Mailbox Code](/en/docs/platform/mail-code-automations), rebuilt by Gustav and switched on after review |
| Scheduled Assistant chat routines | Stopped; definitions and run logs stay as a read-only archive | Personal Code with `app.schedule` and `core.ai.chat.run` or `core.ai.chat.deliver`, rebuilt by Gustav |
| Automatic replies: out-of-office, office-hours and reference acknowledgements | Removed | None |

These stay as they are:

- **Grids** workflows and apps, and the public workflow engine
  `@k2b/cloud/workflows` with all its entry points. Third-party applications
  that use the engine keep working.
- **Health webhooks** under **Observability → Alerts & webhooks**.
- Ordinary Mail: sending, drafts, contacts, tags, summaries, reference numbers
  and provider sync.
- Chat code runs (`code_run`, `code_inspect`, `code_stop`, `code_export`,
  `code_secret`), chat approvals and remembered decisions, chat and Project
  files, signed file links and native views.

The exact list of removed routes, commands, capabilities and settings is in
[Removed in the Gustav release](/en/docs/reference/code-release-removals).

> **Status on `feat/code`:** routines, Mail rules and automatic replies are
> retired, Gustav rebuilds exported definitions, and Studio is retired as
> described in [Studio retirement](/en/docs/operations/studio-retirement).
> This page describes the release as a whole.

## 1. Freeze

Announce the window. Stop all authoring, activation and configuration changes
for Studio apps, Mail rules, automatic replies and routines, also through the
API, the CLI and Gustav. Keep the old release running: it must drain its own
work. Keep any replacement Code switched off.

Make an inventory: owners, definitions, versions, running work, pending Mail
sends and other provider effects. You need it to check the exports and the
drain.

## 2. Export on the old release

Update the Mail and Assistant CLI plugins of the **old** release, then export
with an explicitly selected profile. A Cloud administrator exports the whole
installation with a signed-in administrator profile, not a workload key:

```sh
cld mail automation export --profile <admin-profile> --all --json > mail.partial.json
cld assistant tasks export --profile <admin-profile> --all --json > routines.partial.json
```

A mailbox administrator can export one mailbox with `--mailbox <mailbox>`;
a person can export their own routines without `--all`. Keep each command's
exit status: a failed request leaves an incomplete file. Validate both files
before you archive them:

```sh
jq -e '.format == "cloud.mail-automation" and .version == 1 and .nextCursor == null' mail.partial.json
jq -e '.format == "cloud.chat-tasks" and .version == 1 and .nextCursor == null' routines.partial.json
```

Exports hold definitions only, and `authority: "none"`: they grant nothing.
They contain prompts, rule source, resource references and personal
schedules, so store them with the upgrade's restricted backup material. See
[Export automation definitions](/en/docs/operations/automation-definition-export)
for the format and the paged API routes.

Then back up what the exports leave out:

- A **database backup** of the whole installation. It keeps Mail run
  history, rule logs, commands and outbox evidence, and routine occurrences
  and messages.
- **Studio has no migration export**: nothing moves into Code. Back up
  anything your retention contract needs before the upgrade, including the
  **external RSQL databases**: a Postgres backup holds only the namespace
  mappings, not their contents. A person with **Manage** access can download
  one Studio app's database as SQLite with
  `cld assistant code database-export <app> --out <file>` on the old release.
  This is the last chance; the upgrade deletes Studio data.

If people kept editing during the export, export again. Pages are live reads,
not one transaction.

## 3. Stop old work and drain it

- Stop old admission and timers: Mail rule activations, incoming-mail
  admission, rule schedules and backfills; routine admission and manual runs;
  Studio machine runs and checks. Keep Grids and the shared AI workers running.
- Let admitted work finish, or cancel it visibly.
- **Reconcile every accepted or unknown Mail send on the old release** with
  the provider's evidence. Never retry or replay a send to get past the
  upgrade check.
- Settle pending chat HTTP requests (approve, deny or let them expire) and
  pending Studio approvals.
- Stop **every** old Core, Assistant and Mail replica and worker. Do not run
  old and new versions side by side, also not as a rolling upgrade.

A stopped process is not proof that its scheduled records are gone; the new
release removes them, but only once the old one is down.

## 4. Upgrade

Upgrade Core, the gateway, Assistant, Mail, the Code runner, all other
applications and the CLI plugins together. Start Core first, then Mail, and
start Assistant only once Mail is ready: Mail's drain check then runs before
Studio's destructive cleanup. Keep the existing
`APP_SECRET`, and the stored Studio RSQL URL, API token and network allowlist,
valid and reachable until startup has finished.

The migrations, in short:

- **Routines:** revoke every routine mandate, abort unfinished routine turns,
  remove their broker timers and refuse any new or replayed admission.
- **Mail:** delete rule timer registrations, cancel recorded backfills and set
  a retirement marker before ordinary workers start. The marker stops an old
  Mail image from starting again.
- **Studio:** cancel pending Studio approvals, copy chat calls, claims and
  approvals into the chat tables with their original IDs, delete Studio
  credentials, access links and resource references, delete the mapped RSQL
  namespaces in bounded batches, then remove Studio app data. Do not restart
  an old Assistant after this cleanup has begun.

### What can stop the upgrade

Startup stops, with a message, instead of continuing unsafely:

| Stop | Cause | What to do |
| --- | --- | --- |
| Mail does not start | Old Mail commands or sends are still unresolved | If Assistant has not started yet, return to the old release, reconcile them there (step 3) and upgrade again. If Studio cleanup has begun, never start the old Assistant again: restore the pre-upgrade backups, including RSQL, before returning to the old release |
| Mail reports a lock timeout | Shared workflow transactions, for example Grids writes, are still settling | Let them finish and restart Mail; this is safe to retry |
| Assistant: "Unreadable pending HTTP scope" | A pending chat HTTP request cannot be decrypted or read, for example after `APP_SECRET` changed | Restore the previous `APP_SECRET`, or settle the pending request on the old release, then start again |
| Assistant: RSQL cleanup fails | The RSQL service is unreachable or answers with an error other than "namespace missing" | Make RSQL reachable with the stored URL, token and allowlist, then start again. Local changes roll back for the retry; remote deletions that already happened stay deleted |

A missing RSQL namespace counts as already clean. Rolling back after a
successful upgrade needs the pre-upgrade backups, including the external RSQL
backups.

## 5. Read-only history

After the upgrade, history stays readable but nothing old runs again:

- **Mail:** the mailbox menu shows **Retired rule history**: rule logs by UTC
  day with their effects and decision chains, and a paged list of earlier
  runs with source, receipt and step evidence. Undo and Redo are gone. The
  existing 30-day log retention still applies.
- **Routines:** delivered messages stay in their chats with a static
  background-run label. Definitions, occurrences and messages stay as an
  operator archive in the database, and `cld assistant tasks export` still
  reads the frozen definitions. Live chat or account deletion no longer
  deletes these rows: include them in backup, access and retention procedures.
- **Studio:** execution evidence stays as a read-only operator archive in the
  original `assistant` tables. Old transcripts stay readable; their Studio
  references report the resource as unavailable and never point to Code.

## 6. Rebuild with Gustav

People give Gustav a `cloud.mail-automation` or `cloud.chat-tasks` export file
and pick one rule or routine. Gustav explains the old behaviour and drafts a
replacement with fictional tests; see
[Rebuild an exported automation](/en/docs/platform/gustav-code-tools#rebuild-an-exported-automation):

- A **Mail rule** becomes mailbox Code with an `app.on("mail.message.received")`
  handler. Several rules of one mailbox become helper functions that one
  handler calls in a fixed order.
- A **routine** becomes personal Code with `app.schedule` and an explicit
  `timeZone`, then `core.ai.chat.run` when the work needs Gustav and tools, or
  `core.ai.generate` and `core.ai.chat.deliver` for a prepared result. A
  routine that relied on chat history, files or an open-ended tool loop needs
  those inputs resolved first; Gustav leaves such gaps visible in the draft.
- **Automatic replies** and **Studio apps** have nothing to rebuild.

Gustav checks, tests and submits a version; it never switches Code on. No
export, grant or enabled flag carries authority into Code. Old routine HTTP
grants and Studio database grants do not transfer; Code has no replacement
database.

## 7. Review and switch on

For each new version:

1. The person who owns the resource reviews the source, the permissions and
   the effects on the version card, the Code page or `cld code diff`.
2. A Cloud administrator approves versions that need it under the
   [Code policy](/en/docs/platform/code-policy): by default AI use, internet
   requests and silent Actions that others see. Actions that ask a person
   never run unattended in this release.
3. For mailbox Code, a manager of each target shares it with the Code's
   service account by its handle, **View** or **Edit**.
4. Before switching on, run the version's tests: fictional fixtures with
   `cld code test` or Gustav's `code_test`. Nothing real is called.
5. The owner chooses **Switch on**.
6. For mailbox Code, use **Preview without effects** on the mailbox's Code
   page to replay one real message against the active version; it performs no
   effects. Record the last receipt the old rules handled and the first one
   Code handles. Close any gap with a deliberate, bounded **Catch up** of up
   to 100 messages; catch-up refuses versions that use AI.

Before any rollback, switch replacement Code off first. Restoring old software
or data must never run old rules or routines beside active Code.

## Verify after the upgrade

- Every application is ready and the
  [health checks](/en/docs/operations/observability) are green; configured
  health webhooks still reach their destination.
- Startup logs show the routine, Mail and Studio migrations completed, with
  no retired timer or admission recreated after a restart.
- `cld assistant tasks export --all --json` and
  `cld mail automation export --all --json` still return the frozen
  definitions; their `nextCursor` reaches `null`.
- A mailbox shows **Retired rule history**; an earlier routine message shows
  its static label; Studio pages and commands are gone.
- Ordinary Mail works: send a test message from a test mailbox, add a tag,
  write a summary.
- A Grids workflow still runs.
- A first rebuilt Code version passes its tests, switches on, passes
  **Preview without effects** for a real message, and handles one new test
  message or one manual schedule start as expected. Its run list shows the calls in order.

## Related pages

- [Export automation definitions](/en/docs/operations/automation-definition-export)
- [Routines became Code](/en/docs/operations/routines-to-code)
- [Replace Mail rules with mailbox Code](/en/docs/operations/mail-automation-upgrade)
- [Mail automations with Code](/en/docs/platform/mail-code-automations)
- [Activate a Code version](/en/docs/platform/code-activation)
- [Removed in the Gustav release](/en/docs/reference/code-release-removals)
