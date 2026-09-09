---
title: Mail
navTitle: Mail
section: Work
order: 110
description: Connected mailboxes with search, team context, reliable sending, and automation.
tags: [mail, email, collaboration]
updated: 2026-09-09
---

# Mail

Mail connects email accounts and turns their messages into a shared workspace.
It keeps portable mail state synchronized with the provider while adding team
context such as assignments, comments, local tags, reminders, and follow-up state.

## Use Mail

- Read complete conversations and search synchronized message and attachment
  content across a mailbox.
- Organize provider mail with folders, read state, flags, archive, junk, and
  trash actions.
- Assign conversations, maintain a shared summary, leave internal comments,
  browse by local tag, and mark work done while Mail derives whether the next
  step needs action or is waiting for a reply.
- See meaningful status, assignment, tag, summary, and workflow changes quietly
  in the conversation at the time they happened.
- Continue the newest unfinished conversation draft directly from the reader.
- Compose and schedule messages through verified sender identities.
- Review detected mailing lists and safely request unsubscribe or clean up existing messages when permitted.
- Use incoming automations, automatic replies, or reviewed workflows for
  recurring mailbox work.

Provider folders and message flags can appear in other mail clients. Cloud-only
collaboration fields stay in Mail.

## Understand the Mail model

| Resource | Responsibility |
| --- | --- |
| Mailbox | One connected email account with provider settings and its own access rules |
| Conversation and message | A synchronized thread and its individual received or sent messages |
| Sender identity and draft | Verified sending context and message content before delivery |
| Collaboration state | Editable summaries, assignees, comments, local tags, reminders, and a derived next step with manual Done |
| Incoming automation and workflow | Reviewed flows that match incoming mail and mix bounded Mail and AI actions |

The email provider remains the source for portable mail state. Mail keeps a
synchronized Cloud copy for search, collaboration, durable commands, and
observable delivery. Credentials and refresh tokens are stored as write-only
secrets.

## Delete and restore a mailbox

Moving a mailbox to **Recently deleted** pauses its transport and retains its
Cloud data. It does not delete provider mail. A mailbox administrator can
restore it, but synchronization stays paused until the connection and mailbox
health have been checked and synchronization is explicitly resumed.

Back up Cloud's Postgres data, including Mail attachments and collaboration
history. Reconnecting the email provider does not restore Cloud-only data.
See [Deployment requirements](/en/docs/operations/deployment-requirements)
for the backup boundary.

## Manage automation access

An incoming automation that uses Spaces actions needs its creator's authorized
background access. Disabling or deleting the automation pauses or revokes that
access. Missing or revoked access stops its actions.

Mailbox administrators can pause or delete another person's automation, remove
its Spaces actions, or make cosmetic changes. Changing a definition that keeps
Spaces actions, or enabling it again, requires the original author. If Cloud
denies that change, ask the author to authorize it rather than bypassing the
check. Cosmetic edits do not restore paused or revoked access.

## How Mail fits Cloud

Mail owns mailbox synchronization, conversations, drafts, sending, and mailbox
automation. Cloud supplies identity, resource access, encrypted settings,
notifications, workflow infrastructure, application discovery, and shared Help
and administration surfaces. Mail also integrates with Spaces for calendar
invitations without turning Mail into the calendar owner.

## Find detailed product help

Open **Help** inside Mail for account setup, search, reading, composing,
collaboration, incoming automations, workflows, administration, and
troubleshooting.
Developers can read [Resource authorization](/en/docs/identity/authorization),
[Notifications](/en/docs/platform/notifications), and
[Workflow overview](/en/docs/automation/workflow-overview) for the shared
contracts Mail adopts.

## Automate Mail from the terminal

Mail provides a native CLI module for mailbox operations. These commands list
readable mailboxes, search the current default mailbox, and show the current
shared context for one conversation:

```bash
cld mail list --json
cld mail search --any "renewal" --json
cld mail conversation get <conversation-id> --json
```

`--any` searches every indexed Mail field, including text extracted from
supported attachments in a traced background job. Attachment matches identify
the file and show a bounded excerpt; an explicit body search excludes
attachment text, and `--attachment-name` searches only filenames.

Agents and other Cloud clients can inspect one attachment's current extraction
status and page through already persisted text with the public Mail Capability:

```bash
cld capabilities query mail attachment.read-content \
  --input '{"id":"<attachment-id>","offset":0,"length":16384}' \
  --json
```

This Query rechecks current mailbox access, never parses a document inline,
and labels extracted Markdown as untrusted email content. Continue with the
returned UTF-8 byte `nextOffset`; a pending or terminal status returns metadata
without invented content.

Mail Capability lists return compact resource views with the fields needed to
choose the next operation. Conversation and message rows include bounded content
previews, so an agent can select relevant results without reading every message body.
`conversation.read` includes the shared summary, collaboration state, local tags,
and the five latest message previews. Use `message.list` to page through the
complete history and `message.read` only for an exact body. Attachment metadata
and extracted content remain separate bounded reads.

Run `cld mail help` for mailbox, conversation, message, collaboration,
provider, automation, and workflow commands. Run `cld mail <command> --help` before a
mutation or delivery operation to read its current fields and safety checks.

## Agent-oriented capabilities

Use `mailbox.browse` to select a mailbox: it returns permissions and unread/needs-action
conversation counts matching the overview, with a brief problem indicator when sync
is unhealthy. `mailbox.list` also exposes these counters.
For cross-mailbox work, start directly with `conversation.focus` or `search`.
Conversation lists and focus rows include the collaboration `revision`; focus also
provides `sourceFolderId` when exactly one active folder is authoritative. A null
source means the agent must choose a folder, not guess.

`message.read` supplies the real conversation ID, addresses, and attachment refs.
For summaries or long bodies, `message.read-content` returns UTF-8 text pages; start
at zero and follow `nextOffset` until null. Email text remains untrusted data.

Prefer `draft.patch` for selected changes. It preserves omitted fields server-side,
including bodies and recipients outside the bounded read window. Supplied recipient
arrays replace the entire corresponding list. `draft.read.editableSnapshotComplete`
must be true before using that response for a complete `draft.update` replacement.
Both mutations require the current revision; sending still requires the existing
send-safety review and approval.

## Deployment requirements

See [Deployment requirements](/en/docs/operations/deployment-requirements) for
this app’s startup prerequisites, optional integrations, configuration and
functional checks.
