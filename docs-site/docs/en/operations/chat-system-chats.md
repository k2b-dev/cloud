---
title: Chat system conversations
navTitle: Chat system chats
section: Operations
tags: [chat, permissions, operations]
order: 1600
description: Access, dependencies, and API behavior for Chat conversations attached to Spaces and Notebooks.
updated: 2026-10-24
---

# Chat system conversations

Chat attaches a conversation to a Space or notebook and a thread to a task,
event, or note. The Chat app lists these conversations under **Spaces and
Notebooks**. Their item directory and message links work in the full page
and below `/app/chat/panel` in the universal panel. This does not add
navigation in Spaces or Notebooks, migrate comments, or publish item-change
events.

## Open a conversation

All paths below start with `/api/chat`.

| Request | Result |
| --- | --- |
| `GET /system-chats` | One page from each application's container list, including containers with no conversation yet. |
| `POST /system-chats/:resourceType/:resourceId/open` | Create or return the container's conversation. Types are `spaces.space` and `notebooks.notebook`. |
| `POST /conversations/:conversation/threads/for-resource` with `{ "ref": { "type": "spaces.item", "id": "…" } }` | Create or return an item thread. `notebooks.note` is also supported. |
| `GET /conversations/:conversation/threads` | Authorized threads, with optional `filter=open\|done\|unread`, `q`, and `cursor`. |

System conversations have `kind: "system"` and a container `resource` ref.
Their message views include the same viewer-specific `reactions` as ordinary
chat messages. Reaction live events carry a refresh hint on the item thread
key; clients read the current reactions over HTTP.
Item threads have `resource: { ref, kind, status, done, href }`. Their current
name, description, and open link come from the reader. `status` is the column
name resolved through the authorized `space.read` columns, or `null` when no
label is available. `done` follows the reader's `completedAt`; notes have
`done: false`. Optional `deadline`, `deadlineAllDay`, `assignees` (display
names), `startsAt`, `endsAt`, and `allDay` retain the owning reader's task and
event metadata. Missing fields stay absent; notes supply none of these task
or event fields. Chat displays no numeric container membership count because
these readers do not supply one.

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

## Search the chat list

`GET /api/chat/search?q=IT` returns `{ items, systemUnavailable?: true }`.
The required `q` is trimmed and must contain 1–100 characters; invalid input
returns HTTP 400. Matching is literal and case-insensitive, including `%`,
`_`, and punctuation. The response contains at most eight hits, ordered by
exact name, name prefix, word prefix, then other substring matches. Recent
activity breaks ties. Archived conversations follow all active results;
archived threads are excluded.

| Hit | Fields |
| --- | --- |
| Chat or subscribed channel | `{ kind: "chat", conversation }`, using the existing conversation-list summary. Generated titles use the caller's sidebar names and locale. |
| Named thread or item thread | `{ kind: "thread", conversation: { id, title, kind }, thread: { id, name, resource? } }`. The optional item resource contains `{ kind: "task" \| "event" \| "note", done }`. |
| Space or notebook | `{ kind: "system", ref, name, conversation }`. The container ref uses `spaces.space` or `notebooks.notebook`; `conversation` is `null` until its chat exists. |

Ordinary results include only chats where the caller is a member, including
subscribed channels. Discovery access alone does not add a result. Search
covers ordinary titles and named threads before applying the result limit.
It uses PostgreSQL and the existing membership indexes, with at most four
member names inspected to derive each unnamed chat's title.

Container discovery sends `query: q` and `limit: 100` to each owning app's
existing list query. Item discovery inspects the 100 most recently active
non-archived item threads across existing system conversations. Their stored
names are snapshots: matching uses each reader's current name and completion
state. Container and item readers must both allow the caller, and the item's
current parent must still match the conversation. The existing 60-second,
credential-specific decision cache applies. Reader batches have at most eight
concurrent calls. These candidate bounds mean an older item thread or a
container beyond its owner's first matching page can be absent from search.

Existing system-chat summaries include `summaryCursor: ""`: search spends
its item-reader budget on matching and leaves summary continuation to the
existing conversation route. Container activity uses General messages and
readable item candidates. Open a container with no conversation through the
existing `POST /system-chats/:resourceType/:resourceId/open` route.

If either owner fails, search retains ordinary hits and successful results
from the other owner, and sets `systemUnavailable: true`. Show the partial
failure separately and retry the same query. An explicit denial omits the
resource. An empty successful response is `{ "items": [] }`.
The standard Chat list request limiter applies (HTTP 429); disconnects cancel
search queries and further reader work.

The browser client in `frontend/search-api.ts` exports `createSearchApi()`
with `search(q, signal?)` and the `SearchHit`, `SearchResult`, and `SearchApi`
types. It validates both the query and response and preserves server error
messages and codes.

## Follow pages

Container discovery requests at most 100 Spaces and 100 notebooks. Pass the
returned `spacesCursor` and `notebooksCursor` independently to continue each
source. Omit a source cursor for its first page, and pass the empty string
for an exhausted source while advancing the other one. A container's
`conversation` is `null` until someone opens it. Provider failures or malformed
list responses fail discovery with `PROVIDER_UNAVAILABLE` (HTTP 500), so the
client shows an error and retry instead of an empty or silently partial list.

