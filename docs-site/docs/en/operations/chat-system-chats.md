---
title: Chat system conversations
navTitle: Chat system chats
section: Operations
tags: [chat, permissions, operations]
order: 1600
description: Access, dependencies, and API behavior for Chat conversations attached to resource providers.
updated: 2026-10-30
---

# Chat system conversations

Chat attaches a conversation to a resource container and a thread to an item.
Applications opt in through their catalog's `discussions` role. Built-in and
third-party providers use the same contract. Chat lists these conversations
under **Discussions**. Item directories and message links work in the full
page and below `/app/chat/panel`. Providers can also offer an activity feed.
Existing comments stay in their owning application.

The [item discussion capabilities](/en/docs/platform/chat-discussions) expose
only provider-backed item threads. Keep the item and container types' declared
readers available under the incoming authority alongside the Chat operation;
missing current owner context fails closed. Chat stores the calling surface on capability posts
and edits; direct edits retain an existing mark. The additive nullable message
column does not backfill old messages. Comments and the `unreleased` Compose
profile remain until their separately coordinated release.

## Open a conversation

All paths below start with `/api/chat`.

| Request | Result |
| --- | --- |
| `GET /system-chats` | A fair page from the catalog's discussion providers, including containers with no conversation yet. |
| `POST /system-chats/:resourceType/:resourceId/open` | Create or return the container's conversation. The type must be a container declared by a discussion provider. |
| `POST /conversations/:conversation/threads/for-resource` with `{ "ref": { "type": "inventory.item", "id": "…" } }` | Create or return an item thread. The type must be the provider's discussion item type. IDs are opaque strings up to 512 characters. |
| `GET /conversations/:conversation/threads` | Authorized threads, with optional `filter=open\|done\|unread`, `q`, and `cursor`. |

