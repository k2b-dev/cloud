---
title: Item discussion capabilities
section: Platform services
order: 75
tags: [chat, capabilities, permissions]
description: Read and write the Chat discussion of a task, event, or note.
updated: 2026-10-28
---

# Item discussion capabilities

Chat provides five operations for the discussion of a `spaces.item` or
`notebooks.note`. These operations do not expose direct chats, channels, general
messages, or manually created threads. Existing Spaces and Notebooks comments
remain available until the coordinated Chat release removes them.

| Operation | Input | Result |
| --- | --- | --- |
| `chat.discussion.list` | `item`, optional `limit` and `cursor` | Newest-first message previews. Listing never creates a conversation or thread. |
| `chat.message.read` | `id` from a `chat.message` ref | Full message body, attachments, shared refs, content revision, and an `open` link. |
| `chat.discussion.post` | `item`, `body`, optional `replyTo` message ID | The stored message. Creates the item's thread when needed. |
| `chat.message.edit` | `id`, `revision`, `body` | The updated own message. |
| `chat.message.delete` | `id`, `revision` | A deleted-message marker. Text and attachments are permanently removed. |

List pages contain at most 20 messages. Previews contain at most 300 Unicode
code points; `previewTruncated` tells the caller to use `message.read`. Follow
`page.nextCursor` while `page.hasMore` is true. Deleted messages have an empty
preview and a non-null `deletedAt`.

Messages accept at most 20,000 Unicode code points and must contain non-whitespace
text. A recurring event uses one discussion for the whole series. Include the
occurrence date in the text; no operation accepts an occurrence identifier.

## Access and incoming authority

Every execution and Action review makes one fresh nested call to the owning
app's `spaces.item.read` or `notebooks.note.read`. It uses the incoming actor,
access subject, credential limits, and cancellation signal. There is no
interactive credential or cached permission fallback. A missing or unavailable
reader returns `PROVIDER_UNAVAILABLE`; denied items return `NOT_FOUND`.

The reader returns the item's current container and effective permission.
Reading needs item read access. Writing also needs write or admin on that
container. All account kinds retain their normal credential scopes and
resource binding. Edit and delete additionally require authorship and an age
below ten minutes. The database clock decides the window. Use `revision`
from the last read; reactions do not change this content revision.

For Assistant tool restrictions and mandates, permit the owner Query as well
as the Chat operation. Chat does not implicitly grant that dependency. See
[Nested capability reads](/en/docs/platform/capabilities#read-from-another-capability-handler).

## Writes and retries

All three Actions require an idempotency key. Reuse the same key and input when
the outcome is unknown. Chat maps it to the existing message `clientId` and
rechecks current access before provider-side replay. Core may return its
previously recorded Action result without executing the provider again, under
the shared [idempotency contract](/en/docs/platform/capabilities).

Posting supports remembered approval for one Space or notebook. Approval does
not replace current access checks. Edit and delete ask for approval every time.
The approval view retains the complete proposed or deleted text, including
messages at the 20,000-code-point limit. Writes share Chat's send rate limits; a
`429` includes `details.retryAfter` in seconds, and the HTTP capability route
also sets `Retry-After`.

## Visible provenance

Posts and edits persist the framework's `context.via`. Chat shows **via
Assistant** or **via MCP** beside the author, including the reader's own
messages. A later direct edit preserves an existing mark; an Assistant or MCP
edit sets its current surface. Existing content has no backfill. Callers cannot
provide `via` in the input. The mark describes the calling surface and grants
no permission; a missing mark does not prove human authorship.
