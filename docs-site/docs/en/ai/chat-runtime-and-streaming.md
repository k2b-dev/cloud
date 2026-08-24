---
title: Chat runtime and streaming
navTitle: Chat and streaming
section: AI
order: 1030
description: Create personal conversations, save composer drafts, and stream agent work.
tags: [ai, chat, streaming]
updated: 2026-08-23
---

# Chat runtime and streaming

Core mounts one authenticated conversation API at `/api/ai`. Conversations do
not belong to an application and have no primary resource. Assistant renders
the standard GUI; another application may create a conversation and redirect
the user there.

## Create a conversation draft

```ts
import { launchAssistant } from "@valentinkolb/cloud/ai/browser";

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

The runtime leases queued turns, recovers interrupted work, and sweeps stale
turns. User approvals and frontend-tool responses are durable continuation
points, not failed execution attempts. If their queue message is lost, the
sweep re-enqueues the exact action still waiting in the persisted turn
snapshot. Actual repeated worker failures remain bounded and finish the turn
as failed instead of leaving it active forever. Set concurrency for the
deployment, not per request.

## Stream state

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
for a low-level or CLI client. Solid applications should use
`createAiChatController()` from `@valentinkolb/cloud/ai/solid`; it uses SSE by
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

Core mounts the server-only multiplexed route at `/api/ai/live`.
`migrateCloudAi()` installs the transactional
invalidation outbox and persistence triggers; `startAiRuntime()` dispatches the
outbox. A committed AI write and its invalidation therefore cannot diverge.
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
