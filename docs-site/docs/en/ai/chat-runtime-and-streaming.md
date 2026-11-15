---
title: Chat runtime and streaming
navTitle: Chat and streaming
section: AI
order: 1030
description: Create personal conversations, save composer drafts, and stream agent work.
tags: [ai, chat, streaming]
updated: 2026-11-17
---

# Chat runtime and streaming

Core mounts one authenticated conversation API at `/api/ai`. Conversations do
not belong to an application and have no primary resource. Assistant renders
the standard GUI; another application may create a conversation and redirect
the user there.

Interactive submissions and retries enforce the caller's
[Assistant model access](/en/docs/ai/models-and-providers#add-models-and-variants).
The model list and status return only permitted models. A denied explicit model
selection returns HTTP 403 before a retry changes the conversation.

[Scheduled chat messages](/en/docs/ai/chat-alarms) use this same queue and send
receipt contract for one-off and recurring Gustav alarms.

## Queue follow-up messages

Add a client-generated UUID `queueId` to `POST /api/ai/conversations/:id/turns`
together with the saved `draftRevision` to queue a follow-up. Acceptance consumes
that draft revision and preserves its text, resource references, model selection,
and exact attachment bytes. Repeating the same `queueId` is idempotent, including
after the message has started. A later composer draft remains independent.

Each conversation accepts up to 20 pending or failed person messages. Queued attachment
snapshots share a 250 MiB budget. The existing turn worker processes messages in
acceptance order, one active turn per conversation. Queues survive navigation,
reloads and worker restarts. Completion, failure or cancellation of a turn allows
the next queued message to start. A final refusal keeps a person's failed entry at
the head until the person retries or removes it. A final automation refusal releases
its place immediately. Transient infrastructure errors remain pending as described
below. Approval waits keep the current turn active and do not advance the queue.

`AUTOMATION_QUEUE_LIMIT = 32` bounds pending automation entries separately from
the person's composer capacity. `AUTOMATION_QUEUE_SOURCE_LIMIT = 1` prevents a
Code or source chat from filling the queue while its previous message waits.
Both constants are exported from `@k2b/cloud/ai/runtime`. The capacity check and
FIFO ordering share the conversation lock. Automation sends return `chat_busy`
when either automation limit is reached.

`enqueueAutomationChatMessage` is the trusted host's draft-free insertion path;
composer submission continues through `enqueueChatMessage`. On dequeue, Cloud
reads the current payload and revision under the conversation lock.
`submitChatTurn` consumes that stored payload and rejects a mismatched
`queuedMessageRevision`. Core registers `validateQueuedChatStart` on the first
`startAiRuntime` call. Its `expiredReason` hook supplies a scalar SQL expression
wrapped in `{ expression }` (SQL queries are thenable). One bounded statement
marks pending expired or invalid Code entries `failed` independently of FIFO and deletes their
input, context and attachments. Pending Code entries expire at their accepted budget day's end;
retry never revives them. A final refusal keeps its status and reason through later day changes
and archiving. Before promotion it checks current ownership, source
authority, enabled Code, model access and allowances. Automation work fails
closed when that host policy is absent: entries remain pending until the host
registers its policy, including across runtime shutdown. The validator uses the
supplied database executor for account, Project, settings, model-access and
quota reads. It checks Project access without loading Project content. One
model-catalog snapshot serves both the validator and quota check. These services
accept optional transaction executors so a dequeue
never needs another pool connection while holding its chat lock. Settings
reads with an executor bypass the cache and read the stored value and defaults. Composer
entries instead prefetch cached settings and a catalog snapshot before taking the chat lock.
Code starts lock chat, owner and Code in that order, taking the Code row with `NOWAIT` to avoid
waiting for a reviewer that holds Code before chat.

Only typed quota, settings and source-policy refusals are final. Unknown start errors keep the
entry pending with visible `dispatch_failed` and log each failed attempt's reason and error class.
`quota_checked_at` also schedules these retries at least 15 seconds apart; it never proves that
quota admission succeeded. They end at the existing 30-minute queued-turn start deadline,
measured from acceptance, or earlier at a Code's budget-day end. The person can remove the entry;
a final person failure keeps FIFO until the person retries or removes it.

`ai.chat.send` stores an immutable admission in `ai.chat_send_receipts`: account,
operation, key hash, input hash, original destination, origin, initiator and
queue ID. Turn state is read from the associated turns; retries retain the send
ID. Queue payload cleanup and conversation deletion do not remove the receipt.
Receipts are durable evidence and status references, retained for the account's lifetime;
24-hour idempotency does not expire that evidence. Account deletion removes its receipts.
Replay reads it before resolving today's destination or checking allowances,
so it never redirects an accepted message. The caller's current authority is
checked first: paused Code or an ended run gets no receipt back. Read current state with
`ai.chat.read({ id: originalChatId, message: sendId })`.

A person's **Stop** holds the foreground queue, even if the response just
finished. Every entry, including those of automations, stays queued. Send now
starts only its own entry; a later Stop withdraws that request and leaves the
entry waiting. A new message from the person resumes the queue in its order;
a message from an automation or another chat does not. Stop does not change
a Code schedule.

A direct submission cannot overtake waiting entries: it returns HTTP 409 with
`code: "queue_waiting"` and leaves the draft intact. The web chat and PWA then
queue the person's message at the end, which lifts the hold. A person's client
can submit the saved draft with a new `queueId` to do the same. The CLI explains
how to send the saved draft in Assistant or use Send now on a waiting entry.
Without waiting entries, the person's direct submission lifts the hold; a
service account or automation receives HTTP 409 with `code: "queue_held"`
while it is held. Retrying a message cancels an approval wait without setting
a new hold; a retry with waiting entries returns `queue_waiting`. A service
account stopping a turn does not hold the queue. If the chat is archived before
a direct submission or retry commits, it returns HTTP 409. Messages
from other chats wait as they do for a busy chat. The server owns the hold;
archiving clears it, so restoring the chat does not restore an old Stop.

With **Automations as Code**, automation messages will use a separate queue:
up to **32 entries per chat**, with at most **one waiting entry per source**
(Code or source chat). These entries will have their own capacity, preserving
the person's 20 places. The automation queue will arrive with Automations as
Code; the personal queue described here is available independently.

The owner-authorized queue API provides:

- `GET /conversations/:id/queue`: ordered pending and failed entries, including
  `id`, `text`, `content`, `origin`, `state`, `createdAt`, and `authorIsViewer`,
  plus `error` (a stable code such as `dispatch_failed`, or `null`) and
  `retrying` (`true` while Cloud starts the entry again by itself; `state` then
  reads `failed`). `AiQueuedMessageSchema` parses all of these fields.
  The display states are `pending`, `sending`, and `failed`; storage keeps its
  existing `pending`, `failed`, `submitted`, and `cancelled` statuses.
- `PATCH /conversations/:id/queue/:messageId` with `{ text }`: edit the person's
  own queued text while retaining attachments and resource references. Automation
  and other-chat entries cannot be edited.
- `DELETE /conversations/:id/queue/:messageId`: remove an entry that has not started.
- `POST /conversations/:id/queue/:messageId/retry`: retry a failed dispatch.

All paths above use the `/api/ai` prefix. Editing or deleting races safely with
promotion: once an entry becomes a turn, the queue endpoint returns not found.
Normal submissions cannot overtake the queue. Chats with pending entries cannot
be marked done and do not become done through inactivity. Archiving such a chat
lets its entries lapse (`cancelled` with error `chat_archived`). A turn that
runs or waits for a decision still keeps a chat from being archived; the
conflict says which of the two it is.

The archive dialog warns that waiting messages will be discarded. It names the
count when known; otherwise it uses a general warning. The Cloud app archives
chats with an empty queue directly and offers Undo. Waiting entries require
confirmation; if the queue cannot be read, confirmation uses the general
warning.
Restoring the chat does not recover discarded messages or their queued
attachments.

`POST /api/ai/conversations/:id/archive` keeps its success response shape and
adds the number of pending and failed entries discarded by this operation:
`{ "ok": true, "discardedQueuedMessages": 2 }`. The count is zero when none were
discarded. Already submitted or cancelled entries do not count. The Assistant
CLI (`cld assistant chats archive <chat-id> --yes`) prints the count as a sentence
when it is above zero; JSON and JSONL include the same response field.

### Send a queued message now

`POST /conversations/:id/queue/:messageId/send-now` prioritizes that entry and
interrupts the current turn. An already-started tool finishes and saves its
result; the runtime starts no later tool. The interrupted turn stays in history
with `meta.queueInterrupted: true` and an `aborted` status. The chat displays
“Stopped” without a resume action. Other queue entries retain their order.

A step skipped by this interruption records `QUEUE_INTERRUPTED`, with `not_run`
for a tool that never started and `not_returned` for a tool interrupted at a
nested approval or client wait. It is not recorded as a person's refusal. The
chat shows the step as stopped; the next turn treats earlier effects of a
partially executed tool as uncertain and checks them before retrying.

The response is `{ id, state, turnId }`, where `state` is `sending`, `submitted`,
or `failed`. A `failed` receipt also carries `error`: the cause, such as
`interruption_unconfirmed` or `cancelled`, or `null` when Send now was never
requested for that entry. The entry ID is the idempotency key. After a lost response, read
`GET /conversations/:id/queue/:messageId/send-now` before replaying that same
POST. A submitted receipt survives promotion; an absent list entry alone does
not prove failure. Never allocate another ID to retry an uncertain send.

A pending client tool uses its existing result deadline. The entry stays
`sending` until the client result is saved. If the deadline expires or the
result reports an uncertain outcome, the entry becomes `failed` (“Not sent”);
Cloud releases the interruption request and leaves the original turn to its
normal result and timeout handling. A live worker also releases its received
interrupt when the request is withdrawn. Delivery alone never authorizes an
irreversible stop: the worker confirms timely, known receipts before stopping,
and the original run deadline and lease ownership still apply. It does not
terminate the client effect.
The same “Not sent” state applies if a lost server worker has no durable
outcome for a started effect. The runtime never treats a lost lease alone as
confirmation of a successful interruption. All queue mutations remain locked
while a send-now request is in progress. Stop still works during that time: it
ends the turn through the normal stop path without waiting for the client
result, and the prioritized entry is sent next.

The next turn receives the interrupted history, a system instruction with the
last finished step and the interrupted step's outcome, the current `todo_write`
state, and the prioritized message's provenance. It handles that message first,
then explains in one sentence whether it will continue, change, or abandon the
old work. It must check an uncertain effect before repeating it.

### Preserve writer identity and live state

Queue entries and history messages carry server-authored provenance.
A message an automation or another chat sent with `context` stores the
instruction and the data in one text part for the model. Reads show them apart:
the message's `text` is the instruction, and history messages carry the data
as `meta.sourceContext`. A queue entry's `text` is its instruction alone.
`origin.kind` is `person`, `automation`, `chat`, or `wakeup`, with a stable ID and a
resolved display name. Personal Code stores its automation origin with
`resource: { type: "core.code", id }`; Code's own reader then names and links it
for each viewer who may read it. Without a readable name the projection says
`named: false` and `name` is only “Automation”, so surfaces read “From an
automation” instead of naming it. Chat and automation links appear only when the viewer
can open the target. Durable provenance stores IDs, never translated names or
display links. The existing inter-chat delivery path also records its source
chat. Its delivery lifecycle is unchanged.

The admission limit is defined by `AI_MESSAGE_QUEUE_LIMIT` for the existing
personal composer queue. Platform adapters supply provenance through the
existing server-owned turn configuration;
request JSON cannot set it. A personal-chat writer must have the owner's
user access subject; a service-account subject is refused.

Queue changes use the existing `/api/ai/live` invalidations for
`conversation-detail` and `conversation-list`. Clients reload the authorized
snapshot after an invalidation and never poll. Token delivery and worker
interruption signals execute no SQL; the integration budget is pinned with
`scripts/fixtures/sql-meter.ts`. The shared browser exports are
`AI_MESSAGE_QUEUE_LIMIT`, `AiMessageOriginSchema`, `AiQueuedMessageSchema`,
`AiMessageOrigin`, `AiQueuedMessage`, `AiSendQueuedMessageResult`, and
`AiQueueLiveEvent`.

Text from a source without a signed-in session restricts the turn it enters:
a queued message, a queue edit, a steer or a tool result sent with `cld`, an API
key or another delegated credential. The text is still accepted and the turn
keeps running, but it loses rights that need a person's session, such as
writing to another chat with `ai.chat.send`. An approval without text does not
restrict the turn.

## List place chats

A place chat belongs to the person who sent its first message. Opening a place
never creates a chat. There is one active chat per person and place; starting
over archives it, and the next message creates its replacement.

`GET /api/ai/conversations` and `/api/ai/conversations/page` accept `place`:

| Value | Chats returned |
| --- | --- |
| `none` (default) | Chats without a place. |
| `any` | Chats bound to a place. |
| `<type>:<id>` | Chats bound to that exact resource reference. |

The filter combines with the existing search, status, archive, and Project
filters. Both endpoints return `place: { ref: { type, id }, title }` for place
chats and `place: null` for ordinary chats. The title is the stored snapshot;
listing a chat does not call the place provider. The place is also indexed as
a conversation resource, so the existing exact `refs` filter can find it.

`GET /api/ai/conversations/counts` returns `{ unread, needsAttention, places:
{ total, unread, needsAttention } }` for the current person's non-archived chats.
The first two counts include place chats; `places` gives their separate counts.
Search presents place chats in **At places** (**An Orten** in German).
The `ai.chats.search` and `ai.chats.resources` tools exclude place chats unless
their `place` input gives an exact resource reference. Cross-chat resource
listing at `GET /api/ai/resources` also excludes place chats; resources in a
known chat remain available through its own resource endpoint.

Use `cld assistant chats list --place any` or `--place example.conversation:Marta1`
to list place chats. The default excludes them; table output has a `place` column.

## Observe work across conversations

Sidebar snapshots include a compact `activity` projection: completed and total
task counts, the current task, and the last tool label. Cancelled tasks do not
count toward progress. Tool arguments, outputs and conversation history are not
included in this projection. The same owner checks apply to initial and live
reads, and live updates do not change activity-based ordering.

AI live updates invalidate this snapshot on task and tool changes. Text tokens
alone do not invalidate the sidebar. A reconnect replays the missed updates, and
the browser reloads authorized state before it moves its cursor; no
per-conversation socket is required.

## Diagnose runtime failures

Use the existing Core log and trace views. Filter logs by `ai:runtime`,
`ai:message-queue`, `ai:executor`, `ai:files`, or `ai:transcription`. AI live
updates log under `events:live` with the application ID `core`.
Queue start failures carry `conversationId`, `messageId`, the stable refusal `code`
(or `dispatch_failed`), and `errorType`. Each failed attempt is logged, including
the transition to the retry deadline. Heartbeat, recovery and completion-publication warnings
carry conversation and turn IDs. A heartbeat warning is emitted once per failure
streak; recovery uses the existing durable turn state.

Upload storage failures emit `file_upload_failed` with the conversation ID and
error type. A failed tool-start or dispatch audit prevents the effect from
starting; other tool-audit write failures are warnings with turn and call IDs. Expected audio
cancellation is informational; retryable dictation failures are warnings and
terminal failures are errors. Provider/transcription traces retain their existing
status, duration and accounting. Diagnostic metadata does not add prompt,
attachment or audio contents.

Gateway registry notifications are supplemented by reconciliation every five
seconds. This repairs stale routing after a missed application restart event.
A failed refresh retains the last usable route table and logs its failure.

## Create a conversation draft

```ts
import { launchAssistant } from "@k2b/cloud/ai/browser";

const launch = await launchAssistant({
  launchedByAppId: "mail",
  draft: {
    content: [
      { type: "text", text: "Help me finish this email." },
      { type: "resource", ref: { type: "mail.draft", id: draftId } },
    ],
  },
  preloadTools: [
    { name: "text_editor" },
    { appId: "mail", kind: "query", id: "draft.read" },
    { appId: "mail", kind: "action", id: "draft.update" },
  ],
  files: selectedFiles,
});
window.location.assign(launch.href);
```

The request may preload at most eight tools. A `{ name }` entry selects a Cloud
built-in; an `{ appId, kind, id }` entry selects a live app Query or Action.
Core validates both and stores their exact resolved names so the first turn can
use them without discovery. Preloading is a prompt-budget optimization, not
authorization. Every app invocation still runs as the current user against the
owning application.

Set `launchedByAppId` to the launching application's stable id when another
application explicitly opens Assistant. Core stores that attribution on the
new conversation for AI usage accounting. Omit it for chats created directly
inside Assistant.

Conversation creation accepts an optional UUID `requestId`. Keep it and the
same creation input until `POST /api/ai/conversations` returns the conversation.
Concurrent requests or retries after a lost response return that same conversation
for the authenticated owner. Changed input returns a conflict. A deleted or
archived conversation is unavailable; the request never creates a replacement.
Project access is checked again on replay. Use a new UUID only for a new,
deliberate creation. Without `requestId`, each request creates a conversation.

The structured composer draft contains text, exact stored-file versions,
zero or more Cloud resource refs, and up to ten quotes. Save it with `PUT
/api/ai/conversations/:id/draft` and an `expectedRevision`. Identical autosaves
are idempotent; stale writes return a conflict. In the browser controller, a
failed `saveDraft`, `send`, or `queueMessage` answers `null` or `false`.
`draftSaveFailure(conversationId)` then says whether its draft save failed:
`"conflict"` when the saved draft has another revision, which sets no chat
error so the app shows its own choice; `"failed"` for any other failure, which
sets the chat error; or `null` when the draft was saved. Only a conflict means
that the saved draft changed. Submit a turn with the returned
`draftRevision`. Local clients may also send `client` (kind `cli` or `acp`,
optional name, workspace `cwd`, OS, shell and local tools mode) and
`localContext` (AGENTS.md instructions, local Skill catalog and explicitly
selected local Skills). `localContext` without `client` returns HTTP 400.
Both are stored in `run_config`, alongside `clientToolIds`, and preserved by
queued messages. A message retry uses only the `client`, `localContext` and
`clientToolIds` its request carries, so a retry from the web gets no local
client context or local tools; it keeps the original non-local `clientToolIds`
when the request sends none, and the original selected local Skills when a
local client retries. Background and mandate runs do not
receive local client context. The transaction consumes and clears exactly that revision, so
text and attachments cannot drift between save and send.

A quote is `{ type: "quote", messageId, text }`: a passage of an earlier message
in the same conversation, named by that message's public id. `text` holds at
most 2,000 characters, and quotes count towards the draft's 20,000 characters.
`from` is optional and only a hint for the composer. When the turn is submitted,
Cloud checks that the message is in the conversation and that `text` stands in
its visible text, compared without whitespace. An answer's visible text is the
rendered Markdown of all text in its turn. Cloud checks answers of up to 50,000
characters, counting a blank line between the turn's messages; that is as much as
it keeps of one message for search. Cloud then sets `from` from that message:
`assistant` for an answer, `user` for the person's own message, `automation` for
a message an automation sent. A quote that fails returns HTTP 400, nothing is
sent, and the response carries a stable `code` with a message in the request's
language: `quote_missing` (the message is not in the conversation),
`quote_not_quotable` (not an answer or a user message), `quote_mismatch` (the
passage is not in the message), or `quote_too_long` (the answer is longer than
50,000 characters). The user message keeps the checked quotes in `meta.quotes`, the
only source a client reads them from. The model reads each quote as a text part
Cloud writes. Text never counts as a quote: Cloud breaks quote markers in sent,
edited, and steered text, and again in every user message it gives a model,
unless `meta.quotes` holds that quote. Background models that read a chat, such as
titles, search summaries, and memory learning, read only the person's own words,
without quotes. Editing a queued message and retrying a
message keep the checked quotes and apply the same bounds; the bounds count the
person's words and the quoted passages, not attached items.

If a turn response is lost, retain the confirmed draft revision and the exact
submit options. `GET /api/ai/conversations/:id/submission/:draftRevision` returns
`{ submission: { messageId, turnId } }` when a user message records that revision,
including compacted messages, or `{ submission: null }`. It checks the current
owner and Project access. Null does not prove rejection: the original request
may still be running, or its history may have been removed.

A deliberate retry may submit the same revision and unchanged options without
saving again. The transaction consumes a draft revision at most once. After a
conflict, check the exact submission again; never infer acceptance from a newer
draft revision. Missing records or revoked access can leave the outcome unknown.
Keep the draft and make that uncertainty visible instead of sending it under a
new revision.

The browser controller also retains the original `queueId` and frozen body after
an uncertain queued submission. Saving, sending, and conflict overwrite stay
locked for that conversation. `reconcileSubmission` reads the existing queue;
a matching entry proves acceptance, but absence may mean it already ran.
`retrySubmission` replays the same body without another draft save, so the durable
queue receipt also recognizes drained entries. Both paths keep the local draft
locked until its post-submission revision has been read.

Pass `skills: ["cloud-grids"]` to attach enabled, readable Skills by exact name
when launching a chat. Core resolves them into ordinary `core.ai.skill` resource
chips with stable IDs and names; no instructions are copied into the draft.
The user can remove a chip before sending. Unavailable or disabled Skills fail
the launch, and linked Skills count toward the normal attachment limit.
For a scoped chat, include `load_skill` in `allowedTools`. Assistant loads a
selected Skill through that tool using its ID, with the same permission and
revision checks as loading by name. Linking never widens the tool scope.
For other resource chips, supply `title` and `icon` alongside `ref` to show a
useful name instead of the ID fallback. Do not repeat resource IDs as draft text.

Pass `allowedTools: string[]` to restrict a launched chat to exact built-in names
or qualified capability IDs such as `grids.gql.execute`. Omission preserves normal
discovery; an empty array permits no task tools. Preloads must belong to this set.
The ceiling is stored on the conversation, cannot be widened through updates, and
is preserved by forks. Each turn filters static tools, capability discovery and
loaded tools. Search/load/list metadata tools cannot expose excluded operations.
This restricts tools; it does not grant permissions or bypass Action approval.
Preloading alone is not a restriction.

Grids Query with AI uses this for discovery, Help, queries and approved View
creation without record or schema changes. Its launch creates an editable draft,
not an automatically submitted query.

`launchAssistant()` uploads browser `File` values after creating the private
conversation and then stores their returned versions in the same draft. The
JSON create endpoint itself accepts text and resource refs, not unuploaded file
paths.

The default tool source keeps discovery, Help, `fetch_file`, `read_file`,
`calculate`, and `view_image` available. Configured `web_search` and
`web_extract` are also always available together. `fetch_file` imports one
exact public HTTPS source into the conversation, with a readable Markdown copy
for web pages; it does not browse repositories, authenticate to a website, or
reach private network targets.
`calculate` stays loaded because, whenever a turn offers it, the system
prompt requires it for every amount, sum, percentage, or multi-step result the
model derives itself; simple relative dates such as tomorrow need no call. A conversation with a fixed tool scope that excludes it, or a model
without tool support, gets neither the tool nor that rule. Surveys, the
long-form text editor, charts, file writes and presentation, and
Markdown-to-PDF load on demand. Built-in usage hints remain in the system prompt even while their
schemas are deferred. These built-ins provide no arbitrary code execution,
host access, or network access beyond the explicit web tools. See
[Tools and approvals](/en/docs/ai/tools-and-approvals).

The default tool source offers `code_run`, `code_inspect`, `code_stop` and
`code_export` on the server, including API and detached CLI clients. Scripts
execute on the Code runner under the turn's authority and approvals. `code_secret`
uses the trusted web UI. Native views and chat files remain available; Studio
app tools and app databases have been retired. See
[Chat code execution](/en/docs/ai/chat-interface#chat-code-execution). Scheduled
chat routines are retired; see [Routines became Code](/en/docs/operations/routines-to-code).


The `text_editor` frontend interaction lets the model provide one complete
plain-text or Markdown draft for the user to revise. The browser presents both
formats in one Markdown editor. Unsubmitted edits are browser-local and may be
lost on reload; only accepted text or submitted revision feedback becomes a
durable turn action. Feedback asks the model for a replacement draft instead of
accepting the current source. Neither result saves a domain resource or
approves a later Capability Action such as updating or sending mail.

An interactive local client may additionally request the built-in local file,
Skill and Bash tools. They are offered only when the turn declares their
names in `clientToolIds`; browser clients do not opt in. Cloud persists and
streams the calls and validates their results, while the local client owns
execution and path rules. See the local CLI boundary in
[Tools and approvals](/en/docs/ai/tools-and-approvals#run-an-optional-tool-in-a-local-cli).

Personal conversations expose the compact tool discovery and loading tools.
Live app Queries and Actions additionally require `appTools: true`, a model
profile with `tools` support, and a current direct user actor; service-backed
agent identities are not part of this contract.

The shared platform prompt separates platform rules, a short execution loop,
conditional tool guidance, and labeled application context. It tells agents to
use required tools, inspect their results, and continue until the request is
complete or genuinely blocked. Retrieved emails, webpages, user files, Help,
capability results, ordinary tool output, Project context, and memories remain
data rather than instructions. Project instructions and the Project context
manifest are copied into the durable turn configuration. Current Project access
is checked again before execution; edits affect the next turn. The runtime normally
treats a provider `stop` as a completed turn (see [Failed turns](#failed-turns)
for an empty response after a failed tool call). It does not infer unfinished
work from model text or trigger language-dependent automatic retries.

### Conversation titles

A title given at creation, such as the localized "New chat" of the web chat,
stays a default title. A chat created without a title gets the same default in
the request locale, so `cld assistant chats create` names a chat "Neuer Chat"
for a German caller. The first message's text replaces it, and enrichment may
rename it. Renaming through `PATCH /api/ai/conversations/:id` marks the title as
the user's (`titleSource: "user"`). Neither the first message nor enrichment
replaces that title, for web and API clients alike. Renaming to the current title
changes nothing.

The CLI is one consumer of this rule. `--title` on `cld assistant -p` and
`cld assistant chats create` creates the chat and then renames it through this
endpoint. The CLI trims the title and checks the 1 to 120 character limit before
creating anything. A `--title` equal to the default title the chat got keeps
automatic naming.

## Chat route groups

| Group | Purpose |
| --- | --- |
| `/status`, `/models` | Read sanitized runtime and model state |
| `/prefs` | Read or update personalization enablement and learning settings |
| `/memories`, `/memories/:id` | Search and manage structured personal facts, preferences, and workflow defaults |
| `/conversations` | List and create conversations |
| `/conversations/:id` | Read or manage one conversation |
| `/conversations/:id/draft` | Optimistically save text, files, and Cloud resources |
| `/conversations/:id/project` | Choose, change, or clear the current Project between turns |
| `/conversations/:id/messages/search` | Search visible text inside one owned conversation |
| `/conversations/:id/messages/:messageId/feedback` | Set or remove private owner feedback for one Assistant message |
| `/conversations/:id/resources` | List or filter structured Cloud refs observed in one conversation |
| `/resources` | List or filter structured Cloud refs across the user's active conversations |
| `/resources/recent` | Up to 8 recently sent Cloud refs of the user, each re-read with its app's reader for this user before any title is returned |
| `/conversations/:id/turns` | Start, steer, or stop work |
| `/conversations/:id/stream` | Receive the conversation event feed over SSE |
| `/conversations/:id/files` | Manage conversation files |
| `/live` | Receive the user's AI live updates over Core's live socket, channel `user` |

The router also supports message retry, forks, compaction, pending tool
actions, conversation enrichment, and paged history.

Automatic compaction accounts for the configured output-token reserve. When a
single user request grows too large, it can summarize completed model rounds
inside that first loop. The newest two model rounds stay intact, and a tool call
is never archived separately from its pending result. Archived messages remain
available in the conversation history.

Compaction streams the summary from the model provider, so the provider's
first-byte and idle timeouts of 60 seconds each apply: the model must start
answering within 60 seconds and must not pause for longer than 60 seconds. A
slow model that keeps answering is not cut off. A timed-out `/compact` fails
with reason `model_unavailable` and leaves the context as it was. When the
automatic compaction before a model call times out, the turn continues with the
full context. When the provider already rejected the context as too large, a
failed compaction ends the turn.

For a compact diagnostic of one owned chat, including its ordered tool calls,
arguments, results, model profiles, errors, usage, and timing without the
duplicated loop transcript, run:

```bash
cld assistant chats diagnose <chat-id> --json
```

Search applies ownership, Project, archive, status, and pagination
filters before returning visible conversation text. Tool results and model
thinking are not user-visible message search results. Structured Cloud resource
discovery indexes only schema-valid refs observed in trusted structured values;
it does not infer resource identity from prose.

## Runtime ownership

Core mounts `/api/ai`, migrates the AI schema, and exclusively owns the
conversation workers, maintenance, and durable
continuations. Applications must not start a second AI conversation runtime.
They publish domain Capabilities, launch a personal conversation through
`launchAssistant()`, or use `runAiStructured()` for bounded server/workflow AI.

Interrupted work resumes from saved state. User approvals and frontend-tool
responses remain pending until answered; they are not failed attempts.
Repeated execution failures end the turn as failed. Set concurrency for the
deployment, not per request.

## Stream state

In text output, `cld assistant -p` and `cld assistant turns watch` separate
non-blank assistant text blocks with a blank line. Reconnects and interactive
approvals print only new text and do not repeat a tool's unchanged status. JSON
result text uses the same separators. JSONL `text_delta` events carry each
block's new text once under the block ID that first carried it, without
separators. `turn_finished` carries the complete text, also when the turn ended
during a reconnect. Tool progress and approval matching use canonical capability
IDs such as `spaces.task.create`. Persisted provider tool names stay unchanged;
hashed names that cannot be decoded retain their stored name.

A turn stores each capability step's app name as it was then. History, the
stream state, and finished turns name the app as the catalog does now, by its
app ID and in the reader's language; an app the registry does not know keeps
its stored name.

Assistant renders capability table presentation metadata in both web chat and
text-mode CLI output. The CLI shows up to 100 returned rows, shortens long cells,
and prints supplied result links. Additional rows or pages are marked; displaying
a table does not fetch more data. JSON and JSONL output retain their structured
format and do not include terminal tables. The Assistant summarizes findings and
completeness limits instead of repeating rows, unless the user requests them.

The conversation protocol is transport-neutral. Every subscription receives a
full authorized state snapshot and then ordered updates for messages, text,
tools, approvals, provider retries, and turn completion. The runtime captures the
retained-topic cursor before loading the snapshot, so work that arrives while the
snapshot is loading remains in the ordered tail. Attempt and sequence numbers
make replay idempotent. Only `turn_finished` ends a turn; a low-level client
ignores event types it does not know.

Each execution attempt starts with one atomic, server-ordered block baseline.
Resuming after an approval or frontend-tool response therefore keeps every
existing item in its persisted timeline position while new output is appended.
The conversation stream uses SSE. Use `parseAiSse()`
from `@k2b/cloud/ai/browser` for a low-level or CLI client. This
client entry point also exports attachment limits, `guessAiMediaType()`,
`isAiImageMediaType()`, the card, chart, survey, text-editor, and local-bash
input schemas, `CLOUD_AI_TEXT_EDITOR_MAX_CHARS`, the chart limits
`CLOUD_AI_CHART_MAX_SERIES` and `CLOUD_AI_CHART_MAX_VALUES`,
`parseCloudAiChartInput()`, which reads a chart call as one typed chart, and
`cloudAiChartTable()`, which turns that chart into the rows its data table
shows. These helpers do not initialize
Cloud server services. Import AI types with `import type` from
`@k2b/cloud/ai`. Solid applications should use
`createAiChatController()` from `@k2b/cloud/ai/solid`; it subscribes to the
visible conversation over SSE. To reconcile a previous creation request without
changing the visible chat, call `createConversation(input, { activate: false })`.
The result is cached while a foreground chat load and its stream stay active.
Changing chats closes the previous stream and
opens one for the new chat; every connection, including a reconnect, starts
from a fresh authorized state snapshot. Assistant, the CLI, and low-level
consumers all use `/conversations/:id/stream`. Over HTTP/1.1 each open
Assistant tab holds one of the browser's six connections to the host; over
HTTP/2 the streams share one connection. A proxy in front of Cloud must not
buffer `text/event-stream` responses.

The portable chart helpers come from `@k2b/editor/charts`. Their existing Cloud
exports remain available; Cloud owns AI validation and size limits.

An open SSE stream checks its credential and conversation at admission and
on Identity-Access or conversation access events. Its five-second heartbeat
and ordinary live deltas run no SQL. Known account and credential expiry
times also have local timers. A revoked session or API key, an expired account, or a conversation
that is archived or no longer the caller's ends the stream. The next
connection attempt then receives 401, 403, or 404. The controller's default
SSE transport does not retry these statuses. It stops the stream:
`streamStatus()` becomes `idle` and `error()` explains, in the page's language,
that the session ended, that access to the chat ended, or that the chat is no
longer available. The transport reports the status as an `AiStreamError` code;
the controller chooses the text. Reopening or refreshing the chat, or acting in
it, subscribes again. Other failures keep reconnecting with backoff.

Each attempt numbers its events without holes and starts with
`turn_started`, and a turn ends with `turn_finished` before the next one
starts. The worker saves the turn's live state within one second of every
event. The stream checks each event against this order. When an event is
missing, it sends a fresh `state` as soon as the saved state holds that event
and continues after it, so a reader never applies updates over a hole. An event
can go missing because the snapshot a subscription starts from lags the live
events, because its publish failed, or because it is too large for the live
topic. Events over 257 KiB, such as a tool block with a large web page, travel
only as their position, and the stream delivers them in full through the saved
state. Such a `state` carries the conversation as it is now, with its current
draft revision and run status; the stream ends once the conversation is
archived or deleted. A turn's end always reaches readers, also when a stop or
the sweep numbers it from a saved state that lags the live events, and also
when the turn ended while the stream waited for its saved state. Then the
`state` already shows the turn as finished, its `turn_finished` follows, and
replayed events of that turn are dropped. If the saved state does not catch up
within five seconds, the stream continues with what it has and logs the
warning `AI conversation stream continues without an event the saved state
does not hold` under `ai:stream`; readers then miss part of the turn until
it ends.

The server closes a stream once its reader has left about 4 MiB unread. The
event that crosses that limit is still queued, and a `state` snapshot or a
`turn_finished` event with its stored messages can be larger than one stream
event. The client then reconnects and continues from a fresh state snapshot.

The controller folds the stream into one projection and exposes the
active conversation's history, send, steer, abort, retry, fork, compaction,
approval, and frontend-tool actions. Do not put conversation and Project lists,
metadata, Sources, files, Project context, or access changes
into turn events. Those are durable server projections and refresh through
[Realtime UI](/en/docs/frontend/realtime-ui).

For the local client tools (`local_bash`, `local_list`, `local_read`,
`local_upload`, `local_download`, `local_write`, `local_move`, and
`load_local_skill`), the executor publishes and flushes the request
immediately, then polls for a result every 10 ms for up to half a heartbeat
interval (1.5 seconds in production). A result within that window continues in
the same lease, without another claim or rebuilding the turn, and does not
count as a resumed attempt. Otherwise the turn suspends and enqueues a
continuation as before, including when the result arrives as the wait ends.
Other client tools such as `code_secret`, human interactions
such as `survey` and `text_editor`, and all approvals suspend immediately.

`POST /conversations/:id/turns/:turnId/actions/:callId` validates results of
the local client tools against their declared output schema. Invalid output
returns HTTP 400 naming the tool and first issue; the action remains pending.
The route limits the JSON body to two fully escaped 512 KiB Bash streams plus
a 64 KiB envelope. Other client tools keep their existing result contract.

Action responses are idempotent. Retrying the same response is safe and
re-enqueues its continuation; a conflicting response for an already resolved
call is rejected. On reconnect, the state snapshot reconciles durable action
responses before rendering, so resolved approval controls do not reappear and
plain browser tools are not executed again merely because the page reloaded.
A call the user approved keeps `approved: true` on its tool block, and its
stored result records the decision, as a rejection does, so history can show
the decision after a reload. A call whose approval still waited when its turn
ended carries `approved: false` in history, so it shows as not run instead of
disappearing.

Do not maintain a second client-side chat state machine.

## AI live updates

Core serves AI live updates on the shared
[live layer](/en/docs/automation/live-updates) at `/api/ai/live`, with one
channel, `user`, and an empty scope. Its data is an `AiInvalidation` from
`@k2b/cloud/ai/live-events`: which of the nine `AI_INVALIDATION_DOMAINS`
changed, and for which conversation or Project. Database triggers on the AI
tables write each update in the transaction of the change, keyed
`u:<user ID>`, so a rolled-back write publishes nothing. A Project change is
written for every user who can read the Project at that moment, including
nested groups and grants to all signed-in people; a grant change reaches the
readers before and after it. A conversation change reaches only its owner.
A Cloud administrator's decision on a submitted Code version writes
`code-versions` for the person who submitted it, in the decision's
transaction, so the version card in the chat shows the decision without
polling.

A socket follows only its own user's key, and its credential is checked again
every 10 seconds; an ended session closes it with `1008`. A third-party UI
subscribes like Assistant and reads the cursor before its snapshot:

```ts
// Server, before loading the page's state
import { aiLive } from "@k2b/cloud/ai/live";
const cursor = await aiLive.cursor();

// Browser
import { AiInvalidationSchema } from "@k2b/cloud/ai/live-events";
import { liveConnection } from "@k2b/cloud/browser/live";

liveConnection("/api/ai/live").subscribe("user", {}, {
  cursor,
  parse: (data) => AiInvalidationSchema.parse(data),
  apply: async (events) => reloadViewsFor(events.map((event) => event.data)),
  resync: reloadEveryView,
  unavailable: showUpdatesPaused,
});
```

The browser reloads each affected view through its authorized HTTP query
before it moves the cursor. A reconnect replays what the tab missed; a cursor
outside the replay window receives `resync`, which reloads every view. Core's
window holds the latest updates of all users together, so a tab that was away
during much activity reloads instead of replaying.
Project context can be shared through normal Cloud access grants, but each
conversation remains owned by its creator and only appears in that user's
updates and queries.

### Code decision activity

`meta.codeDecision` identifies a factual timeline entry with `codeId`,
`versionId`, `number`, `outcome`, `person:{id,name}`, `anchor`, `at` and optional
`nextRunAt`. Outcomes are `approved`, `changes_requested`, `rejected` and
`activated`. Decision and activation are separate historical rows. They have
no turn and never join the active assistant answer. The host can render their
card link through `AiChatActions.renderCodeDecision`.

Core records each delivery intent in the decision or activation transaction.
A worker appends it once to the original author's chat while holding the chat
lock, after its active turn finishes. It rechecks current management and chat
ownership before delivery. The write updates `background_received_at` and
invalidates `conversation-detail` and `code-versions`; cards keep listening
when ready and during a revision. Navigation targets the card's
`code-version-<versionId>` DOM anchor rather than the submission tool call.
Renewing an expired request keeps the first card's anchor, including for its
new version's waiting item, event and notification. Model history receives a fixed historical
fact without names, titles or administrator instructions.

The following `codeReviewStart` message marks the start of the automatic
revision. Its localized sentence says that Gustav is revising the version;
it does not repeat the administrator's decision or name. Render the decision
once, followed by this separate start of the review turn.

A host can use `appendAiBackgroundMessages` from `@k2b/cloud/ai/runtime` for a
bounded batch under its destination chat locks. It assigns message order and
updates chat markers in one statement; the caller owns durable deduplication
and admission. `registerAiTurnAbortHandler` lets the host close its durable
review submission gate before a review turn's cancellation becomes visible.
The disposer removes that handler; ordinary turns do not invoke it.

### List the person's open questions

Use `listAiOpenQuestions` from `@k2b/cloud/ai` on the server to seed a personal
chat overview. Resolve `ownerUserId` from the authenticated user; the read
includes that person's pending approvals in chats they own. An independently
deployed application passes a `caller` with the person's own credentials to
read Core's other waiting sources through its authorized `ai.open_questions`
Query. Only Core-owned code may pass `authority` for in-process dispatch; that
authority must name the same person.

```ts
import { listAiOpenQuestions } from "@k2b/cloud/ai";
import { expectUserBackedActor, getLocale, getTimeZone } from "@k2b/cloud/server";

const user = expectUserBackedActor(c);
const questions = await listAiOpenQuestions({
  ownerUserId: user.id,
  locale: getLocale(c),
  timeZone: getTimeZone(c),
  caller: {
    cookie: c.req.header("cookie"),
    authorization: c.req.header("authorization"),
    locale: getLocale(c),
    signal: c.req.raw.signal,
  },
});
```

`AiOpenQuestions` contains at most 20 `items`, oldest first, and a `count` of
all matching questions, independent of the current page. The bound comes from
`APPROVALS_PAGE_SIZE`. When more entries remain, `nextCursor` contains the last
item's `{ createdAt, id }`; pass it unchanged as `cursor` to read the next page,
keeping the same `kind` filter. An absent `nextCursor` ends the list. Ordering
uses creation time at millisecond precision, then ID, so timestamp ties and a
resolved cursor entry do not skip other questions. The cursor carries no access:
every page rechecks the same owner and permissions. Cursor IDs are limited to
100 characters; IDs use code-point ordering, matching PostgreSQL `COLLATE "C"`.

SSR supplies the first page. An island can call Core's `ai.open_questions`
Query with `{ timeZone, cursor }` on **Load more** and validate its answer with
`AiOpenQuestionsSchema` from the browser-safe
`@k2b/cloud/contracts/open-questions` entry point. Keep the existing rows visible
while loading, and offer a retry on failure. When a section displays only some
question kinds, one click can cross pages that add no visible entries until a
new entry appears or the feed ends. Bound that traversal by the snapshot's
`count` and `APPROVALS_PAGE_SIZE`. Do not read every page on startup.

A live snapshot must not discard previously loaded rows. Re-read the already
loaded range through the same authorized Query, retain the last good rows until
that read succeeds, and remove resolved entries and duplicates of the first
page. Offer a retry when reconciliation fails. After loading new entries, move
focus to the first new entry's action, including when the last page removes the
load-more button.

Each `AiOpenQuestion` carries its ID, required `kind`, chat
short ID and current title, tool-block `anchor`, short plain text, app
presentation, and ISO creation time. The short text uses the review's `short`
template when provided, otherwise its action sentence, rendered like the card's
chips: person names only, object and place titles without quotes, and formatted
time labels. Legacy reviews and calls without a review keep the card's literal
question text. Missing or unreadable tool blocks fall back to the first line of
the request sentence and a tool anchor; one damaged question does not prevent
the others from loading.

Kinds are `approval`, `code_activate`, `code_changes`, `code_expired` and
`code_attention`. A Code change appears only when no automatic revision is
queued or running; withdrawn, replaced or activated versions leave the list.
Operational attention names a missing Secret, access, mandate or chat and
carries an `href` to the Code page, plus `reason` (`secret`, `access`,
`mandate` or `chat_missing`) so the page can name the way out. Entries without a chat use an empty `conversationId`
and `anchor`. Use this same snapshot for the page, sidebar and badge. Domain
notification senders reuse the source's text and target.

`short` is limited to 160 Unicode code points and `conversationTitle` to 200.
Truncated values end with `…`, included in the limit, without splitting a code
point. These bounds also apply to legacy questions and fallback text.

Assistant carries this read in its sidebar snapshot for both server rendering
and subsequent reloads. Opening, resolving, or removing a question invalidates
`conversation-list`, including when another question in the same turn remains
open; browser tool calls do not. Reuse that invalidation to reload the
snapshot; no separate polling or question endpoint is needed.

In tests, `@k2b/cloud/ai/testing` provides demo questions:
`aiQuestionFixtures(locale)` returns tool blocks with reviews, and
`aiOpenQuestionFixture` presents one of them as this read would. The demo data
may change in any release, so assert on what your host renders from it.

## Treat turns as asynchronous

Starting a turn does not mean it completed. The API returns the persisted turn,
then the stream reports progress.

Use the final turn status for completion. Handle `failed` and `aborted`
explicitly.

For the UI layer, see [Chat interface](/en/docs/ai/chat-interface).

## Dictation and draft revisions

Assistant records a complete mono WAV before uploading it. There is no live
audio stream, automatic prompt submission, or meeting transcription. Microphone
permission and AudioWorklet support are required. Recording stops at the
25,000,000-byte transcription limit; its duration depends on the device sample
rate. Before upload confirmation, reloading or closing the tab can lose the
recording. Navigation during recording stops and uploads it to its bound chat.

Core owns the Assistant dictation API and worker. These conversation endpoints
use the same user-backed authorization as drafts:

| Endpoint suffix below `/api/ai/conversations/:conversationId` | Operation |
| --- | --- |
| `POST /dictations` | Multipart `file`, client UUID `operationId`, optional two-letter `language` |
| `POST /dictations/discard` | Client UUID `operationId`; discard even before the start response |
| `GET /dictations` | Pending items; optional `after` cursor and `limit` up to 50 |
| `GET /dictations/:dictationId` | Status and complete transcript |
| `POST /dictations/:dictationId/apply` | Local draft `content` and `expectedRevision`; append once atomically |
| `POST /dictations/:dictationId/action` | `action: "retry"` or `action: "discard"` |

The start transaction writes one normal conversation file and a private input
snapshot. Both count toward the conversation storage quota.

File metadata includes `dictationRecordedAt`, separate from the
`user` origin used for write protection. Renames, conversation copies, forks,
and turn snapshots preserve it. Replacing file contents clears this provenance.
Ordinary audio uploads never receive it. The turn manifest and `list_files`
identify these recordings as prompt dictation, while keeping the audio readable.
`conversationFileSource().listFiles()` exposes the original file metadata for
application-owned grouping without changing file paths.

The operation ID is bound to user, chat, bytes, and options. Repeating it with different input
returns a conflict; repeating identical input returns the same dictation even
if the configured default model changed. One pending dictation per chat is
allowed. Results use public short IDs; operation IDs are client correlation.

The worker uses the pinned profile ID and rechecks model and Project access.
Two concurrent jobs share the Core runtime lifecycle. Postgres leases fence
stale workers; a sweep every 15 seconds recovers missing queue delivery and
expired claims. Transient provider failures have at most three automatic
attempts. Input snapshots remain available for explicit retries after failure
and are released after success or discard. A crash around provider completion
can repeat the provider request and its charge.

AI live updates carry `conversation-dictations` invalidations, not audio or
transcript content. A database trigger creates the outbox entry
in the same transaction as each status change. Initial loading, reconnect, and
returning to a chat reload pending dictations through HTTP. A completed upload
also refreshes that query to cover completion before subscription.

Each local composer tracks the revision of the draft actually displayed and a
separate edit generation. Controller `saveDraft()` and `send()` accept explicit
`conversationId` and `expectedDraftRevision` for that binding. A remote refresh
cannot advance the base of dirty local text. Safe unchanged sessions can append
a finished dictation automatically; changes, navigation, or reload require an
explicit **Insert**. Apply checks the revision and marks the dictation applied
in the same transaction. Typing during apply preserves local text and exposes
the saved draft for an explicit decision. Conflicts never retry with an unseen
newer revision.

This worker is specific to Assistant conversations. Other applications call
`runAiTranscription()` from their own authorized service or durable worker and
own their own inputs and results.

Dictation clients can discard an upload before receiving its job ID with
`POST /api/ai/conversations/:conversationId/dictations/discard` and
`{ operationId }`. Core serializes this with start and apply, retaining a
conversation-owned cancellation marker so a delayed upload cannot recreate
the job. Repeated discard is safe. An already applied draft is preserved;
the response reports `applied` or `discarded`. Normal chat files are retained.

Transcription attempts use AI traces and the structured-run ledger. Failed attempts
record a safe error message, a stable error code, and the trace ID. Provider HTTP
failures include the status and a diagnostic hint without retaining response bodies,
audio, or transcripts in logs. Filter Logs by `ai:transcription` or `ai:dictations`;
dictation worker entries also include the dictation ID, model profile, attempt,
and retry decision. Dictations are not workflow runs.

### Retired Assistant routines

Scheduled chat routines are retired. See [Routines became Code](/en/docs/operations/routines-to-code) for export and rebuild instructions. Existing transcript text remains readable without run controls.

### Background Assistant tabs

Hiding the browser tab does not close the visible conversation's SSE stream,
so a turn keeps streaming and its frontend tools keep running. The live socket
closes while the tab is hidden and replays the missed updates when it returns.
This does not override browser suspension, operating-system sleep, reload, or
closing the tab. Agent code execution uses the Code runner, so changing or
closing the tab does not stop it. Entering secrets and answering approval
prompts still require a client.

When code in that host calls a capability Action or sends an external HTTP
request, the chat approval names the app and Action, repeats the owning app's
review in the reader's language, and lists each reviewed value as its own row.
An Action without a review lists its input fields. The approval never shows the
raw request object, and secret references appear only by name.

Code Mode source and runtime tools do not require confirmation. Source Actions
retain permission checks and idempotency. Browser execution claims resolve a
public short turn ID to the authorized active turn's UUID before persistence.
A duplicate claim cannot repeat an interaction. A call that does not complete
returns `CodeToolFailure` (`{failed: true, error, guidance?}`), and the
server-run code tools report it to the agent as a tool error. Host failures
carry guidance to report them rather than rewrite otherwise valid application
source or repeat unchanged calls.

The execution host and its approval waits belong to one Assistant process.
Keep one Assistant replica for now: a poll or an approval that reaches another
replica marks the call lost, and temporary JavaScript state is not transferred
between replicas or recovered after a process restart. This limit belongs to
the Code Mode host work in [#47](https://github.com/k2b-dev/cloud/issues/47).
Durable call records prevent an uncertain operation from being replayed. A new run is required after
host loss. Startup and health checks are bounded independently of the user's
browser timers.

Complete active-turn snapshots replace the observed block baseline when their
attempt and sequence are current. Older snapshots cannot restore obsolete
streaming block IDs. Pending local steering remains visible until acknowledged.
In-attempt continuations publish a complete turn baseline before incremental
updates, so persisted and streamed representations do not appear together.

ZIP archives (`.zip` or `.ZIP`, `application/zip` or `application/x-zip-compressed`)
are ordinary file attachments with a download and the same 50 MiB file limit.
Uploads store their bytes unchanged; the server does not unpack archives.

Conversation multipart uploads accept an optional `directory` form field
(default `/`). The normal path validation and reserved Project namespace apply.
Collisions receive a suffix; use the returned `file.path` rather than deriving
a path from the original filename.

Chat timing uses the durable user turn's wall-clock interval. Each model request
records its generation interval before tool execution; these measurements survive
client actions and executor resumption. Tool execution and approval/browser waits
use their durable audit timestamps: an approval or an answer waits until the user
gives it, a secret prompt included, and a tool the browser runs by itself waits
only until it starts. Overlapping phases are counted once. An older or
incomplete trace has no aggregate timing or token-rate estimate; the chat can
still display elapsed time from persisted messages. The chat shows a turn's work
time: wall time minus time spent waiting for approvals and other user actions.
While a turn runs, its state snapshot carries `actionWaitMs`, the time already
spent on answered waits, and `waitingSince`, the start of the wait that is still
open, by the same rules, so a client that reconnects continues the same clock
and the finished turn shows the same value. Older servers omit both fields.

A turn that is finished without a loop end of its own, such as a stop while an
approval waits or a turn the sweep finalizes, records `aborted` after a stop,
or `error` when it failed or its wait expired, as `loopDoneReason` on its last
assistant message. A failure also replaces the `aborted` that a loop cut off by
its run time limit records, so the limit never looks like a user stop. History
then shows the turn as stopped or interrupted, and a call that never ran as not
run. A call the user approved that never returned keeps its decision as
`toolOutcomes` on the message that holds the call, so history still shows its
receipt; a call whose approval nobody answered records `expired` there. A
custom approval, which code requests while its call runs, counts for that call,
and one approved request outweighs a later one that expired. Live
`message_saved` events carry usage after each model response, before its tools
finish, without rendering a second copy of the active response.

### Failed turns

When a model sends a tool call that Cloud cannot use, for example arguments
that are not valid JSON, the chat keeps it as a failed tool step. Its error
result names the problem and asks the model to re-send the call with its exact
tool name and complete, valid JSON arguments. The step appears when Cloud saves
the response, after the other steps of that response, and stays in the same
place after reload and in history. A provider failure keeps a partial response
that has content in history, without the unusable call. A response that is
never saved, for example an attempt that exceeded the context window and that
compaction retries, shows no such step. Cloud never runs a malformed call, also
when a run stopped before it saved the error result. A response cut off at the
model's output limit runs none of its calls; each gets an error result that asks
for a shorter response.

The model may repair two such responses in a row. If its third response in a
row still has an unusable call, the turn fails with reason `failed` and keeps
the completed steps; a resumed turn counts the responses it already stored. A
response with only usable calls, or a message the person sends while the turn
runs, starts the count again. Repairs do not count as tool rounds and do not
acknowledge user steering.

Read-only capability Queries of one response run at the same time, at most four
at once; every other tool call runs alone, in the order the model sent them.
Their steps and results keep that order.

Truncated streams and provider failures end with `loop_end` reason `error`.
A provider that stops an answer itself ends the turn as failed with
`provider_stopped`: a gateway error, malformed call, content filter or refusal
can cause this, and Cloud cannot tell them apart. Its tool calls are never
executed, including on a later resume, so the chat offers **Continue**.
A loop that ends normally but whose final response has no text and no tool call
right after a round with a failed tool call fails with `tool_failed`;
rejected approvals do not count as failures. Worker recovery restores this
state from the latest stored assistant round, including repaired malformed
calls. A later text answer still completes the turn.

Each model `turn_start` has one `turn_end`, including errors and cancellation.
`turn_end` carries the partial assistant message with `stopReason: "error"` or
`"interrupted"` when generation failed or was stopped. It does not mean that
an answer succeeded or its tool calls ran. Partial content stays in history,
except for a context-overflow attempt that compaction may retry. A failed or
interrupted compaction response never replaces the existing context. The chat shows
failed or interrupted content accordingly and keeps calls that never ran as
not run. Leaving the loop iteration early aborts the loop.

A failed turn records why as `meta.turnError` on the last message of its loop,
which is the user's own message when the model never answered. The code is
stable and never translated; clients word it in their reader's language:

| `code` | Meaning | A new message can continue |
| --- | --- | --- |
| `provider_stopped` | The provider ended the answer early, for example a gateway error, malformed tool call, content filter or refusal | yes |
| `tool_failed` | A tool call failed and the model's next response ended without text or a tool call | yes |
| `model_unavailable` | The model service failed or timed out, also after its retries | yes |
| `quota_exhausted` | The user's AI usage limit for the period is used up, or its usage could not be measured | no |
| `context_full` | The chat no longer fits the model, also after compaction | no |
| `time_limit` | The turn's run time limit ended it; `limitMinutes` names the limit | yes |
| `step_limit` | The model profile's `maxToolRounds` is used up, or the model kept calling tools after it was asked to answer | yes |
| `wait_expired` | An approval or an answer did not arrive before the wait's deadline | yes |
| `interrupted` | Workers lost the turn repeatedly and it used up its recovery attempts | yes |
| `not_allowed` | The chat may no longer use its model, project, apps, or background mandate, AI settings offer no usable model, or the background AI budget stopped the run | no |
| `failed` | Any other cause | yes |

`AiTurn.error`, `AiConversation.runError`, and the `error` of `turn_finished`
hold the worded reason for readers without the chat view, such as `cld`: in the
turn's language, or in English when the sweep finalized the turn. When a new
message can continue, it adds that the results so far are kept and that a new
message continues the task; a failed compaction holds the reason only. A
background run that its mandate or the background AI budget blocked keeps
Cloud's own explanation there. `AiConversation.runTurnId` is the public ID of
the latest turn, which `runStatus` and `runError` describe; the messages of that
turn carry it as `loopId`. Provider failures and loop issues use fixed Cloud
diagnostics in the error log entry `AI turn failed` under `ai:executor` and in
[usage records](/en/docs/ai/usage-and-feedback#read-the-report). Provider
messages, response bodies, and tool-validation payloads do not enter these
diagnostics. Detailed tool-validation feedback remains in the authorized
conversation for model repair. A stop records no reason.

Provider history preserves each complete assistant message, including its
producing `provider` and reasoning blocks' `signature`, `redacted`, and `details`.
Those fields remain unchanged through tool-result repair and in the recent
context retained by compaction. Display and enrichment projections do not
rewrite that history.

This fidelity does not make every replay valid: Cloud rebuilds the system prompt
(date, time, plan and memory) and tool list for each turn, and compaction replaces
older turns with a summary. A provider that binds replayed reasoning to an
unchanged conversation prefix, such as current Anthropic models on newer
accounts, can reject a later request.

The next turn of the chat sees the failed turn's finished steps in its context.
A turn that ended while a call ran or waited for an approval leaves that call
without a result. Each model request answers such a call with an error result
saying it did not return and may or may not have run, right after the message
that made it; stored history keeps the call as not run. A result stored after a
scheduled result that arrived while its call ran moves up next to its call in
the request. Providers reject a history with an unanswered call or a result
apart from its call, so before, the chat's next turn failed.

### Run time budget

Administrators configure `ai.turn_timeout_minutes` in AI settings. The default
is 30 minutes; zero or clearing the field disables this run time limit. Values
must be nonnegative whole minutes. The worker snapshots the budget when it
first claims a turn. Later setting changes do not alter a claimed turn, including
lease recovery. Resuming after a human interaction uses that same configured
budget for its new running phase. Individual provider and tool timeouts and
worker leases remain independent, even with an unlimited turn budget.

The last tenth of the run time is kept for the answer: a model call that starts
in it gets no tools and is asked to answer with what the turn has done, to say
what is still open, and to tell the user that a new message continues the task.
With the default of 30 minutes, tool use ends after 27 minutes. The turn then
completes normally with that answer.

An expired execution deadline still ends the turn as failed with the reason
`time_limit`, for example when a single model or tool call outlasts the
reserve; see [Failed turns](#failed-turns). It is distinct from a user's
Stop action. Continuing does not automatically replay uncertain external calls.

### Loops within a turn

A chat turn, including one that runs scheduled or in the background, watches
for two patterns that rarely lead anywhere:

- the same tool called with the same input fails twice;
- six calls in a row to `search_tools`, `list_apps`, or `load_tools` without a
  working step that completed.

The first time a pattern appears, the next model call gets a short hint to
change its approach or tell the user what blocks it. When either pattern
appears again after its hint, also with another tool or input, the next model
call gets no tools and is asked to answer with what the turn has, say what
blocked it, and what the user can do. The turn then completes with that
answer. A rejected approval is the user's decision and does not count as a
failure. After the search hint, loading a tool that a search found is still
allowed; another search, or a load that adds no tool, continues the pattern.

The counts belong to the turn since its start or its latest steering message.
When a turn resumes after an approval or on another worker, its finished calls
count again, including rounds that compaction archived, but a hint given
before is not remembered, so the pattern gets one more hint. A steering
message starts these checks over: the turn continues with tools, also after a
loop's final answer, unless it is in the last tenth of its run time or has
used up the model profile's `maxToolRounds`.

The model profile's `maxToolRounds` ends tool use the same way; see
[Models and providers](/en/docs/ai/models-and-providers). If the model still
calls a tool in a model call without tools, the turn ends as failed with the
reason `step_limit` instead of continuing without them. Each hint logs the warning `AI turn got a loop hint`
and each switch to the final answer logs `AI turn answers without further
tools`, both under `ai:executor` with the conversation and turn IDs.

### Automatic turn safety budget

Only turns with an explicit non-person trigger (such as an automation or another
chat) have the automatic input, call and output allowance. Missing triggers,
including legacy turns, keep person limits. Agents and service accounts, also
with a delegated user, are treated like people unless an explicit non-person
trigger says otherwise. Code review revisions retain `CODE_AUTHORING_TURN_BUDGET`;
they acquire neither an automatic inference allocation nor its per-call output
ceiling or 32k compaction threshold.
`AUTOMATION_TURN_BUDGET` allows 192,000 cumulative input tokens, 12 model
attempts and 12,000 output tokens, with at most 4,096 output tokens per call,
regardless of the model's price. The values come from a measurement of twenty
briefings and thirty number posts on 16 November 2026: the largest briefing
read 178,000 input tokens in nine calls. Chat calls, transient provider
retries and automatic compaction share the allowance. Worker recovery reads
the whole turn's usage once; a recovered call without usage reserves 64,000
input tokens and the per-call output ceiling. Admission uses the same
conservative request estimate as the authoring guard and keeps higher reported
usage. These are safety estimates, not an exact provider invoice ceiling.
Steering by a person does not reset the trigger or refill the allowance.

At the limit Cloud persists a localized stop notice without another model
call. Existing results remain visible. Continuing requires the person's
explicit follow-up through the normal send path; reload and reconnect do not
restart the work. A number post reads the whole chat history, so automatic
turns compact a history above 32,000 estimated tokens even when the model has
a larger context window. Turns a person starts keep the model's normal
compaction threshold. Archived messages stay visible, but cannot be retried in
place.

### Code authoring safety budget

For a turn started by a person or a Code-review revision, invoking a lasting Code
authoring tool or selecting the authoring Skill allows at most 90 model attempts, followed by at most
one tool-free closing attempt after all existing drafts are submitted. Priced
models on Assistant chat turns with an effective finite cost limit have no additional cumulative
input-token limit. All other models admit at most 5,760,000 cumulative input tokens,
including instructions, conversation and tool schemas. Provider retries and
automatic compaction share the turn's attempt and, when applicable, token allowance. Previously loaded tools alone do not activate
the allowance in a later turn. Admission reserves the input estimate; reported input replaces it when higher. These
estimates use the same four-characters-per-token convention as AI accounting,
so they are a safety budget rather than an exact provider invoice ceiling.

The same Code authoring error gets an initial attempt and two retries.
Different diagnostic codes, source locations, messages, and assertion paths
are separate errors; an undifferentiated failed check is not an error identity.
Changing a fixture title, source text, or switching between test and simulation
does not reset that error count. Successful fixtures that deliberately test
an error do not count as failures. A response containing several checks cannot
run more identical failing checks than this allowance.

When all drafts in the turn have been submitted, reaching an authoring
bound permits exactly one closing model call without tools. Gustav describes the
submitted work and any requested work not yet started. Cost admission still applies;
without an effective finite cost allowance, the closing request must fit the remaining
token allowance. Only a successful closing answer removes the pause notice. A later
edit, another unfinished draft, or insufficient closing allowance still requires a pause.
A tool call, provider failure or rejected cost admission during that closing attempt
persists the pause receipt and completes the turn. Cancellation keeps its normal abort behavior.
Automatic turns retain their own input, output and call allocation; a closing
answer never extends that allocation.

At a bound with unfinished work, Gustav completes the current tool, skips remaining authoring tools
in that response when the repair allowance is spent, and ends with a short
persisted receipt in the chat. Assistant renders it in English or German as one
neutral notice: one sentence says Gustav is taking a break; a quiet line names
the reason (the same problem repeated, the step limit or the work allowance)
and whether a draft or version is saved. The pause has no checklist.
The receipt contains counts, so it does not
invent a saved version's number. This summary comes from settled tool results,
not model prose; a later draft edit invalidates earlier passing checks. No
additional model call writes the notice. Saved results and the server-held
draft remain available. The receipt describes the state at the stop, rather
than promising indefinite draft retention. Forks omit this conversation-bound
receipt because they do not copy its draft. **Continue** starts a new turn through the normal
message send path only after a click; rendering, reconnecting and reloading
never resume work. The action is disabled during other work and while sending;
a failed send keeps the notice with a retry explanation. Sending, failure and
temporary blocking use the quiet line's reserved space, keeping the card and
its action in place. On narrow chat columns the action fills the row below
the text and remains neutral with an outline in every width. Its place stays
reserved while the receipt belongs to the newest turn, including before turn-end.
A newer message or turn makes the receipt historical and releases that space;
a historical pause offers no continuation action. Stopping does not
submit or activate the draft. Hosts of `createAiChatTimeline` provide localized
presentation with `AiChatActions.renderCodeAuthoringStop`, whose reactive third
argument reports whether a newer message or turn has superseded the receipt, and use
`useAiChatActions()` from `@k2b/cloud/ai/ui` for the shared continuation action.
Worker recovery restores provider usage and check failures for the whole turn,
including archived messages. Missing provider input usage reserves 64,000
estimated tokens per call on recovery, rather than spending the entire turn
allowance. Steering does not refill this safety budget.

These are authoring limits, separate from the configured Assistant cost
allowances, which still apply to every provider call. The F7 per-attempt and
daily AI allowances apply to AI invoked **by saved Code**. They do not fund
Gustav's interactive authoring, and an unpriced model supplies no conversion
from those monetary allowances to authoring tokens.

The attempt allocation uses the default 30-minute turn and the provider's
60-second first-byte timeout as reference windows: one call and the existing
two malformed-response repair attempts per window give `30 × 3 = 90` attempts.
This is an operational capacity allocation; streaming calls can take longer or
shorter than a minute, and the configured turn deadline still applies. Models
without an effective cost limit receive 90 half-reference-window inputs: `90 × 64,000 =
5,760,000` tokens. A half-window also estimates a recovered call without usage
and reserves room before compaction, whose source is bounded to 60,000 characters.
The repeated-error allowance remains an initial attempt plus two retries.
The token allowance is lifted only when `aiQuotas.assertAllowed` confirms a finite
cost limit without bypass for the executed model and subject. Disabled cost limits,
unlimited grants, bypasses, free models and missing prices retain the 5,760,000-token
allowance. A missing turn trigger follows the person allocation, including service
accounts and agents acting for a delegated user; review revisions do too.

After a successful check of a Code's draft, later requests replace its earlier
SDK dumps with a short reload note. The complete results stay in conversation
history. Gustav can request fresh signatures when editing again. Normal model
compaction remains available for earlier turns and smaller context windows,
subject to the same authoring allowance. Authoring asks for compaction when
history exceeds the half-window reserve, so a model with a large window does
not wait until history alone exceeds the turn allowance. There is no separate fixed request
ceiling that could permanently block a long conversation. The representative
context regression fixture pins requests below the 32,000-token planning size.

### Transient provider failures

A chat turn, including one that runs scheduled or in the background, repeats a
model call that failed before the model produced any output because of HTTP
408, 409, 425, 429 or 5xx, a lost connection, or a provider first-byte or idle
timeout. It retries at most twice. The wait follows the provider's
`retry-after-ms` or `Retry-After` header, otherwise 1 and then 4 seconds. A
requested wait over 60 seconds, or one that would end after the turn's run time
limit, is not started; the turn then fails as `model_unavailable`. Stop ends a
wait at once.

A failure after the call streamed text, reasoning, or a tool call still ends
the turn, because streamed output cannot be taken back. Context overflow goes
to compaction, and other errors fail the turn without a retry. Each attempt is a
separate provider call with its own admission, quota check and
[usage record](/en/docs/ai/usage-and-feedback#read-the-report).

While a call waits, the stream sends `provider_retry`. The controller marks the
active turn with `providerRetry: true` until its next event. A state snapshot
never carries it; the controller keeps the mark through a snapshot at the
retry's own position, so subscribing again during a long wait does not end it.
Meanwhile the work line of the live turn in the chat timeline
of `@k2b/cloud/ai/ui` reads **Reconnecting** and its clock stands; a turn
without a work line yet shows a **Reconnecting** row at its end. `cld assistant`
prints `model: reconnecting`
to standard error or writes a `provider_retry` JSONL line. An `assistant` CLI
plugin from an earlier release stops following the turn at this event; see
[Conversation streams announce provider retries](/en/docs/reference/deprecations-and-migrations#conversation-streams-announce-provider-retries).
Each retry logs the warning `AI provider call retried` under `ai:executor` with
the retry number, the wait, and the failure kind and message.

### Conversation completion

`AiConversation.done` is a nullable override: `true` means finished, `false`
keeps the chat active, and `null` uses automatic completion after seven days
without use. `isDone` exposes the effective result; `lastUsedAt` tracks opening,
reading, new turns, and delivered messages independently from metadata updates.
Queued, running, and waiting turns prevent automatic completion.

`PUT /api/ai/conversations/:id/done` accepts `{ "done": true }`,
`{ "done": false }`, or `{ "done": null }`. Only the owner can change it;
explicit completion while a turn is active returns 409. New turns clear an
explicit finished choice to automatic, but preserve explicit active choices.
Completion preserves history, files, access, and pinning; it is separate from
archiving. The migration preserves previously finished chats as `true`.

List and page filters `done=true|false` use the effective state. Omitting the
filter includes both states. The sidebar returns all active chats without a
per-project or pinned cap; finished chats remain paginated. Time-based state is
recomputed on reads without a background job or destructive archival.

`aiConversations.getLatestTurn` reads the newest turn for an already-authorized
conversation, including its model profile; it does not authorize access itself.

Pinned chats always remain active, overriding explicit or automatic completion. Unpinning reveals the underlying completion choice again. The sidebar hides the Done action for pinned chats; pinning and unpinning are available directly in the chat preview.

## Optional Assistant quotas

Direct interactive Assistant submissions check optional cost allowances before
consuming the draft or promoting a queued message. Each subsequent direct model
round checks again. API rejection uses HTTP 429 with `quota_exhausted` or
`quota_usage_unknown`; model access is still checked independently. A blocked
person queue head retains its content and attachments for later dispatch.
Automation queue entries fail permanently on a quota refusal and release their
place. Already
running provider calls may finish and exceed the allowance.

The feature is disabled by default and does not limit generic application AI,
workflow or background inference. See [Assistant limits](/en/docs/ai/usage-and-feedback#set-assistant-budgets)
for accounting, wildcard precedence and reset behavior.

## Register host-owned tools

The process that owns the AI worker can pass `tools: readonly AiRuntimeTool[]`
to its first `startAiRuntime` call from `@k2b/cloud/ai/runtime`. These tools
join default Assistant turns; a matching name replaces that default tool.
The conversation's fixed `allowedTools` ceiling still applies, and deferred
tools use the existing `load_tools` discovery. Later reference-counted starts
do not replace the worker's configuration. Custom tool sources are unchanged.

This advanced host seam lets Core register its permission-aware Code services
without importing application contracts into the platform. Every tool must
recheck its own authority. `resolveAiCapabilityActor` from `@k2b/cloud/ai`
resolves the current conversation owner's user-backed session authority from
a persisted actor and the conversation store, including account status and
mobile-session limits. It is for the trusted runtime host, not an application
credential exchange. `createCodeSourceTool` from `@k2b/cloud/ai/tools` exposes a retained chat/Project
file tool through its authenticated transport.

For a result that starts no model turn, trusted hosts share
`appendAiBackgroundMessage(db, { conversationId, text, meta? })` from
`@k2b/cloud/ai/runtime`. Call it only inside an authorized transaction holding
the destination conversation's row lock. It appends the assistant message and
marks the conversation unread. The host owns idempotency and notification
recovery in that same transaction. This helper is for host-authored notices.
Code writes through `ai.chat.send`, which always admits a normal chat turn.

Trusted hosts may pass their open database transaction as the second argument
to `aiConversations.submitChatTurn(input, db)` to commit a turn and a
host-owned receipt together. Hold the authorized conversation lock first and
enqueue with `enqueueExistingAiTurn` only after committing. Core uses this seam
for queue promotion. `runConfig.writerOrigin` attributes the writer; names and
links are resolved when displaying it. It grants no authority. The separate
`runConfig.turnTrigger` records the immutable initiator (`person`, `automation`
or `chat`, plus stable ID). The trusted host sets both fields. Queue promotion,
resume and `code_run` retain the trigger. Retry and edit start a new turn from
the current actor: a user actor gets a person trigger; other actors omit it and
keep person budget limits. A plain retry keeps the writer, while editing makes
the message the person's own. The send receipt stays, but Code budget attribution
is cleared. For send authority, the chain rule reads only the recorded
`turnTrigger`; a missing trigger never grants person-initiated send authority.
`sourceRestricted` retains a limited entry point; app sessions and source chats with `allowedTools` cannot use
`send` to widen authority. `runConfig.send` identifies the accepted queue entry
and its account-scoped idempotency key, independently of the queue's personal
author field.
The optional host-owned `runConfig.codeOrigin` is copied to the user message
and turn record for attribution; it grants no tool authority.

## Host admission and terminal bookkeeping

The first `startAiRuntime` call from `@k2b/cloud/ai/runtime` can register
`beforeChatTurn: AiChatTurnAdmission` and `onSweep`. The admission callback runs
after current model resolution and access validation, before any model request.
It receives `turnId`, `conversationId`, `leaseOwner`, the persisted `runConfig`
and the executed `profile`, plus the execution `signal` for turn cancellation. The host must fence its transaction against the
current running turn lease. A Code-attributed turn without this callback fails
closed. Core uses it for policy and whole-turn daily cost reservations.
The callback may return `{ systemPrompt }`: host-owned instructions appended
to this attempt’s prompt before its first model request. They are rebuilt on
resumption and do not enter stored history. Core uses this for the current,
authorized page links of Code associated with the chat. Its optional page read
uses the standard 10-second request read budget and the execution signal;
failures warn and continue without this additional context. The full page
instruction is bounded by the existing 32 KiB Assistant place-context envelope,
with complete entries and a count of omitted pages.

`onTurnFinalized` runs after durable completion. `onSweep` independently recovers
host bookkeeping when a terminal callback was missed, even if the platform sweep
fails. Callbacks must be idempotent across worker retries and process restarts.
`AiTurnFailure` carries a stable public turn-error code and a private diagnostic
message. The exported `AUTOMATION_TURN_BUDGET` defines the shared 192,000-input,
12-call and 12,000-output allocation, including retries and compaction; it grants
no authority.

The host installs `runConfig.inferenceBudget` in the same fenced transaction as
its durable cost reservation. Provider admission rereads this snapshot under
the existing accounting lock. It binds model identity, prices, context/output
ceilings, total input and call allocation. All inference attributed to that turn
shares it, including structured/vision tool attempts; output is clamped to the
reserved ceiling and unreserved models fail before dispatch. Core preserves the
framework's source-turn attribution on nested generation/decision capabilities.
Callers must retain that attribution when starting related inference. The
ordinary unbounded-person accounting path keeps its existing statement count;
a bounded turn adds one aggregate per provider attempt, never per stream event.

Code-attributed turns pin nested inference to the admitted model and output
ceiling. A tool that needs another profile, or System One's uncapped output,
is refused before inference rather than spending outside the reservation.
Answering a choice starts a new person-triggered turn; its Query uses that new
turn's invocation lease. Background memory learning skips turns with a bounded
inference allocation, so it cannot reopen their ended reservation. Normal personal calls without a source
turn keep the optional nested-invocation lease behavior.

Host admission failures use general `host_budget_*` or `host_rejected` codes.
The host supplies the final localized `AiTurnFailure.userMessage`; Cloud stores
it as `AiTurnError.message` and renders it without interpreting host domains.
A failed call without response bytes uses zero or its recorded estimate; other
unknown usage stays fail-closed. Provider diagnostics remain log-only. Third-party hosts can supply their own
explanations through the same contract.

### Idempotent empty-chat creation

Core's `ai.chat.create` Action and `POST /api/ai/conversations` share
`aiConversations.createConversation`. A stable `requestId` claims one durable
`ai.conversation_creations` receipt per owner, with normalized input hash.
Concurrent retries return the same active chat. Conflicting input fails;
archiving or deleting the original never creates a replacement.
`AiConversationCreationError` from `@k2b/cloud/ai/runtime` distinguishes
`conflict` from `unavailable` for hosts translating transport errors.
Core derives a domain-separated UUIDv8 from owner, operation and idempotency key;
it checks full source authority and current Project read access before invoking
the service. Creation writes an empty chat and does not submit an AI turn.
