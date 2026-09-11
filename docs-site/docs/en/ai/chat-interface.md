---
title: Chat interface
navTitle: Chat interface
section: AI
order: 1070
description: Present conversation state, tools, approvals, and failures with the shared chat controller and components.
tags: [ai, ui, solidjs]
updated: 2026-08-22
---

# Chat interface

Compose Cloud chat from two layers:

- `@k2b/ui` owns the generic timeline, message shell, composer, attachments,
  model selection, commands, context usage, loading, and accessibility.
- `@k2b/cloud/ai` owns the controller, session protocol, persistence,
  tools, approvals, files, retry, fork, and steering policy.

Cloud adapters project protocol state and payloads across that boundary. There
is no second Cloud-specific chat component set.

## Compose a Cloud chat

```tsx
import type { AiPublicModelProfile } from "@k2b/cloud/ai";
import { createAiChatController } from "@k2b/cloud/ai/solid";
import {
  AiChatActionsProvider,
  aiChatModelOptions,
  aiComposerSendInput,
  createAiChatTimeline,
} from "@k2b/cloud/ai/ui";
import { Chat } from "@k2b/ui";
import { createSignal } from "solid-js";

export function ItemChat(props: {
  itemId: string;
  models: AiPublicModelProfile[];
  selectedModelId: () => string;
  selectModel: (id: string) => void;
}) {
  const chat = createAiChatController({
    baseUrl: `/api/inventory/ai/items/${props.itemId}`,
    trackViewedState: true,
  });
  const [draft, setDraft] = createSignal("");

  const Conversation = () => {
    const items = createAiChatTimeline({
      messages: chat.messages,
      activeTurn: chat.activeTurn,
    });

    return (
      <Chat>
        <Chat.Timeline
          items={items()}
          loading={chat.loadingConversation()}
          hasMore={chat.hasMoreHistory()}
          loadingOlder={chat.loadingOlder()}
          onLoadOlder={chat.loadOlderMessages}
        />
        <Chat.Composer
          value={draft()}
          onValueChange={setDraft}
          models={aiChatModelOptions(props.models)}
          selectedModelId={props.selectedModelId()}
          onModelChange={props.selectModel}
          state={chat.runStatus() === "stopping" ? "stopping" : chat.running() ? "running" : "idle"}
          onSubmit={(input) => {
            const payload = aiComposerSendInput(input);
            return input.intent === "steer"
              ? chat.steer(payload.message ?? "")
              : chat.send({ ...payload, modelProfileId: props.selectedModelId() });
          }}
          onStop={async () => {
            await chat.abort();
          }}
        />
      </Chat>
    );
  };

  return (
    <div class="k2b-ui">
      <AiChatActionsProvider
        actions={{
          onApproval: async (request, input) => {
            await chat.respondToApproval(request, input);
          },
          onFrontendToolResult: async (request, result) => {
            await chat.submitFrontendToolResult(request, result);
          },
          fileUrl: chat.fileContentUrl,
        }}
      >
        <Conversation />
      </AiChatActionsProvider>
    </div>
  );
}
```

Keep the `k2b-ui` scope on the nearest stable application root and import
`@k2b/ui/styles.css` once in the application stylesheet.

The controller exposes:

- conversations and active conversation state;
- messages, active turn, and stream status;
- history and timeline loading;
- send, steer, abort, retry, fork, and compaction;
- approval and frontend-tool actions;
- file URLs and file counts;
- one error state for the active chat.

The controller consumes a transport-neutral conversation event stream. It uses
the conversation SSE route by default, so application-owned chat endpoints and
CLI-compatible integrations keep working unchanged. Core's Assistant injects
the shared AI live connection instead: changing chats replaces only its turn
channel, while the workspace WebSocket and user-wide invalidation channel stay
alive. Both paths use the same projection, reconnect snapshot, and action
deduplication behavior.

## Attach Cloud resources

Treat a Cloud resource like another composer attachment: keep its structured
`ref`, plus optional `title`, `icon`, and root-relative `href` presentation
metadata. `aiComposerSendInput()` preserves that data for the conversation
draft, and sent messages render it as an attachment chip. A supplied `href`
links the chip back to the owning application.

Assistant also links every Cloud resource it mentions in an answer when the
resource result or supplied context provides an exact open or edit URL. It
never constructs a Cloud resource URL from an ID.

The attachment does not copy resource contents into the draft and does not
grant access. The model receives only the resource reference and presentation
metadata, and must read the resource through the owning application's
authorized capability. Attachment metadata and resource data returned by that
capability remain untrusted context. Editing or retrying a user message
preserves the resource attachment while copy actions expose only the visible
user text. Retrying a message while its turn waits for an approval or another
user action aborts that pending turn and replaces the conversation branch.

