---
title: Mail capability targets
navTitle: Mail capabilities
section: Platform services
order: 554
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

## Code access at a mailbox

`mailboxCodeAccess.manages(tx, context, id)` checks current mailbox-wide
administration using the supplied transaction. Target, manager-share and group
membership locks remain held through the grant or removal. Assigned-only grants
never make someone a mailbox manager. Grant and removal also lock and check the
target when a live Cloud administrator bypasses the manager check.

Successful dry-run `mail.code.access.set` results contain `managerUserIds`: current
people with mailbox-wide administration, including nested manager-group members.
Core uses these IDs for activation notifications. Ordinary Mail permissions,
assigned-only access and sending behavior are unchanged.

Mail declares `mailbox` as both a Code target and a type that may own Code.
Core manages access through `mail.code.access.set`, `mail.code.access.list`
and `mail.code.access.rm`. Use the public mailbox ID in
`{ type: "mail.mailbox", id }`. The platform checks Core's activation proof
and the person's current mailbox administration rights; its Cloud-admin
override follows the shared [Code access contract](/en/docs/platform/capabilities#code-access-at-the-target).

Mail chooses the smallest mailbox level covering the requested operations:

| Requested operations | Level or refusal |
| --- | --- |
| Read Queries | `read` |
| Any ordinary Mail Action, or `draft.send.review` | `write` |
| `folder.display.set` or `conversation.keep.release` | Refused: requires administration |
| Unknown or foreign operation | Refused |

One unsupported operation refuses the complete grant. An empty operation set
is valid only for an owner dry run and creates no share. A dry run with
operations checks the same level without saving a grant.

Code receives only its own explicit mailbox access. Group membership, public
shares and shares with all signed-in people do not add access. Code never
counts as a mailbox administrator. People's existing Mail permissions and
assigned-conversation access keep their behavior.

Each activation grant has its own `grantId`, also returned on its entry in the
mailbox's normal access list. Use Core and `code.access.rm` with that ID to
remove Code access; ordinary share update and removal endpoints refuse Code
entries. Change its level through a new activation. Removing it takes effect
on the next permission check. Other grants at the same mailbox remain in place, including overlapping
grants for the same Code account. Listing Code access returns only grants of
the requested account; the platform further limits a person's list to targets
they manage. A removed grant requires a new activation to restore it.
