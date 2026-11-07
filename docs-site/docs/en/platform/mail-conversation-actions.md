---
title: Mail conversation actions
navTitle: Mail conversation actions
section: Platform services
order: 1615
description: Write protected summaries, set work status, claim unassigned conversations, and change one message through Mail capabilities.
tags: [mail, capabilities, cli, collaboration]
updated: 2026-11-06
---

# Mail conversation actions

Use these Actions through the capability API, Assistant, or `cld` with current
Mail write access. Discover mailbox, conversation, message, and folder IDs from
Mail readers. These Actions declare `policy: { silent: "shared" }`; platform
policy and current Mail permissions still apply. Assignment and reference
allocation require mailbox-wide write access. Status, summaries, and message
changes also allow writers restricted to their assigned conversations.

## Save a prepared summary

`mail.conversation.summary.write` saves text you have already prepared. It does
not call an AI model. Supply `mailboxId`, `conversationId`, `summary` (1–50,000
characters after trimming), `expectedRevision`, and `expectedSummaryRevision`.
Read both revisions from `mail.conversation.read` before preparing the text.
A changed conversation or summary returns `CONFLICT` without writing.

A summary that a person wrote, edited, accepted, or cleared stays protected,
even when you supply its current revisions. The successful result then has
`skipped: "edited_by_person"` and returns the unchanged revisions.
Otherwise `skipped` is `null`, and the result carries both resulting revisions.
Read summary text through `mail.conversation.read`. Mail records the source as `automation` and keeps the
caller's activity identity. An unchanged automated summary does not advance
its revisions. Unloaded or failed message bodies do not count as covered; Mail
keeps them visible as messages not covered by this summary.

An idempotency key is required. Reuse the same key only for the same prepared
request. After a conflict, reread the conversation and prepare a new request.
Cloud's capability replay window does not replace Mail's revision fences.

```bash
cld mail conversation summary write Convo1 --mailbox Mail01 \
  --revision 7 --summary-revision 3 --body-file summary.md \
  --idempotency-key summary-request-42
```

## Set work status

`mail.conversation.status.set` accepts `needs_action`, `waiting`, `done`,
and `open`, together with `expectedRevision`. `open` keeps its existing
behavior: Mail derives the next step from the latest verified message direction.
The other values set the requested status explicitly. A status change clears
an active snooze; change status and snooze separately.

The published `mail.conversation.status.update` and `.batch` Actions keep
accepting only `done` and `open`. Use `status.set` for the full status set.

The `mail.conversation.status.set.batch` Action accepts up to 50 unique `conversationIds`. Its optional
`expectedRevisions` object must supply a revision for every requested ID. Mail
checks every visible conversation before changing any; one stale revision
returns `CONFLICT` and leaves the whole batch unchanged. Without that object,
the batch acts on the current locked state, as before. Missing or invisible
conversations return `not_found` per item.

The shared Mail status service still fences personal changes and records which
message links a decision covers. Later incoming mail can restore `needs_action`;
late hydration of a covered message does not undo the decision.

```bash
cld mail conversation update Convo1 --mailbox Mail01 --revision 7 --status waiting
```

## Change one message

`mail.conversation.move` and `mail.conversation.mark` accept an optional
`target.messageId` alongside `target.conversationId` and `target.sourceFolderId`.
When supplied, Mail changes only that message and its provider copies in the
source folder. It refuses a message outside the named conversation. Omitting
`messageId` keeps the existing whole-conversation behavior.

Move accepts a destination folder or `inbox`, `archive`, `trash`, or `junk`.
Mark accepts `read` and `flagged`; with an exact message target it also accepts
`answered` and `draft`. The `draft` flag changes provider state and does not
create an editable Cloud draft. Both Actions require an idempotency key and use
the existing provider-command path, including folder rights, provider errors,
local projections, and kept-conversation protection. Their result is an accepted
command list with a `correlationId`, rather than proof that the provider has
finished. A message-target result also includes `messageId`.

The existing `cld mail message move`, `read`, `unread`, `flag`, and `unflag`
commands remain available. Inspect queued changes with `cld mail command get`
or wait with `cld mail command wait`.

## Claim an unassigned conversation

Use `mail.conversation.assign` with `mode: "add"`, a nonempty
`assigneeUserIds` list, `onlyIfUnassigned: true`, and `expectedRevision`.
Mail checks the revision and the complete current assignee set atomically.
An existing assignee or stale revision returns `CONFLICT` without adding anyone.
Concurrent claims with the same revision have at most one winner. Ordinary
add/remove/replace calls keep their existing behavior.

```bash
cld mail assign Convo1 --mailbox Mail01 --to ada --only-if-unassigned --revision 7
```

## Ensure a reference

`mail.conversation.reference.ensure` takes `mailboxId` and `conversationId`
and requires an idempotency key. It returns an existing immutable reference or
allocates one using the mailbox's enabled reference-number configuration.
Replaying the same key or calling again with a different key for the same
conversation does not consume another number. Reusing a key for another
conversation returns `CONFLICT`. Disabled or missing configuration refuses
the request, including lookup of an existing reference with a new key. The result includes `value`, `role`, `created`, and
`conversationRevision`.

```bash
cld mail reference-number ensure Convo1 --mailbox Mail01 --idempotency-key reference-42
```
