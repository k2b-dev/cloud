---
title: Assistant place chats
navTitle: Assistant place chats
section: Operations
order: 1275
description: Understand the chat-list default and database migration for Assistant place context.
tags: [operations, assistant, migrations]
updated: 2026-11-08
---

# Assistant place chats

Assistant chats can belong to an application resource, called a place. They
remain private to the person who starts them. Chat lists now omit place chats
by default. API consumers and CLI workflows that need them must pass
`place=any`, or an exact `<type>:<id>` reference; this selects place chats only.
Use separate requests for ordinary and place chats when both are needed.

Core's normal AI migration adds nullable place columns and a partial unique
index for one non-archived chat per person and place. Existing chats stay
ordinary chats; no manual backfill is needed. A place is also entered in the
existing conversation resource index when its chat is created.

Starting over archives the current chat. An archived place chat cannot be
restored while its replacement is active. Unread and attention counts include
place chats. Listing uses the stored place title without querying the owning
application; opening the place checks its current availability.

See [Chat runtime and streaming](/en/docs/ai/chat-runtime-and-streaming#list-place-chats)
for the list, count, and CLI contract.