Message uploads and downloads use the same routes and limits as ordinary chats:
see [Chat message attachments](/en/docs/operations/build-and-deploy#chat-message-attachments-after-the-upgrade).
An upload's optional `thread` is checked with the item reader. A sent
attachment's download and shared-list entry require the current container and
item visibility of its message.

System conversations have `kind: "system"` and a container `resource` ref.
Their message views include the same viewer-specific `reactions` as ordinary
chat messages. Reaction live events carry a refresh hint on the item thread
key; clients read the current reactions over HTTP.
Item threads carry `resource: { ref, title, context?, status?, done?, permission,
container?, href?, typeTitle, icon, color? }`. The reader's standard `view`
supplies the title, localized context and status, completion flag, permission,
and container `{ ref, title }`. The catalog supplies the type title, icon and
optional color. Icons must match `^ti ti-[a-z0-9-]+$` (at most 80 characters);
invalid manifest icons use the default discussion icon. The reader’s optional
`open` link supplies `href`; without it the header hides its open controls.
Chat does not interpret domain fields or resolve status labels.

Chat no longer exposes separate assignees, deadlines, or exact event start and
end times. A provider can include those details in its localized context line.
Chat displays no numeric container membership count because the standard view
does not supply one.

`GET /system-chats` accepts `cursors`, a JSON object keyed by container type.
Responses contain `{ items, cursors, skipped }`. Items include `ref`, `name`,
`typeTitle`, `icon`, optional `color`, and nullable `conversation`. Send the
returned cursors unchanged for the next page. An empty cursor means that
provider is exhausted; position objects also preserve work for skipped providers.
`skipped` identifies providers with unavailable lists, container readers or item summaries.
Each unfinished position is an object with an optional provider `cursor` (at
most 2,048 characters) and an optional container-page `offset` (0–100). For
example, `{ "inventory.collection": { "cursor": "next-page" } }` resumes a
provider; `{ "inventory.collection": "" }` marks it exhausted. The query is
decoded once, without nested JSON cursor strings. The map accepts at most
1,500 keys (60 catalog pages of 25 providers); the serialized query is bounded
by those limits and resource type lengths.
Unvisited providers lead the next round, so a large or unavailable provider cannot starve others. Refresh to
restart discovery after the directory changes.

Discovery, lists, readers and summaries share a maximum of 60 capability calls,
4 MiB of returned envelopes, six parallel readers and a ten-second deadline.
Each round divides available calls among the remaining providers and reserves
reader and summary work. Providers left unvisited lead the next round. Summary counts can be partial; follow `summaryCursor` to continue them.

Opening requires container read access. Creating an item thread and sending
messages require container write access. The item reader must also authorize
the caller, and its parent must match the conversation. Retrying either open
operation returns the same object. Creating an item thread emits no
`thread_created` message. Omit `thread` or pass `null` when sending to General.

System chats reject manual thread creation, renaming, archiving, chat metadata
edits, and membership changes. Change container permissions in its owning app.
Chat does not enumerate that app's members or copy their grants.

Unread messages begin at each participant's first open, or immediately before
their first incoming mention or reply. Reopening preserves that position. Earlier
messages cannot be marked unread. Mentions and replies appear in the same
**For you** feed
as ordinary chats, subject to current container and item access.

Mention targets use principal UUIDs and need only be active eligible people or
service accounts. They need no Chat grant or previous resource read. Candidates
are previous conversation authors, excluding the caller. Mentioning someone
does not grant access: the feed, count, message reads, and content-bearing live
events still use that reader's own container and item authority. The personal
`for-you` live hint carries no content or resource identity.

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
| Named thread or item thread | `{ kind: "thread", conversation: { id, title, kind }, thread: { id, name, resource? } }`. The optional item resource contains `{ icon, done? }`. |
| Discussion container | `{ kind: "system", ref, name, icon, conversation }`. The container ref is declared by its provider; `conversation` is `null` until its chat exists. |

Ordinary results include only chats where the caller is a member, including
subscribed channels. Discovery access alone does not add a result. Search
covers ordinary titles and named threads before applying the result limit.
It uses PostgreSQL and the existing membership indexes, with at most four
member names used to derive each unnamed chat's title.

Container discovery sends `query: q` and `limit: 8` to the provider's
container query. A second page of up to eight containers, without the text
filter, scopes item discovery. Item discovery inspects up to 60 recently
active item threads in those caller-listed containers. Their stored names are
snapshots: matching uses each reader's current name. Container and item readers
must both allow the caller, and the item's current container must still match
the conversation. The 60-second decision cache applies. Search shares the
same 60-call, 4-MiB and ten-second request budget. Budget exhaustion keeps
available results and sets `systemUnavailable: true`.
These candidate bounds mean an older item thread or a container beyond its owner's first matching page can be absent from search.

When item threads remain, system-chat summaries include `summaryCursor: ""`:
search spends its item-reader budget on matching and leaves summary continuation
to the existing conversation route. Empty thread directories are complete and
return `summaryCursor: null`. Container activity uses General messages and
readable item candidates. Open a container with no conversation through the
existing `POST /system-chats/:resourceType/:resourceId/open` route.

If a provider fails, search retains ordinary hits and successful results
from other providers, and sets `systemUnavailable: true`. Show the partial
failure separately and retry the same query. An explicit denial omits the
resource. An empty successful response is `{ "items": [] }`.
The standard Chat list request limiter applies (HTTP 429); disconnects cancel
search queries and further reader work.

A search that reaches the shared transport budget returns `incomplete: true`
with its authorized results and a Retry notice. `systemUnavailable` identifies
an actual provider failure; a cold cache reaching its budget is not an outage.

The browser client in `frontend/search-api.ts` exports `createSearchApi()`
with `search(q, signal?)` and the `SearchHit`, `SearchResult`, and `SearchApi`
types. It validates both the query and response and preserves server error
messages and codes.

## Read item events

`GET /conversations/:conversation/events` reads a system conversation's item
changes with the current caller. Ordinary conversations return 404. Pass
`thread=all` (the default) for the container or a thread ID for that item.
The response is `{ items, nextCursor, unavailable? }`. Each row has `id`, `at`
(the bucket's last occurrence), `icon`, a final localized `sentence`, `count`,
and `thread`, plus an optional `href` supplied by the owning app. `href` is a
same-origin path beginning with a single `/`, at most 2,048 characters, with
no backslashes or control characters. Absolute and protocol-relative URLs are
rejected. An existing thread is `{ id, name }` with its current title;
otherwise `{ ref }` can be passed to `threads/for-resource`.

Rows are newest first. A page can be shorter to fit the capability response
budget; follow its cursor even when fewer rows than requested arrive. Actor
labels are limited to 1,000 characters. `limit` defaults to 50 and accepts
1–100. Use exclusive ISO datetime bounds `after` and `before` to match a message window. Follow a
non-null `nextCursor` by passing `cursor` with the same selection and bounds,
including when the page is empty. IDs identify owner activity buckets;
`count` reports the number of occurrences already recorded in that bucket.
Clients should replace an existing row with the same ID when refreshing it.

Events come from the provider's optional activity query. They never advance
unread state, become a conversation preview, trigger a notification, or enter
Chat's live payloads. The provider formats sentences in the caller's locale.
Chat sends the request time zone, container ID and optional item ID through
the standard activity input. It checks each item's current reader before
returning an event. An owner outage or malformed activity response returns
HTTP 200 with `{ items: [], nextCursor, unavailable: true }`; retry the same
request to recover. Item reader failures preserve the incoming cursor. Denied conversation, thread, or activity access returns 404.
Providers without activity return an empty complete page.

## Follow pages

Container pages use the `cursors` map described above. A catalog failure
returns `PROVIDER_UNAVAILABLE` (HTTP 500). A list failure or an exhausted budget preserves that provider's position and
adds its type to `skipped`, while other providers can still contribute results.
An incomplete summary is marked on its conversation; a broken item reader
never rewinds the provider directory.
An individual container with a failed or malformed reader is omitted and its
type is reported in `skipped`; the directory continues past it so one broken
resource cannot block later containers. Refresh discovery to retry omitted
containers. Retry unfinished provider pages with the returned map.

A system thread page inspects at most 60 candidates by latest activity,
with the thread ID breaking ties.
Visibility, search, and state filters apply within that page. Follow a non-null
`nextCursor` even when `items` is empty. Ordinary chats retain their existing
activity and archive ordering. `short=true` selects the four recent candidate
threads, unread candidates, and optional `selected` thread within the candidate page. The selected thread and recent candidates take priority.
Candidate selection precedes item authorization and unread-state calculation;
short refreshes never calculate unread state across the whole directory.
A partial short selection returns `nextCursor: ""`; open the directory to
continue from its first page.
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

Only actual remote calls and returned envelopes consume the shared request
budget; cache hits are free. Candidate traversal has its own bound: a summary
inspects at most 60 candidates, including hidden ones. Budget exhaustion
returns a partial page and keeps continuation before the first uninspected
candidate, even when nothing is returned. It does not fail the snapshot or SSR.
Thread directories, conversation summaries, message pages, change feeds, shared
lists and **For you** pages
carry `incomplete: true` when a reader is unavailable or the request budget
stops work. An unavailable item is hidden while readable siblings remain
available. The directory and conversation show a notice with Retry; retry the
read to check omitted items again. Cancellation and the shared deadline stop
outstanding reads.

General and an individually selected thread authorize only the container and,
for the latter, that item. Their snapshots contain only the selected thread's
counts and list; `summaryCursor: ""` directs callers to the full summary read.
The combined snapshot uses the bounded short thread selection.
Aggregate history authorizes at most 50 candidate messages per request, change
feeds 200, and shared history 32. These reads never enumerate all threads.
Follow history `from`/`to`, change-feed `rev`/`more`, and shared `nextCursor`
even when the returned items are empty: they advance past hidden candidates.
When the shared or **For you** page reaches its transport budget, `incomplete`
is true and `nextCursor` preserves the incoming cursor (or `""` for the first
page). Retry that page; the interface keeps readable rows and offers Retry
instead of continuing past unchecked items.

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
invocation; Chat sends credentials only to Core. The standard view supplies
`read`, `write`, or `admin` permission.
Service accounts and agents retain their existing scope and resource caps.

Valkey stores decisions for 60 seconds, separately for each principal,
credential scope, resource, and display locale. Live authorization uses a
separate locale-independent permission projection for each resource. A revoked permission can remain usable during
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

Automatic read failures appear with a retry in the existing composer hint or
read-only status line, keeping the message viewport's layout stable.

## Personal lists alongside system chats

Personal pins, archive, All/Unread filters, and saved collapsed sections apply
to ordinary chats and subscribed channels. `SidebarPreferencesSchema.collapsed`
accepts `pinned`, `chats`, and `channels`. System chats stay in the separate
Discussions section; personal mutation requests for them return 403.
The ordinary conversation list excludes system chats in every list mode.

Unread filtering uses each thread's read state before pagination. The workspace
tracks unread-gap recovery per selected thread, including All threads in
ordinary and system chats. Recovery in `/app/chat/panel` preserves that route
base and the current list and thread selection. System-chat addresses use
`listFilter=all|unread` for the personal list; `filter=open|done|unread` remains
the independent system-thread directory filter.
All is the default personal list mode and is omitted from generated system-chat URLs.

## Notification choices and followed discussions

Conversation responses (detail, lists and snapshots) include `notifications`
and `mentionsUnread`. `notifications` is `null` without a participant row,
including discovery results before participation. With a row it contains:

```json
{
  "level": "mentions",
  "choice": null,
  "until": null,
  "defaultLevel": "mentions",
  "following": { "count": 0, "first": null }
}
```

`level` is the effective `all`, `mentions` or `none` level. `choice: null`
means the default. System chats default to `mentions`. In discoverable
channels, participants with only read permission default to `all`. Other
chats default to `all` through 20 members and `mentions` from 21. An explicit
choice survives changes to membership and permissions. `following` is `null`
for ordinary chats.

`mentionsUnread` counts unread mentions and replies to the participant in
this conversation, including when muted. A message that both mentions and
replies counts once. It uses the same recipient sources, read boundaries,
access checks and cap of 99 as **For you**. Counts scan at most five pages of
100 candidates; inaccessible candidates can make the displayed count lower.

All paths below start with `/api/chat` and require current read access and a
participant row. Unreadable resources return 404; a readable chat without
participation returns 403. Mutations also require write credential scope.
Service accounts can store these preferences like users.

| Request | Input or result |
| --- | --- |
| `GET /conversations/:conversation/notifications` | The `notifications` object. |
| `PUT /conversations/:conversation/notifications` | `{ "level": "default" }`, `{ "level": "all" }`, `{ "level": "mentions" }`, or `{ "level": "none", "for": "1h" }`; returns the new object. |
| `PUT /conversations/:conversation/threads/:thread/follow` | Follow an item discussion; returns `{ "following": true }`. |
| `DELETE /conversations/:conversation/threads/:thread/follow` | Unfollow it; returns `{ "following": false }`. |

Only `none` accepts `for`: `1h`, `8h`, `1w`, or `forever`. The server computes
expiry; callers cannot supply `until`. Once expired, a mute reads as the
current default with `choice: null` and `until: null`. The next preference
write replaces the stored choice and clears or replaces its expiry. No
scheduled cleanup is needed.

Only item threads in system chats support following. Posting a new message
in one follows it in the same transaction; retrying an existing message,
reacting, or editing does not. Thread projections include `following` for
item threads. Follow and unfollow are idempotent. Removing a participant or
deleting a thread removes its follows. System chats have no leave route;
access and participant cleanup remain owned by the existing resource lifecycle.

The conversation's `following` summary counts its stored follows and returns
the most recently followed thread as `first: { id, name }`. If that thread is
no longer readable, `first` is `null`; its name and ID are not disclosed.

Preference and follow changes enqueue a content-free `{ "type": "notifications" }`
hint on the subject's personal live channel, in the same transaction. Other
tabs refetch their authorized conversation and thread state. No item title or
conversation ID travels on this hint.

The Chat CLI module exposes:

```sh
cld chat notify <chat>
cld chat notify <chat> all|mentions|default
cld chat notify <chat> off [--for 1h|8h|1w]
cld chat follow <chat> <thread>
cld chat unfollow <chat> <thread>
```

Omitting `--for` keeps a mute until changed. All commands support `--json` and
`--jsonl`. Capabilities `chat.notifications.read`, `chat.notifications.set`
and `chat.thread.follow` use these same services. The read Query accepts
`{ conversation }`; the set Action accepts `{ conversation, notifications }`
with the PUT body above; the follow Action accepts `{ conversation, thread,
following }`. Results contain the same notification object or `{ following }`
in the capability data envelope.

Resource checks inside these capabilities use the parent invocation's query
authority and bypass the HTTP decision cache. They do not forward the person's
cookie or token.

Followed item discussions, mentions, and replies can send push notifications
when the provider's reader check allows the recipient. Chat checks the item
against this conversation's expected container, using its automatic workload
credential through Core. Failed checks omit counts and retry delivery; missing
setup suppresses push and appears in Chat administration. See
[Chat notifications](/en/docs/operations/chat-notifications#enable-resource-discussion-notifications-after-the-upgrade)
for rollout, timing, count budgets and troubleshooting.

## Edit or delete a message

`PATCH /conversations/:conversation/messages/:message` accepts `clientId`,
`revision` (the current message `contentRevision`, initially zero), and `body`. `DELETE` on that path accepts
`clientId` and `revision`. Both require the author's current Write or Manage
access and a write-capable credential, within ten minutes of sending. Archived
threads cannot be changed. They apply to ordinary chats and item threads.

Use a fresh `clientId` per edit or deletion and retain it with the same input
when retrying a lost response. Receipts remain replayable for 24 hours, then bounded maintenance batches remove them. Reactions never change the content revision. A stale revision returns `MESSAGE_CHANGED`;
an expired window returns `MESSAGE_MUTATION_EXPIRED`. Both are HTTP 409.
Successful message views include `editedAt` and `deletedAt`. Deletion clears
text and attachments while preserving the message's position and a deleted-message marker
for replies. The revision stream and live invalidation refresh other tabs
without counting the edit as a new message.

## Item reader container context

The provider's standard `view.container` supplies the container's `ref` and
`title`. Chat reads container and item permissions separately. A consuming
capability uses a fresh nested reader under the incoming authority; display
metadata never grants access to other items or replaces credential scope and
resource binding checks.
