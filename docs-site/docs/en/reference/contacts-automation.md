---
title: Contacts automation capabilities
navTitle: Contacts automation
section: Reference
order: 1262
description: React to contact creation and field changes, and use bounded tag and note Actions.
tags: [contacts, capabilities, events, automation]
updated: 2026-11-07
---

# Contacts automation capabilities

`contacts.contact.created` and `contacts.contact.updated` are version 1 resource
events with a `contacts.contact` subject and `contacts.book` place. Their public
IDs are accepted by `contact.read` and `book.read`. Creation data is empty;
update data is a bounded `changed` list of field groups, with no personal values.
See [Built-in resource events](/en/docs/platform/app-events#built-in-resource-events)
for groups, no-ops, moves, imports and transactional failure behavior.

| Action | Policy | Scope | Existing limits and checks |
| --- | --- | --- | --- |
| `tag.change` | `{ silent: "shared" }` | `book:<public-id>` | Tags must belong to the contact's current book. Add/remove deltas are atomic and repeat safely. |
| `note.create` | `{ silent: "shared" }` | `contact:<public-id>` | Requires a user-backed actor, current write access and an idempotency key. Replays create no second note. |

Both Actions are closed-world and non-destructive. Their English and German
reviews retain the complete proposed change and a compact preview. Review and
execution both check current write access; a policy grants none. In this
release, supporting clients may remember the first scoped confirmation.
Deleting and moving contacts retain their existing approvals.

Imports are limited to 1,000 entries and bulk tag/move operations to 500 selected
contacts. They use the same transactional publication path and the
[shared event capacity budget](/en/docs/operations/app-events#plan-retention-and-outage-capacity).
