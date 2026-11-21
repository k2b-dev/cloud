---
title: Export automation definitions before an upgrade
navTitle: Export automation definitions
section: Operations
order: 951
description: Preserve all Mail rule versions and personal routines before an upgrade removes their authoring paths.
tags: [mail, assistant, automation, migrations]
updated: 2026-11-08
---

# Export automation definitions before an upgrade

Export Mail rules and Assistant routines **before upgrading** to a release that
removes them. For the whole cut to Code, follow
[Upgrade to Code](/en/docs/operations/upgrade-to-code). The commands below also work as a read-only inventory without an
upgrade. They neither pause nor activate anything.

Update the installed Mail and Assistant CLI plugins first. Select the intended
Cloud profile explicitly. A mailbox administrator can export that mailbox; a
person can export their own routines:

```sh
cld mail automation export --profile <profile> --mailbox Support --json > mail.partial.json
cld assistant tasks export --profile <profile> --json > routines.partial.json
```

A Cloud administrator can export the installation, including mailboxes they do
not administer and routines owned by other people. Use a signed-in administrator
profile (web session or user OAuth login), rather than a delegated workload key:

```sh
cld mail automation export --profile <admin-profile> --all --json > mail.partial.json
cld assistant tasks export --profile <admin-profile> --all --json > routines.partial.json
```

Both commands fetch every page. Text and `--json` output are one JSON document;
`--jsonl` emits one complete API page per line. Keep the command's exit status:
a failed request leaves an incomplete file. Retry from the beginning after
resolving the reported error. Validate both successful JSON exports before
renaming or archiving them:

```sh
jq -e '.format == "cloud.mail-automation" and .version == 1 and .nextCursor == null' mail.partial.json
jq -e '.format == "cloud.chat-tasks" and .version == 1 and .nextCursor == null' routines.partial.json
```

Store the verified files with the upgrade's restricted backup material. They
contain prompts, rule source, resource references and personal schedules.
Credential stores, tokens, authorization snapshots and execution transcripts
are excluded. Keep credentials in the designated secret store, rather than
embedding them in rule text or prompts.

## What the export preserves

Mail uses format `cloud.mail-automation`, version `1`. Each `items` entry has
`kind: "mail-workflow"` and represents **one immutable workflow version**.
Group entries by `mailbox.id` and `workflow.id` to see all versions of a rule.
The export includes guided rules, YAML workflows, disabled definitions and
managed automatic replies, without the authoring lists' result caps.

Each entry contains mailbox identity and deletion state (`mailbox.deletedAt`), workflow name and description, enabled
state, priority, execution order, current and active version IDs, and exact YAML
in `version.source`. That version also carries its revision, source hash,
language and manifest versions, effect budgets and bound resource references.
The mailbox's configured `aiCallsPerDay` is included as evidence too; it does
not imply that the old workflow path enforced that daily limit.
AI prompts, output schemas and classification choices remain in the YAML and
guided steps. `guidedDefinition` is the **current** guided definition and
revision, not a reconstructed historical editor state. Historical definitions
remain available as their exact YAML. Deleted guided definitions retain their
`deletedAt` marker where their workflow is still stored.

`activations` records current trigger configuration and enabled state. A guided
rule's Spaces target restrictions remain in its steps (`itemId`, `spaceId`,
`columnId` and event configuration); `mandateSummary` records the current
mandate's identity, state, revision, expiry, applications and operations.
Automatic replies include their text, sender identity, time windows and rate
interval. They are preserved as evidence; this export does not create a replacement.

Routines use format `cloud.chat-tasks`, version `1`. Each entry has
`kind: "chat-task"`, its owner, title, prompt, locale, exact once/cron schedule,
timezone, grants with fixed input restrictions, mandate summary, state,
revision, reason code and target Assistant chat. Completed, paused and
needs-attention routines are included alongside active ones. Run history and
chat contents are outside this definition export.

Every document declares `authority: "none"`. **An export grants nothing.**
Recorded grants, IDs, approval states and enabled flags are evidence of the old
definition; they cannot authorize a new workload. A person with current access
must review its replacement and explicitly activate it.

## Coordinate the upgrade

Stop edits to definitions while taking the final export. API pages are live
reads, not one installation-wide transaction. Changes between pages can mix
revisions; repeat the export if editing continued.

Before enabling replacements, stop old admission and timers, then finish or
visibly cancel their open runs. Record the last old delivery, the first new
delivery and how any gap will be replayed. Never leave both paths processing
the same arrivals. Exporting alone does not perform this transition. Preserve old run
and log evidence separately; these commands export definitions only.

Grids definitions are outside these exports.

## Read pages through the API

| Export | Read-only GET route | Required access |
| --- | --- | --- |
| Mailbox | `/api/mail/mailboxes/:mailboxId/automation-export` | Whole-mailbox administrator |
| All Mail | `/api/mail/admin/automation-export` | Current Cloud administrator |
| Own routines | `/api/ai/tasks/export` | User-backed actor, own routines only |
| All routines | `/api/ai/admin/tasks/export` | Current Cloud administrator |

`mailboxId` is the public Mail ID. Mail returns one complete version per page, so large reply bodies are not
multiplied by a list page size. Its `limit` is `1`. Routines accept `limit`
(1–100, default 100). Both accept `after` (the previous response's `nextCursor`). Follow `nextCursor`
until it is `null`, including when exporting more than 200 versions or more
than 100 routines. Cursors order immutable record UUIDs; Mail's execution order
is the separate `workflow.order` field (priority ascending, then workflow UUID).
An empty export is successful and contains `items: []`.

These framework-owned helpers are available from `@k2b/cloud/ai` for Core's
routine export routes: `exportChatTasks`, `ChatTaskExportPageSchema`,
`ChatTaskExportEntrySchema`, `ChatTaskExportQuerySchema` and
`ChatTaskExportForbiddenError`. Applications consume the authorized HTTP routes.