A system thread page inspects at most 100 candidates by latest activity,
with the thread ID breaking ties.
Visibility, search, and state filters apply within that page. Follow a non-null
`nextCursor` even when `items` is empty. Ordinary chats retain their existing
activity and archive ordering. `short=true` selects the four recent candidate
threads, unread candidates, and optional `selected` thread within one
100-candidate budget. The selected thread and recent candidates take priority.
Candidate selection precedes item authorization and unread-state calculation;
short refreshes never calculate unread state across the whole directory.
The short selection has no continuation; use the directory for more threads.
It never supplies an aggregate count. Automatic refresh reads this one short
page, while explicit directory browsing follows cursors. Live directory
refresh re-reads exactly the number of pages the reader already loaded,
sequentially and with cancellation, preserving existing row nodes.

Conversation summaries count only authorized item threads in the current
candidate page. A non-null `summaryCursor` means the counts and preview are
partial. Continue at `GET /conversations/:conversation?summaryCursor=...`,
including when the cursor is the empty string (no item candidates inspected
yet). Add each page's `threads` and `unread`, capping unread at 100; General
is counted once, on the first inspected page. Select the newest `lastMessage`
across pages. Counts describe each request's current authorized view; changes
between requests can change the totals. The sidebar and automatic conversation
refresh use one bounded summary page and retain its partial marker; they do
not exhaust summary continuations before rendering. While a summary is partial,
the row and section show `…` for an unknown count or `n+` for a lower bound.
An incomplete zero does not mark the section as read, including for the open chat.

The reader request budget is **302 calls**: two container-list calls, up to
100 container readers per source, and 100 item readers shared across all
summaries. `SUMMARY_TRAVERSAL_BUDGET` is the remaining 100 calls after reserving
the two source pages from `READER_REQUEST_BUDGET`. A single summary also stops
after 100 candidate threads. Hidden candidates consume the same traversal
budget as readable ones. There are at most eight concurrent reader calls;
request cancellation stops further batches. This bounds work, not response
latency when an owning application is slow.

General and an individually selected thread authorize only the container and,
for the latter, that item. Their snapshots contain only the selected thread's
counts and list; `summaryCursor: ""` directs callers to the full summary read.
The combined snapshot uses the bounded short thread selection.
Aggregate history authorizes at most 50 candidate messages per request, change
feeds 200, and shared history 32. These reads never enumerate all threads.
Follow history `from`/`to`, change-feed `rev`/`more`, and shared `nextCursor`
even when the returned items are empty: they advance past hidden candidates.

`POST /conversations/read-all` inspects at most 50 candidate conversations and
100 item threads across them. A completed page returns `marked`, `more`, and,
for system conversations, `nextCursor`. Repeat with `{ "confirmed": true,
"cursor": "<nextCursor>" }` while `more` is true, including when `marked` is
zero. The cursor may continue within the same conversation. An incomplete
unconfirmed preview returns `outcome: "confirm"` without changing read state.
An ordinary-chat page without a cursor retains its existing repeat behavior.

For `POST /conversations/:conversation/read` with `thread: "all"`, repeat the
same sequence with the returned non-null `summaryCursor` to advance remaining
item pages. General and selected-thread read receipts describe their selection;
read the conversation summary separately for aggregate counts. System receipts
are applied from authorized HTTP responses because they have no personal live
event. The client follows All-thread read cursors sequentially at the same
sequence and selection, rejects repeated cursors, and cancels pending work
when the selection closes. Failed writes retain the existing read error and
retry path.

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
cached authorization for both the container and item. Creating an item thread
also emits the existing `{ "type": "threads", "conversationId": "…" }` refresh
hint on the container's conversation and list keys. It carries no item ID,
title, resource ref, or message. Existing conversation viewers use it to refresh
the thread list over authorized HTTP, even with no cached item decision. A
viewer denied by the item reader receives no item metadata or message payload.
New subscriptions discover the keys authorized by that HTTP refresh. The platform's live
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

Thread discovery hints invalidate both the sidebar and the open directory.
Both sidebar discovery and the open conversation perform an authorized short
thread read before renewing their existing live subscription. Summary reads
alone cannot warm new item decisions beyond their ID-ordered candidate page.
Renewal starts at the earliest relevant hint in the received batch. Events
committed during discovery replay after renewal, even if a later known-key
event in that batch has already advanced the live watermark.

“Jump to latest” preserves authorized live arrivals newer than its snapshot.
Access reconciliation instead replaces the authorized window and supersedes
pending reads, so a delayed response cannot restore removed content.

All-day event metadata uses the request time zone. Event ends are exclusive;
the displayed range ends on the last included calendar day. A single-day
event shows one date. Date-only task deadlines keep their calendar date.
Automatic read failures appear with a retry in the existing composer hint or
read-only status line, keeping the message viewport's layout stable.

## Personal lists alongside system chats

Personal pins, archive, All/Unread filters, and saved collapsed sections apply
to ordinary chats and subscribed channels. `SidebarPreferencesSchema.collapsed`
accepts `pinned`, `chats`, and `channels`. System chats stay in the separate
Spaces and Notebooks section; personal mutation requests for them return 403.
The ordinary conversation list excludes system chats in every list mode.

Unread filtering uses each thread's read state before pagination. The workspace
tracks unread-gap recovery per selected thread, including All threads in
ordinary and system chats. Recovery in `/app/chat/panel` preserves that route
base and the current list and thread selection. System-chat addresses use
`listFilter=all|unread` for the personal list; `filter=open|done|unread` remains
the independent system-thread directory filter.
All is the default personal list mode and is omitted from generated system-chat URLs.
