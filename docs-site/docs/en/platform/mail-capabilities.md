---
title: Mail capability targets
section: Platform services
order: 556
description: Address Mail Actions at one mailbox and keep their contained resources in that mailbox.
tags: [mail, capabilities, agents]
updated: 2026-10-31
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