The Assistant composer accepts files and screenshots from paste through the
same bounded attachment pipeline as selection and drag-and-drop. Short text
keeps native textarea paste behavior. A paste of at least 8,000 characters, or
one that would exceed the 20,000-character message limit, becomes a normal
`text/plain` conversation file with a unique internal `pasted-<short-id>.txt`
name. The composer presents these files as **Pasted text** instead of exposing
that storage name. Bounded text files expose **Show in text field** and remain
recoverable after draft autosave or reload. Resource-aware
paste accepts only the versioned clipboard payload for the canonical Cloud URL
derived from the configured `app.url`; it then resolves the current capability
reader and authorization before attaching the resource.

A turn can attach up to 16 files or Cloud resources. The composer keeps them
on one horizontal row and scrolls that row instead of growing into multiple
attachment rows. Repeated same-named uploads receive distinct durable paths.

`Chat.Composer` submits a draft entered during an active response as `steer` by
default. Set `runningSubmitIntent="queue"` when the application owns a local or
durable follow-up queue, then handle the `queue` intent in `onSubmit`. The
shared composer only reports intent; queue ordering, persistence, delivery,
editing, and deletion remain application policy.

## Show meaningful states

Distinguish:

- connecting from generating;
- waiting for approval from running;
- stopping from stopped;
- failed from aborted;
- an empty conversation from a loading conversation.

Keep the Stop action available until the server accepts the abort.

Render tool input and output as data. Do not inject model text as HTML.

Compact capability rows use the saved capability title, app icon, and optional
accent while running and on failure. A successful provider-authored `summary`
replaces the title as one escaped plain-text result row without a disclosure or
duplicate raw data. Semantic links remain direct row actions; raw resource refs
remain structured result data rather than user-facing labels. Results without
a summary expose their input and response details.
Expanded generic disclosures show
JSON-like payloads as structured data previews with at most eight visible rows
and an optional raw view. Expanded data surfaces span the available message
column. Built-in discovery, Skill, Help, Project, file, calculation, image, web,
memory, and interaction tools use Cloud-owned readable renderers and omit raw
input or output that adds no user value. Imported web files show the source's
first-party favicon, filename, domain, size, media type, final source URL, and
conversation path; the web-download icon is the favicon fallback. Capability
failures show their canonical bounded error directly in one danger row without
repeating large inputs or responses. Unknown tool failures retain the generic
technical disclosure and open it immediately.
Rejected approvals collapse to one readable result row without input or
response details; they are user decisions rather than tool failures.
Approval prompts additionally show the owning application's saved name. The
saved snapshot keeps history readable when an app is
temporarily unavailable or later changes its registry metadata; ordinary Nessi
tools keep the generic tool presentation.

Discovery result disclosures use flat, single-line rows with a readable title,
truncated description, and app label instead of enclosing the list in another
surface. Loaded tools use their catalog titles.
While a loop is active, Assistant renders its blocks in their saved order. Once
the loop completes, it moves tool calls, reasoning, compaction, and every text
block except the final response into one collapsed **Worked for ...**
disclosure. Presented files remain directly visible as standalone results. Failed work opens the
disclosure immediately with danger treatment, and an explicit user disclosure
choice remains stable across live timeline updates.

Generic tool rows and disclosures use `Chat.Activity` from `@k2b/ui`. Cloud
only supplies protocol-derived labels and specialized bodies such as web search
results, first-party favicons, structured data, and approval controls. Keep
those domain renderers in Cloud instead of duplicating the shared activity
shell. Use `defaultOpen` for the initial disclosure policy; hosts that must
preserve a person's choice across a remount can control it with `open` and
`onOpenChange`.

An active response always uses the shared streaming state of `Chat.Message`,
including before the first model block arrives. It renders the minimal
three-dot progress indicator; do not add a separate generating activity or
label. Active tool rows set `busy` on `Chat.Activity`, which moves a quiet
text-color-to-transparency shimmer across the tool icon and title instead of
adding another loader or pulsing the accent color. Reduced-motion clients keep
the same text static.

Approval prompts span the available message column and lead with the owning
application's name and icon. The primary control names the concrete action;
review labels are emphasized and explanatory copy appears only when it adds
information beyond that action name. Approval content stays on a neutral
surface and the decision controls sit in a separate footer at the bottom-right.
The action is a split button whose
**Details** menu item renders validated arguments in a separate full-width
structured-data panel below the prompt. Details are technical verification,
not a substitute for consequence-critical review content in the card itself.

## Handle frontend tools

Pass approval, frontend-tool, retry, fork, message-feedback, and file handlers through
`AiChatActionsProvider`. Rich Cloud blocks remain Cloud-owned JSX inside the
generic timeline.

