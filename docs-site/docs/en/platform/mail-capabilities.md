---
title: Mail capability targets
navTitle: Mail capabilities
section: Platform services
order: 554
description: Address Mail Actions at one mailbox, keep their contained resources in that mailbox, and offer attachments in the file chooser.
tags: [mail, capabilities, agents]
updated: 2026-11-27
---

# Mail capability targets

Every Mail Action acts at one `mail.mailbox` target. Supply its public mailbox
ID in `target`, and put the change in `input`. The input no longer accepts
`mailboxId`:

```ts
await invokeCapability({
  appId: "mail",
  kind: "action",
  capabilityId: "conversation.status.update",
  target: { type: "mail.mailbox", id: mailboxId },
  input: { conversationId, expectedRevision: 3, status: "done" },
}, caller);
```

`invokeCapability` comes from `@k2b/cloud/capabilities/server`. For HTTP,
review, CLI, digest and retry contracts, see
[App capabilities](/en/docs/platform/capabilities#name-the-resource-an-operation-acts-on).
Chat and MCP arguments stay flat: the target field is `mailbox`, followed by
the domain fields such as `conversationId`, `status` and `expectedRevision`.
Capability names, approval policies and idempotency requirements stay the same.

## Keep contained resources in the mailbox

Conversations, messages, folders, drafts, attachments, sender identities,
signatures, tags, comments and deliveries referenced by an Action must belong
to its mailbox. The same checks apply during review and execution. Knowing a
resource ID or having access to a second mailbox does not make it a valid
member of the first mailbox.

`conversation.assign.batch` and `conversation.status.update.batch` validate
**every** conversation before reviewing or applying the batch. A member
outside the target mailbox, or a missing member, returns `NOT_FOUND` before
any member is changed. They retain their existing 50-conversation limit and
result schemas. A conversation deleted after validation can still produce a
per-member `not_found` result.

The normal Mail service permissions and revision checks still apply. REST,
`cld mail` and the Mail interface keep their existing mailbox selection and
composition behavior.

## Choose the Query shape

These Queries use the same mailbox target and omit `mailboxId` from input:

| Purpose | Queries |
| --- | --- |
| Mailbox selectors | `mailbox.identity.list`, `mailbox.member.list`, `folder.list`, `mailbox.tag.list` |
| Conversations and messages | `conversation.list`, `conversation.search`, `conversation.related`, `message.list` |
| Drafts and deliveries | `draft.list`, `draft.send.review`, `delivery.list` |
| Collaboration | `conversation.comment.list`, `conversation.activity.list`, `conversation.reminder.get` |
| Mailing lists | `mailing-list.subscription.list`, `mailing-list.subscription.get` |

Canonical readers such as `message.read` and `draft.read` still accept one
`id` and resolve its mailbox under current access. `mailbox.browse`,
`mailbox.list`, `conversation.focus` and `search` also retain their domain-only
inputs, so discovery and cross-mailbox searches need no chosen target.

`draft.send.check` is an Action outcome check. Cloud requires outcome checks
to keep domain-only inputs, so it retains `{ mailboxId, draftId,
expectedRevision }` without a target. The send review continues to supply
that check unchanged. `draft.send.review`, which prepares a send-safety
review, uses the mailbox target.

## Keep calendar composition interactive

The `compose` and `draft.calendar` Commands keep their existing input
contracts. Opening either Command still opens the current Mail flow and sends
nothing. Calendar invitation creation uses the same mailbox target when it
creates a Mail draft; the sender, attachments, revision, send-safety review and
send approval follow the existing compose flow.

Spaces owns calendar events and Mail owns drafts and sending. Actions that
cross those ownership boundaries remain subject to the calendar provider's
`code: false` declaration for resource-owned Code. A Mail target grants no
calendar access and does not authorize a send.

`mailbox.read` includes the canonical `data.view` with the mailbox title and
current effective permission. Core uses this view when checking whether a
person may author or activate mailbox-owned Code.

## Code access at a mailbox

A mailbox manager grants the Code service account View or Edit through the
mailbox's normal share dialog, using its exact handle. The same services add,
change and revoke these shares. Assigned-only access does not make a person a
mailbox manager. Share changes retain current manager authority and target locks
until commit, following the
[normal share contract](/en/docs/identity/authorization#retain-manager-authority-while-changing-a-grant).

Mail declares `mailbox` as a Code owner and retains its page, reader and
`access.readable` contracts. Code activation checks the owner but creates no
mailbox or foreign-target rights. Every actual call uses current mailbox access;
Code inherits no group, signed-in or public grants and never counts as a manager.
Removing or lowering a share applies on the next permission check. Activating
again cannot restore it. Mail's ordinary sending, assigned-conversation and
personal automation mandate rules continue to apply.

For incoming-message handlers, keyword limits, catch-up and previews, see
[Mail automations with Code](/en/docs/platform/mail-code-automations).

## Offer attachments in the file chooser

Mail is a read-only source named **Mail** in every file chooser, beside
**This device** and Files. Someone can attach a file they once received by
mail without downloading and uploading it again. Mail declares
`fileProvider: { list: "attachment.files.list", read: "attachment.content.read" }`
and has no `save`. See [File providers](/en/docs/platform/file-providers).

The source has these folders:

1. One folder for each mailbox the person can read and has not hidden. The
   folder name is the mailbox's address, or the mailbox name if it has no
   connection.
2. Years, then months, newest first. Month names use the person's language.
3. One folder for each sender in that month, named `Name (address)` or by
   address only. Mail without a sender is under **Unknown sender**.
4. The attachments from that sender in that month, newest first.

Mail indexes every attachment it stores and decides when it lists one. These
attachments are not in the source:

- An inline part (`Content-Disposition: inline`) that the message body shows
  through a `cid:` link to its Content-ID, such as a signature logo. An inline
  part with a Content-ID that the body does not show stays in the source.
  Apple Mail and iOS Mail send photos and PDFs this way.
- A JPEG, PNG, GIF or WebP image smaller than 4 KiB. These are the formats
  that the Mail list previews, and it leaves out the same small images as
  logos. Other small files, such as an SVG, stay in the source.
- A file larger than 100 MiB, which `attachment.content.read` does not open.
- An attachment of a message that is no longer in any folder.

Months are in UTC, because capabilities do not know the person's time zone.

Access follows the Mail list. A person with access to the whole mailbox sees
all its attachments. A person with assigned access sees only the attachments
of their assigned conversations, and their years, months and senders. A
person who reads one mailbox never sees the folders of another mailbox.
Credential scopes and resource-bound service accounts limit the source the
same way as other Mail reads. `attachment.content.read` checks access again
for each file. It streams the stored attachment with a limit of 100 MiB.

Each folder is one query with keyset pagination of up to 100 entries. For a
person with access to the whole mailbox, years and months take one index
step each, a month's senders read that month, and a sender's files read an
index range. For a person with assigned access, each folder reads only the
attachments of their assigned conversations, however large the mailbox is.
A mailbox folder costs six statements, whatever the page size: one to find
the mailbox, four for access, and one for the folder.

### Upgrade

The upgrade adds the table `mail.attachment_files` and its indexes. It
changes no existing data. Mail fills the table when it stores a message.
After start, Mail adds the attachments that were stored before the upgrade
in a background job, 100 attachments per transaction. The job saves its
position in `mail.attachment_files_backfill`. A restart or a second replica
continues from that position. The job does not wait for a message that Mail
is storing or syncing at that moment. It leaves that message for a later run
and pauses for 50 ms between transactions. Until the job is done, the source
shows only part of the older attachments.

A replica that still runs an older image does not add attachments to the
table. It also removes rows when it loads a message again, because loading
replaces the message's attachments, and it does not add the new rows.
Upgrade all Mail replicas together. If an older replica ran during or after
the job, delete the single row of `mail.attachment_files_backfill`. Mail
then runs the job again on its next start. A new run adds only the missing
attachments.
