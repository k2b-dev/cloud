---
title: Upgrade to Code (Gustav release)
navTitle: Upgrade to Code
section: Operations
order: 1194
description: Export, freeze, upgrade and rebuild when Studio, Mail rules, automatic replies and routines give way to Code.
tags: [operations, upgrades, code, migrations]
updated: 2026-11-13
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

**An upgrade with populated Studio apps has not been rehearsed.** Studio data
is **deleted, not migrated**. On the **old version**, a person
with **Manage** access exports each Studio app's database with
`cld assistant code database-export <app> --out <file>` using an explicitly
selected profile. Preserve other Studio files your retention contract needs.
These exports do not replace the matching database and RSQL recovery point
required **after drain and reconciliation** in step 3.

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

### Create the recovery point

After the drain and reconciliation above, create **one binding, consistent
recovery point for the whole installation database and external RSQL data**.
This is the recovery point every rollback instruction below refers to.

1. With old Core, Assistant and Mail stopped, let remaining shared work finish,
   then stop all remaining application replicas, workers, timers, provider sync
   and other writers to the installation database and RSQL namespaces. Block
   user and API writes too.
   Keep writes stopped until both backups are complete; two independent live
   backups are not one consistent recovery point.
2. Back up the whole installation database, including commands, outbox evidence,
   Mail history and routine occurrences, and the external RSQL data, including
   every Studio namespace. Postgres holds namespace mappings, not RSQL contents.
   Record the two backup identifiers and their common recovery-point time
   together. Retain the matching configuration and `APP_SECRET` securely.
3. Verify that both backups can be read and restored using the installation's
   backup procedure. Keep this recovery set for the entire rollback window.
   Do not substitute an earlier pre-drain backup or definition export.

**A later rollback loses changes made after this recovery point**, including
new messages and edits. Before old workers start again, reconcile all external
effects since the recovery point, including sent mail, against provider evidence.
Restoring the database does not undo those effects or make replay safe.

## 4. Upgrade

Upgrade Core, the gateway, Assistant, Mail, the Code runner, all other
applications and the CLI plugins together. Start Core first, then Mail, and
start Assistant only once Mail is ready: Mail's drain check then runs before
Studio's destructive cleanup. Keep the existing
`APP_SECRET`, and the stored Studio RSQL URL, API token and network allowlist,
valid and reachable until startup has finished.

Production Compose does not enforce this startup order. Use this release's
Compose file: Core and Mail have `/_cloud/ready` healthchecks, so `--wait`
waits for their startup work to finish. Custom deployments need the same
application readiness checks; a running container alone is insufficient.

Before starting Runner, enroll its app key (`secrets/runner.key`), install the
matching AppArmor profile on each host and deploy the matching seccomp policy.
Follow [Runner deployment](/en/docs/operations/code-runner) for host,
user-namespace and container prerequisites.

After preparing the new images and completing the recovery point in step 3,
start in stages.
Run each command only after the previous command succeeds. Stop if a readiness
check fails; do not start Assistant before Mail is ready.

```sh
docker compose -f compose.prod.yml up -d --wait app-core
docker compose -f compose.prod.yml up -d --wait app-mail
docker compose -f compose.prod.yml up -d --wait
```

The migrations:

- **Routines:** revoke every routine mandate, abort unfinished routine turns,
  remove their broker timers and refuse any new or replayed admission.
- **Mail replies:** an installation older than 0.75 first runs the one-time
  [reply draft consolidation](/en/docs/operations/mail-reply-draft-consolidation)
  (F6). It runs before the rule retirement, so a refused consolidation changes
  nothing and the previous Mail image still starts.
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
| Mail does not start | Old Mail commands or sends are still unresolved | Do not start old workers on the migrated database. Follow the coordinated restore below to the step 3 recovery point, including its matching RSQL data. Use the controlled reconciliation procedure below for unresolved sends in that snapshot, then repeat drain and take a new consistent recovery point before trying the upgrade again |
| Mail reports "F6 preflight" | A conversation has two committed sends or an in-flight delivery among duplicate reply drafts | No marker that blocks the previous release was written. Start the previous Mail image, let the sends finish or cancel them, stop it, and start the upgrade again. See [Mail reply draft consolidation](/en/docs/operations/mail-reply-draft-consolidation) |
| Mail reports a lock timeout | A database session still holds a conflicting lock, possibly a leftover workflow writer | Identify the blocker and stop leftover writers before retrying. Verify that no writes overlapped the recovery backups. If they did, stop: that recovery point is invalid. Recover a verified pre-cut state through the backup procedure and repeat step 3; never take a replacement pre-cut backup from the partly migrated database |
| Assistant: "Unreadable pending HTTP scope" | A pending chat HTTP request cannot be decrypted or read, for example after `APP_SECRET` changed | Restore the previous `APP_SECRET` and retry on the new release. If returning to the old release is necessary, use a coordinated restore to the step 3 recovery point, including RSQL if an earlier cleanup attempt deleted namespaces; never just start old images on the migrated database |
| Assistant: RSQL cleanup fails | The RSQL service is unreachable or answers with an error other than "namespace missing" | Make RSQL reachable with the stored URL, token and allowlist, then start again. Local changes roll back for the retry; remote deletions that already happened stay deleted |

