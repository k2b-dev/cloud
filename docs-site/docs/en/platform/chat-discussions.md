---
title: Item discussion capabilities
navTitle: Item discussions
section: Platform services
order: 75
tags: [chat, capabilities, permissions]
description: Read and write the Chat discussion of a provider-owned resource.
updated: 2026-10-30
---

# Item discussion capabilities

Chat provides five operations for an item ref whose type is declared by a
provider's `discussions` role. The type is resolved from the current catalog;
IDs are opaque strings up to 512 characters. Built-in and third-party providers
use the same contract. These operations do not expose direct chats, channels,
general messages, or manually created threads. An application's existing page
comments remain separate.

| Operation | Input | Result |
| --- | --- | --- |
| `chat.discussion.list` | `ref`, optional `limit` and `cursor` | Newest-first message previews. Listing never creates a conversation or thread. |
| `chat.message.read` | `id` from a `chat.message` ref | Full message body, attachments, shared refs, content revision, and an `open` link. |
| `chat.discussion.post` | `ref`, `body`, optional `replyTo` message ID | The stored message. Creates the item's thread when needed. |
| `chat.message.edit` | `id`, `revision`, `body` | The updated own message. |
| `chat.message.delete` | `id`, `revision` | A deleted-message marker. Text and attachments are permanently removed. |

List pages contain at most 20 messages. Previews contain at most 300 Unicode
code points; `previewTruncated` tells the caller to use `message.read`. Follow
`page.nextCursor` while `page.hasMore` is true. Deleted messages have an empty
preview and a non-null `deletedAt`.

Messages accept at most 20,000 Unicode code points and must contain non-whitespace
text. The provider owns item identity: the same ref addresses one discussion. If a
provider returns a series ref, all occurrences share that discussion. Include
an occurrence date in the text when relevant.

## Access and incoming authority

Every execution and Action review reads the item once through its type's declared
reader, then reads its current container once through the container type's
reader. Both nested calls use only the standard `data.view` projection and
the incoming actor, access subject, credential limits, and cancellation signal.
There is no interactive credential or cached permission fallback. Discovery and reads share
Chat's bounded session: 60 calls, 4 MiB, and a ten-second deadline.
An unavailable or malformed reader returns `PROVIDER_UNAVAILABLE`; unknown item types and denied resources
return `NOT_FOUND`.

The item reader supplies `view.container.ref`; its type must exactly match
the container type of the provider's `discussions` role. The container reader
supplies the caller's `view.permission` at that location. Reading needs item
and container read access. Writing also needs `write` or `admin` on that
container. No provider needs Chat-specific data or a top-level container
projection. All account kinds retain their normal credential scopes and
resource binding. Edit and delete additionally require authorship and an age
below ten minutes. The database clock decides the window. Use `revision`
from the last read; reactions do not change this content revision.

For Assistant tool restrictions and mandates, permit both type reader Queries
as well as the Chat operation. Chat does not implicitly grant that dependency. See
[Nested capability reads](/en/docs/platform/capabilities#read-from-another-capability-handler).

## Writes and retries

All three Actions require an idempotency key. Reuse the same key and input when
the outcome is unknown. Chat maps it to the existing message `clientId` and
rechecks current access before provider-side replay. Core may return its
previously recorded Action result without executing the provider again, under
the shared [idempotency contract](/en/docs/platform/capabilities). If Core returns
`IDEMPOTENCY_UNCERTAIN`, stop automatic retries and inspect current state before
deciding on a new action.

For posts to the same item in the same container, reusing a key with a different
body or `replyTo` returns `IDEMPOTENCY_CONFLICT` (HTTP 409), even after Core's
claim expires. Use a new key for a new post. After Core's claim expires, an
identical retry returns the existing message's current state, including later
edits. Deletion removes the post's input fingerprint; provider-side post
retries then return
`IDEMPOTENCY_CONFLICT`. Use `discussion.list` for the item to inspect its
current messages.

Posting supports remembered approval for one current container. Approval does
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