Applications hosting code-triggered approvals can render the same public
`AiTurnBlockView` from `@k2b/cloud/ai/ui`, inside `AiChatActionsProvider`.
Provide an active tool block in `awaiting_approval` state with the server-reviewed
message, details, and `allowAlways` value. Route `onApproval` back to the
permission-aware server operation. This renderer does not authorize execution:
the server must correlate the request to its user and resource, enforce current
permissions, and reject changed or already-resolved requests. Use this shared
view in a chat or app dialog rather than inventing another approval interaction.

Assistant messages may expose helpful and needs-improvement actions. Positive
feedback saves immediately. Negative feedback collects one or more stable
reason codes or an optional short comment in a shared prompt. The rating is
private owner metadata: it is not sent back to the model and does not alter the
conversation transcript.

The controller claims each call once, runs the handler, and sends the result
back to the turn. Show interaction tools only when the relevant application
view is present. After the server accepts a survey answer, replace the form
with a normal user message: show each question as small context above its answer. Use option
labels for choices and retain free-text line breaks. These messages stay in
chronological order between the assistant's outputs, remain visible outside
**Worked for ...**, and render the same way after reloading the conversation.
The answer remains a tool result in storage and in the model protocol; the
presentation does not create another user turn or expose message retry/edit
controls for that answer.

Keep the assistant's progress indicator after an accepted answer while it
continues. Pending or failed submissions retain their interaction state; never
flash the empty form again between acceptance and the next stream event.
Accepted frontend-tool and approval actions must not regress when a stale live
event still contains the pending block.

The built-in long-form text interaction presents every draft in the existing
`@k2b/ui` `MarkdownEditor`; plain text remains valid Markdown source. Its
unsubmitted value is deliberately component-local: reload may discard edits
and restore the model's original draft. The user can accept the edited source
or send a separate change request so the model can return a replacement draft.
Do not add a second draft persistence layer to the chat controller. Show the
submitted source or feedback in a bounded disclosure without treating either
result as authorization for a later domain write.

Server tools remain the default for domain access.