A missing RSQL namespace counts as already clean.

### Restore the recovery point

For any return to the old release, switch replacement Code off and stop all
new-version replicas, workers and other writers first. Restore the **whole
installation database and matching external RSQL backup from the step 3 recovery
point**, with its matching configuration and `APP_SECRET`. RSQL restoration is
essential if any cleanup attempt deleted namespaces. Do not combine backups
from different points or start old software on a partly migrated installation.

Changes after the recovery point are lost. Keep old workers and admission
stopped while reconciling external effects since that point, especially sent
mail, against provider evidence. Resolve replay risks before restarting the
old workers. A later upgrade attempt needs a fresh drain, reconciliation and
consistent recovery point.

If Mail's drain check found unresolved sends already in the recovery snapshot,
restoring it does not resolve them. Inspect those commands and provider evidence
with old workers stopped. **Old Mail starts its outbox and workflow workers with
its server; there is no worker-free startup promised here.** Use a controlled,
operator-assisted recovery procedure to record verified outcomes or cancel
unstarted work before allowing those workers to run. If the installation has no
validated offline procedure, keep it stopped and arrange that recovery; do not
start old Mail merely to clear the upgrade check.

Once recovered command state is safe for the old workers and admission remains
blocked, old Mail may run for the remaining evidence checks. The old release's
`cld mail operator run reconcile --command <command-id> --wait` checks evidence
without resending; see [Check delivery after the update](/en/docs/operations/scaling-and-shutdown#check-delivery-after-the-update).
Keep replacement Code and routine admission off. Repeat the drain and create a
new recovery point before trying the upgrade again.

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
grants and Studio database grants do not transfer. Studio RSQL is removed.
Each lasting Code now has its own lazy database, created on its first `db` call.
Nothing is carried over: export Studio databases on the old version (step 2)
and create the recovery point after draining (step 3).
Configure the new Core-owned RSQL URL, secret token and allowed targets in
**Administration → Code → Limits**; the old `assistant.rsql_*` settings are deleted.
RSQL 1.1.0 is required for bound writes and atomic batches.
`core.code.database_bytes` now enforces each Code database's storage limit.
Keep the configured RSQL server available while Code databases exist, including
for deletion. Changing the URL does not move existing databases.

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
- Check that routine mandates are retired, the `version = 5`, `name = 'rules_retired'` row exists in
  `mail.schema_migrations`, and `assistant.studio_retirement.completed` is true.
  For routine mandates, the following read-only SQL must return `0`:
  ```sql
  SELECT count(*) FROM auth.mandates
  WHERE owner_app_id = 'core' AND workload_type = 'ai.chat-task' AND state <> 'revoked';
  ```
  Restart once and confirm no retired timer or admission is recreated.
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

Mailbox Code was not accepted against a real mailbox before this release; its
tests deliver simulated messages to the Mail handler. Check it once on your
installation: switch on one mailbox Code version on a test mailbox, send that
mailbox a message from an outside address, and confirm that the run list shows
one run for it with the expected effect.

## Related pages

- [Export automation definitions](/en/docs/operations/automation-definition-export)
- [Routines became Code](/en/docs/operations/routines-to-code)
- [Replace Mail rules with mailbox Code](/en/docs/operations/mail-automation-upgrade)
- [Mail automations with Code](/en/docs/platform/mail-code-automations)
- [Activate a Code version](/en/docs/platform/code-activation)
- [Removed in the Gustav release](/en/docs/reference/code-release-removals)

## Code SDK names and response bodies

Before activating Code, check it against the current installation SDK. SDK
property segments use camelCase, Files exports as `files`, and schedules
require a stable `name`. Capability IDs and `filesv2.*` event names retain
their spelling. Use `await response.text()` or `await response.json()` for
HTTP response content; the raw bytes are in `response.bodyBase64`. Existing
checked versions keep their embedded SDK. Apply this contract when checking
a new version.

Paginated Queries expose the shared `page` envelope alongside existing
domain cursors. Queries with a string `cursor` input must return `page`;
a declared string `next` or `nextCursor` must match that envelope.

## Code pages and guests

Pages of Code that are not public open for every signed-in member and no
longer for guest accounts. A guest gets 403 instead, for personal, mailbox
and app Code alike. Public pages are unchanged. Code that should serve guests
needs a public route, which receives no visitor identity.
