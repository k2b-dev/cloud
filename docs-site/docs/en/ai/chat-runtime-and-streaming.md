---
title: Chat runtime and streaming
navTitle: Chat and streaming
section: AI
order: 1030
description: Create personal conversations, save composer drafts, and stream agent work.
tags: [ai, chat, streaming]
updated: 2026-09-05
---

# Chat runtime and streaming

Core mounts one authenticated conversation API at `/api/ai`. Conversations do
not belong to an application and have no primary resource. Assistant renders
the standard GUI; another application may create a conversation and redirect
the user there.

Interactive submissions and retries enforce the caller's
[Assistant model access](/en/docs/ai/models-and-providers#restrict-a-model-in-assistant).
The model list and status return only permitted models. A denied explicit model
selection returns HTTP 403 before a retry changes the conversation.

## Queue follow-up messages

Add a client-generated UUID `queueId` to `POST /api/ai/conversations/:id/turns`
together with the saved `draftRevision` to queue a follow-up. Acceptance consumes
that draft revision and preserves its text, resource references, model selection,
and exact attachment bytes. Repeating the same `queueId` is idempotent, including
after the message has started. A later composer draft remains independent.

Each conversation accepts up to 32 pending or failed messages. Queued attachment
snapshots share a 250 MiB budget. The existing turn worker processes messages in
acceptance order, one active turn per conversation. Queues survive navigation,
reloads and worker restarts. Completion, failure or cancellation of a turn allows
the next queued message to start; a dispatch failure keeps the failed entry at the
head until the user retries or removes it. Approval waits keep the current turn
active and do not advance the queue.

The owner-authorized queue API provides:

- `GET /conversations/:id/queue`: ordered pending and failed entries.
- `PATCH /conversations/:id/queue/:messageId` with `{ text }`: edit queued text
  while retaining attachments and resource references.
- `DELETE /conversations/:id/queue/:messageId`: remove an entry that has not started.
- `POST /conversations/:id/queue/:messageId/retry`: retry a failed dispatch.

All paths above use the `/api/ai` prefix. Editing or deleting races safely with
promotion: once an entry becomes a turn, the queue endpoint returns not found.
Normal submissions cannot overtake the queue. Chats with pending entries cannot
be archived or marked done and do not become done through inactivity.

## Observe work across conversations

Sidebar snapshots include a compact `activity` projection: completed and total
task counts, the current task, and the last tool label. Cancelled tasks do not
count toward progress. Tool arguments, outputs and conversation history are not
included in this projection. The same owner checks apply to initial and live
reads, and live updates do not change activity-based ordering.

The existing live connection invalidates this snapshot on task and tool changes.
Text tokens alone do not invalidate the sidebar. Reconnection reloads authorized
state before acknowledging its cursor; no per-conversation socket is required.

## Diagnose runtime failures

Use the existing Core log and trace views. Filter logs by `ai:runtime`,
`ai:message-queue`, `ai:executor`, `ai:files`, `ai:transcription`, or
`ai:live-routes`.
Queue dispatch errors carry `conversationId`, `messageId` and
`queue_dispatch_failed`. Heartbeat, recovery and completion-publication warnings
carry conversation and turn IDs. A heartbeat warning is emitted once per failure
streak; recovery uses the existing durable turn state.

Upload storage failures emit `file_upload_failed` with the conversation ID and
error type. Tool-audit write failures are warnings with turn and call IDs. Expected audio
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

The structured composer draft contains text, exact stored-file versions, and
zero or more Cloud resource refs. Save it with `PUT
/api/ai/conversations/:id/draft` and an `expectedRevision`. Identical autosaves
are idempotent; stale writes return a conflict. Submit a turn with the returned
`draftRevision`. The transaction consumes and clears exactly that revision, so
text and attachments cannot drift between save and send.

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

The default tool source keeps discovery, Help, `fetch_file`, `read_file`, and
`view_image` available. Configured `web_search` and `web_extract` are also
always available together. `fetch_file` imports one exact public HTTPS source
into the conversation; it does not browse repositories, authenticate to a
website, or reach private network targets. Cards, surveys, the long-form text
editor, file writes and presentation, Markdown-to-PDF, and calculation load on
demand. Built-in usage hints remain in the system prompt even while their
schemas are deferred. These
tools provide no arbitrary code execution, host access, or network access
beyond the explicit web tools. See
[Tools and approvals](/en/docs/ai/tools-and-approvals).

The `text_editor` frontend interaction lets the model provide one complete
plain-text or Markdown draft for the user to revise. The browser presents both
formats in one Markdown editor. Unsubmitted edits are browser-local and may be
lost on reload; only accepted text or submitted revision feedback becomes a
durable turn action. Feedback asks the model for a replacement draft instead of
accepting the current source. Neither result saves a domain resource or
approves a later Capability Action such as updating or sending mail.

An interactive Assistant CLI turn may additionally request the fixed
`local_bash` client tool. It is not part of the default set: Cloud persists and
streams its calls but has no shell executor, and browser clients neither opt in
nor register a handler. See the local CLI boundary in
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
is checked again before execution; edits affect the next turn. The runtime still
treats a provider `stop` as
a completed turn; it does not infer unfinished work from model text or trigger
language-dependent automatic retries.

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
| `/conversations/:id/turns` | Start, steer, or stop work |
| `/conversations/:id/stream` | Receive the conversation event feed over SSE |
| `/conversations/:id/files` | Manage conversation files |
| `/live` | Multiplex browser invalidations and the visible conversation over one WebSocket |

The router also supports message retry, forks, compaction, pending tool
actions, conversation enrichment, and paged history.

Automatic compaction accounts for the configured output-token reserve. When a
single user request grows too large, it can summarize completed model rounds
inside that first loop. The newest two model rounds stay intact, and a tool call
is never archived separately from its pending result. Archived messages remain
available in the conversation history.

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
conversation workers, maintenance, scheduled chat tasks, and durable
continuations. Applications must not start a second AI conversation runtime.
They publish domain Capabilities, launch a personal conversation through
`launchAssistant()`, or use `runAiStructured()` for bounded server/workflow AI.

Interrupted work resumes from saved state. User approvals and frontend-tool
responses remain pending until answered; they are not failed attempts.
Repeated execution failures end the turn as failed. Set concurrency for the
deployment, not per request.

## Stream state

Assistant renders capability table presentation metadata in both web chat and
text-mode CLI output. The CLI shows up to 100 returned rows, shortens long cells,
and prints supplied result links. Additional rows or pages are marked; displaying
a table does not fetch more data. JSON and JSONL output retain their structured
format and do not include terminal tables. The Assistant summarizes findings and
completeness limits instead of repeating rows, unless the user requests them.

The conversation protocol is transport-neutral. Every subscription receives a
full authorized state snapshot and then ordered updates for messages, text,
tools, approvals, and turn completion. The runtime captures the retained-topic
cursor before loading the snapshot, so work that arrives while the snapshot is
loading remains in the ordered tail. Attempt and sequence numbers make replay
idempotent.

Each execution attempt starts with one atomic, server-ordered block baseline.
Resuming after an approval or frontend-tool response therefore keeps every
existing item in its persisted timeline position while new output is appended.
The same event feed backs both browser WebSockets and SSE. Use `parseAiSse()`
from `@k2b/cloud/ai/browser` for a low-level or CLI client. This
client entry point also exports attachment limits, `guessAiMediaType()`,
`isAiImageMediaType()`, the card, survey, text-editor, and local-bash input
schemas, and `CLOUD_AI_TEXT_EDITOR_MAX_CHARS`. These helpers do not initialize
Cloud server services. Import AI types with `import type` from
`@k2b/cloud/ai`. Solid applications should use
`createAiChatController()` from `@k2b/cloud/ai/solid`; it uses SSE by
default and accepts a supported conversation-stream transport when its host
already owns a shared connection.

Assistant uses one `/api/ai/live` WebSocket for two independent logical
channels: `ai.live` invalidates durable user projections, while `ai.turn`
carries only the currently visible conversation. Enhanced navigation replaces
the turn subscription without reconnecting the socket. Reconnect performs the
normal full refresh for invalidations and starts the visible conversation from
a fresh authorized state snapshot. The CLI and low-level consumers continue to
use `/conversations/:id/stream` over SSE.

The controller folds both transports into the same projection and exposes the
active conversation's history, send, steer, abort, retry, fork, compaction,
approval, and frontend-tool actions. Do not put conversation and Project lists,
metadata, Sources, files, scheduled tasks, Project context, or access changes
into turn events. Those are durable server projections and refresh through
[Realtime UI](/en/docs/frontend/realtime-ui).

Core exposes live updates at `/api/ai/live`. Committed AI writes invalidate
the affected views.
The browser still reloads each affected projection through its authorized HTTP
query before it advances the event cursor.

The connection is isolated by user, and its active conversation is
re-authorized periodically. Losing access ends that conversation channel;
invalid or expired authentication revokes the whole connection. Project context can be shared through
normal Cloud access grants, but each conversation remains owned by its creator
and only appears in that user's stream and queries. On reconnect, the route establishes a new head
cursor and the client refreshes every registered AI projection. This is the
authoritative recovery path when retained replay is insufficient.

Action responses are idempotent. Retrying the same response is safe and
re-enqueues its continuation; a conflicting response for an already resolved
call is rejected. On reconnect, the state snapshot reconciles durable action
responses before rendering, so resolved approval controls do not reappear and
plain browser tools are not executed again merely because the page reloaded.

Do not maintain a second client-side chat state machine.

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

The existing AI WebSocket publishes `conversation-dictations` invalidations,
not audio or transcript content. A database trigger creates the outbox entry
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

### Scheduled Code Mode

Scheduled turns can run Code Mode without a user tab. Core binds each call and
capability callback to the persisted turn and its confirmed task mandate.
Foreground activity in the same chat does not share the scheduled host. Task
revocation, expiry, revision changes and cancellation deny subsequent requests.
The normal capability dispatcher still checks current user access, fixed inputs
and action approval policy; remembered foreground approvals never authorize a
scheduled action. Always-approval actions remain unavailable.

Scheduled code supports computation, chat files, AI helpers, presentations and
exports, shared app storage, HTTP and RSQL. A task has one reviewed `grants` list:
capability query/action entries, `{kind:"http",fixedInput:{origin,url,method}}`
and `{kind:"database",fixedInput:{resourceId,operation,table}}`. All fixed fields
are optional; omitted fields remain unrestricted. HTTP origins match exactly,
not by suffix; URL restrictions match the full URL. Database operations match
exactly, so an operation-specific grant also needs a `connect` grant. Resource
permissions and the HTTP service's public-HTTPS/secret-binding checks still apply.
HTTP authority is rechecked against the stored request immediately before sending.
The same access review and task-detail presentation show all three grant types.

Tasks cannot open interactive dialogs, collect new secrets or use capability
binary streams. Missing grants return an error for repair in the normal chat.
AI helper usage is charged as background
work and attributed to the scheduled turn.

### Background Assistant tabs

The Assistant live connection uses `activity: "always"`. Hiding the browser tab
does not unsubscribe the active conversation or close its WebSocket. This does
not override browser suspension, operating-system sleep, reload, or closing the
tab. Agent Code Mode execution uses an Assistant-owned isolated Chromium host,
so changing or closing the user tab does not pause code or simulated UI actions.
The interactive Studio preview remains browser-owned. Opening an app, selecting
local files, entering secrets and answering approval prompts still need a user
client.

Code Mode source and runtime tools do not require confirmation. Source Actions
retain permission checks and idempotency. Browser execution claims resolve a
public short turn ID to the authorized active turn's UUID before persistence.
A duplicate claim cannot repeat an interaction. Host failures return
`kind: "host"` with `retryable: false`; agents should report them rather than
rewriting otherwise valid application source or retrying unchanged calls.

The execution host belongs to one Assistant process. Run this alpha with one
Assistant replica: temporary JavaScript state is not transferred between replicas
or recovered after a process restart. Durable call records prevent an uncertain
operation from being replayed. A new run is required after host loss. Startup and
health checks are bounded independently of the user's browser timers.

Complete active-turn snapshots replace the observed block baseline when their
attempt and sequence are current. Older snapshots cannot restore obsolete
streaming block IDs. Pending local steering remains visible until acknowledged.
In-attempt continuations publish a complete turn baseline before incremental
updates, so persisted and streamed representations do not appear together.

Conversation multipart uploads accept an optional `directory` form field
(default `/`). The normal path validation and reserved Project namespace apply.
Collisions receive a suffix; use the returned `file.path` rather than deriving
a path from the original filename.

Chat timing uses the durable user turn's wall-clock interval. Each model request
records its generation interval before tool execution; these measurements survive
client actions and executor resumption. Tool execution and approval/browser waits
use their durable audit timestamps. Overlapping phases are counted once. An older
or incomplete trace has no aggregate timing or token-rate estimate; the chat can
still display elapsed time from persisted messages. Live `message_saved` events
carry usage after each model response, before its tools finish, without rendering
a second copy of the active response.

### Run time budget

Administrators configure `ai.turn_timeout_minutes` in AI settings. The default
is 30 minutes; zero or clearing the field disables this run time limit. Values
must be nonnegative whole minutes. The worker snapshots the budget when it
first claims a turn. Later setting changes do not alter a claimed turn, including
lease recovery. Resuming after a human interaction uses that same configured
budget for its new running phase. Individual provider and tool timeouts and
worker leases remain independent, even with an unlimited turn budget.

An expired execution deadline ends the turn as failed with a time-limit message
and an instruction to continue with a new message. It is distinct from a user's
Stop action. Continuing does not automatically replay uncertain external calls.

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
queue head retains its content and attachments for later dispatch. Already
running provider calls may finish and exceed the allowance.

The feature is disabled by default and does not limit generic application AI,
workflow or background inference. See [Assistant limits](/en/docs/ai/usage-and-feedback#set-assistant-budgets)
for accounting, wildcard precedence and reset behavior.