See [Observability](/en/docs/operations/observability#operate-ai-workloads) for
runtime monitoring and production checks.

## Advertise connected client tools

A frontend handler alone does not advertise execution to the model. Pass
`clientToolIds` to `createAiChatController` and register matching
`frontendTools`. The controller forwards only IDs that have a handler. Supported
IDs are `local_bash`, `code_run`, `code_inspect`, `code_interact`, `code_stop`,
`code_open`, and `code_export`; duplicates and arbitrary tool names are rejected. Clients without an execution host should omit this option.

Handlers receive `name`, `args`, `callId`, `turnId`, and `conversationId`. Capture
that conversation identity for asynchronous work instead of using whichever
chat is active when the work finishes. The controller submits the result to the
originating conversation. Return JSON-compatible, bounded results.

The six `code_*` client tools each have a flat input schema and are deferred:
advertising a handler makes the tool discoverable, but the agent must call
`load_tools` before using it. `createCloudAiCodeTools` supplies their definitions
through the AI runtime tool exports. `CODE_RUNTIME_TOOL_NAMES`,
`parseCodeToolInput`, and the internal `CodeRuntimeInput` envelope are exported
from `@k2b/cloud/ai/browser` and `@k2b/cloud/ai` for host integrations.

`code_run` accepts the app `id` and optional chat `inputPaths`, takes a fixed
snapshot of current source, and returns a run ID and compact state. There is no
required source revision. `code_interact` accepts a control ID or the pending
modal ID, including structured answers. `code_open` never starts the visible
app. `code_export` copies a captured file into the originating chat.

Assistant exposes direct server tools: `code_create`, `code_read`, `code_write`,
`code_remove`, `code_list`, `code_history`, `code_update`, `code_fork`,
`code_publish`, `code_versions`, `code_restore`, and `code_sql`. These are
deferred built-ins with flat inputs, not application capabilities.
`CODE_SOURCE_TOOLS` from `@k2b/cloud/ai` supplies their shared input contracts.
Core forwards each operation to Assistant using an operation-bound invocation.
The server derives the chat context and checks current user, conversation,
Project and resource permissions. GUI and CLI use the same resource services.
Writes reuse the platform replay guard; uncertain calls are not repeated.
`capabilities.run` remains available for other applications, not these tools.
Writes immediately persist one
file, preserve other files, and report compilation diagnostics without rejecting
incomplete source. Execution still requires compilable source. History remains
available internally; file writes need no revision argument. Concurrent writes
to the same path use the last saved content.

The host owns isolation, artifact permissions, input file authorization,
cancellation, and execution deduplication. The controller's in-memory call
tracking does not provide an exactly-once guarantee across tabs or reloads.
Assistant uses a server-side claim and never replays an uncertain execution.
Its test runs are separate from visible apps and persistent user data. A missing
browser cannot perform execution; do not report an unexecuted test as successful.

### Assistant apps and browser work

The Assistant **Studio** navigation sits above Personalize and opens a full-width
gallery. Each tile has a large icon, publication badge, and direct Start action. Tile menus provide editing, publication, access, and copying;
permissions use the Cloud editor in a dialog. Standalone URLs show the runner
without an intermediate management page. Artifacts are independent of chats. Cloud `auth.access` grants are linked
through `assistant.artifact_access`: `read` is presented as **Use**, `admin` as
**Manage**. Existing artifact `write` grants migrate to `admin`. Person, nested
group, and authenticated-user grants use the shared Cloud principal resolver.

Admins see the working draft and can publish a specific source revision. Users
only see published source and metadata; history and unpublished revisions require
admin permission even through direct API calls. Saving never publishes. Publishing
checks compilation and the expected draft revision, then atomically selects the
publication. A concurrent save causes a conflict. Unpublishing removes the app
from user discovery; code already loaded into a browser cannot be recalled.

Edit creates an unsent chat draft with the artifact resource reference. Forking
copies only the current publication into a new private artifact, preserving its
source provenance but not grants, chat history, or local data. All admins share
one working draft. Source-editor saves reject stale revisions; agent file writes
replace that file, so coordinate overlapping edits instead of assuming branches.

Assistant displays executable app references in a dedicated Apps context section,
with current permission-checked titles. Selecting an app opens it beside the chat
without starting it. Generic references do not repeat these apps.

Automatic frontend tool work uses the `waiting_for_browser` conversation status.
It does not show the human-attention hand. A selected chat shows running progress;
another chat can indicate that browser execution is waiting. Approval and human
input still use `needs_attention`. Running-list filters include browser work.

### Open chat content beside the conversation

The context panel is the entry point for apps, files, images, sources, project
knowledge, and scheduled tasks. Compact sections show a preview; View all opens
a searchable overview beside the conversation. Apps appear as cards with their
name and optional description. The overview includes apps referenced by that
conversation, rather than a global library.

The workspace uses rounded, horizontally scrolling tabs. Each tab has its own
close control. The plus menu opens chat content overviews; it does not create
or start an app. Opening the same resource selects its existing tab. Switching
tabs preserves running apps and unsaved source edits. Closing an unsaved editor
still asks for confirmation. On small screens, Chat returns to the conversation;
content can be reopened through its context entry.

File and source-code browsing happens in the workspace. External references
continue to open their destination separately. Confirmations remain dialogs.

The context column responds to the available width of the chat pane, including
when a neighboring workspace is resized. Below 56rem it is hidden and the chat
header exposes an Open (+) menu, even with no workspace tabs open. This menu and
the workspace tab menu offer the same chat apps, files (including images and
voice inputs), sources and references, project knowledge, and scheduled tasks
when available. Hiding the column preserves its loaded context and the composer
draft; it does not unmount the chat.

App consoles start collapsed. The Console button toggles the output without
stopping the app; a new runtime or startup error opens it automatically. Source,
Restart, and Stop remain available in the footer. During restart, the reload icon
spins and the button is disabled; Stop can cancel a pending start.

Running Assistant apps keep their inputs when code is saved. After tool activity,
a source-editor save, or window focus, the workspace checks for a newer version
and offers an explicit restart. Starting or restarting fetches current code;
agent test runs are separate from the user’s app. Status errors display the
description supplied by the app and clear it when the app returns to ready.

### Studio publication versions

Sharing and publication are independent. Publishing a personal application never
adds access grants. **Start** runs the current publication; before the first
publication, administrators can start their working application normally.
Use-level users only receive the latest publication, never working source or
historical versions. There is no preview mode.

Each publication receives a sequential number, author, date, and required change
note. The agent can use `code_publish`, `code_versions`, and `code_restore`.
Restoring copies published code, title, description, and icon into a new working
revision and a new latest publication in one transaction. Its automatic note is
"Restore version X". Historical publications and user data remain intact. Source save revisions and publication
numbers are separate. Expected working revisions prevent stale publish/restore.

Administrators can select a historical publication in the runner's **Versions**
dialog and start it for themselves without changing the version other users get.
Starting a different version restarts that local session. **Restore**
atomically appends a new latest publication and updates the working source, with
an automatic "Restore version X" note. It preserves history and user data.
The compact Versions dialog sits in the bottom console toolbar. Before the first
publication, it offers a Publish action.
`code_update` changes working title, description, or Tabler icon. The code-mode
skill includes a short icon list. The compact Studio cards expose publication
status and put their action menu at the top right.

Visible running sessions check for updates every 30 seconds and on window focus,
with at most one background check in flight. Updates offer a restart instead of
discarding current inputs. Historical selections stay on their selected version.
