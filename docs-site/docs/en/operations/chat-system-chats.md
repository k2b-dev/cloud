---
title: Chat system conversations
navTitle: Chat system chats
section: Operations
tags: [chat, permissions, operations]
order: 1600
description: Access, dependencies, and API behavior for Chat conversations attached to Spaces and Notebooks.
updated: 2026-10-23
---

# Chat system conversations

Chat's backend can attach a conversation to a Space or notebook and a thread
to a task, event, or note. This slice adds the API. It does not add navigation
in Spaces or Notebooks, migrate comments, or publish item-change events.

## Open a conversation

All paths below start with `/api/chat`.

| Request | Result |
| --- | --- |
| `GET /system-chats` | One page from each application's container list, including containers with no conversation yet. |
| `POST /system-chats/:resourceType/:resourceId/open` | Create or return the container's conversation. Types are `spaces.space` and `notebooks.notebook`. |
| `POST /conversations/:conversation/threads/for-resource` with `{ "ref": { "type": "spaces.item", "id": "…" } }` | Create or return an item thread. `notebooks.note` is also supported. |
| `GET /conversations/:conversation/threads` | Authorized threads, with optional `filter=open\|done\|unread`, `q`, and `cursor`. |

System conversations have `kind: "system"` and a container `resource` ref.
Item threads have `resource: { ref, kind, status, done, href }`. Their current
name, description, and open link come from the reader. `status` is the Space
column ID, or `null` for notes. `done` follows the reader's `completedAt`;
notes have `done: false`.

Opening requires container read access. Creating an item thread and sending
messages require container write access. The item reader must also authorize
the caller, and its parent must match the conversation. Retrying either open
operation returns the same object. Creating an item thread emits no
`thread_created` message. Omit `thread` or pass `null` when sending to General.

System chats reject manual thread creation, renaming, archiving, chat metadata
edits, and membership changes. Change container permissions in its owning app.
Chat does not enumerate that app's members or copy their grants.

Unread messages begin at each participant's first open. Reopening preserves
that position. Messages before the first open cannot be marked unread.

## Follow pages

Container discovery requests at most 100 Spaces and 100 notebooks. Pass the
returned `spacesCursor` and `notebooksCursor` independently to continue each
source. A container's `conversation` is `null` until someone opens it.

A system thread page inspects at most 100 candidates in thread-ID order.
Visibility, search, and state filters apply within that page. Follow a non-null
`nextCursor` even when `items` is empty. Ordinary chats retain their existing
activity and archive ordering.

Conversation summaries count only authorized item threads. Exact totals and
history reads can traverse several candidate pages. Each reader batch has at
most 8 concurrent calls; request cancellation stops further batches. A cold
cache therefore costs more for a container with many threads. Unread totals
retain Chat's existing cap of 100.

## Access and runtime dependencies

Chat uses the public capability transport to Core with the requesting person's
cookie or account credential. Core exchanges that credential for a restricted
invocation; Chat never sends it directly to Spaces or Notebooks. Container
reader permission `read`, `write`, and `manage` maps to Chat `read`, `write`,
and `admin`. The current readers also expose `admin`, which maps to `admin`.
Service accounts and agents retain their existing scope and resource caps.

Valkey stores decisions for 60 seconds, separately for each principal,
credential scope, and resource. A revoked permission can remain usable during
that interval. Reader failure or unavailable Valkey denies access when no
valid decision exists. Chat's own grants never replace an unavailable reader.
No credential is stored in the cache or a background job.

Live item messages and summaries use separate thread keys. Delivery requires
cached authorization for both the container and item. The platform's live
viewer carries no credential: a missing or expired decision denies delivery
until an authenticated HTTP read refreshes it. Clients must refresh a snapshot
when the live subscription requests resynchronization. The platform's existing
short live-authorization cache still applies. System read receipts are not
published on personal channels, which cannot check each receiver's container
and item permissions; HTTP read responses contain the authorized read state.

The startup migration adds conversation kind and resource columns, thread
resource columns, and unique indexes. Existing conversations remain ordinary
chats. Manual thread names remain unique within a conversation; distinct items
may have the same title. Chat's member reconciliation excludes system chats,
whose authority belongs to the owning application.

The OpenAPI document at `/api/chat/openapi.json` describes request and response
schemas. No additional environment variable or app workload credential is
required for this request-driven slice.
