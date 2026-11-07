---
title: Mail lists show open work only
navTitle: Mail open work lists
section: Operations
order: 1197
description: Mail lists, the conversation API, the CLI, and the Assistant leave out done and snoozed conversations by default.
tags: [mail, upgrade, api, cli]
updated: 2026-11-02
---

# Mail lists show open work only

From this release, Mail work lists show open conversations only. They leave
out conversations that are **done** or **snoozed**, the same rule as the Focus
view "All active". Done is a Cloud status for the whole mailbox. The upgrade
changes nothing at the mail provider, and other mail programs still see every
message.

No schema marker changes, so a rollback to the previous image keeps working.
Mail builds one new partial index, `conversations_mailbox_open_latest_idx`,
in the background after it starts (`CREATE INDEX CONCURRENTLY`, logged as
"Building Mail background index"). Until it is ready, lists still work, but
large folders read more rows. Count snapshots use a new cache key, so older
snapshots expire within 30 seconds of the upgrade.

## Which lists change

| List | After the upgrade |
| --- | --- |
| **All**, Inbox, and other work folders | Open conversations only |
| Tags, filters (unread, flagged, attachment, date), and saved views without a status condition | Open conversations only |
| Archive, Sent, Trash, Junk, and All Mail folders (provider role or configured role) | Everything, as before |
| Text search | Everything, as before; results show their status |
| The work views (Needs action, Done, Snoozed, and the others) | Their own rule, as before |
| A search, filter, or saved view with a status condition | The status condition decides |

At the end of a list that leaves done conversations out, people see the
count with a link, for example "1,207 done conversations · Show done". In
**All**, the link opens the **Done** tab. In a folder, tag, filter, or saved
view, it adds the condition "Work status: Done" to the same list.

A new incoming message still sets a done conversation back to
**Needs action**, so it returns to every matching list.

## Counts that change meaning

- The unread count of a work folder, in the sidebar, `cld mail folders`, and
  `GET /api/mail/mailboxes/{mailboxId}/folders`, counts only open
  conversations. Filing folders still count every unread message. The
  `total` count is unchanged.
- The tab counts are unchanged.

## API, CLI, and Assistant

- `GET /api/mail/mailboxes/{mailboxId}/conversations` and
  `GET /api/mail/mailboxes/{mailboxId}/saved-views/{viewId}/conversations`
  follow the rule when the request has no `view`, no `status`, and no filing
  folder. Pass `includeDone=true` to list done and snoozed conversations too.
  The conversation response has a new field `openOnly`, which says whether the
  list left them out.
- `cld mail ls` follows the rule and prints a hint on stderr in text output.
  Use `--status done` for done conversations only, or `--include-done` for
  every conversation.
- The Assistant tool `conversation.list` follows the rule and accepts
  `includeDone`.

## Check scripts and saved views

Scripts and agents that call `cld mail ls` or the conversation API and expect
every conversation now see fewer results. Add `--include-done` or
`includeDone=true` where they need the previous result.

A saved view without a status condition now leaves out done and snoozed
conversations, and its list ends with "Show done". A saved view with a status
condition lists exactly what the condition says.
