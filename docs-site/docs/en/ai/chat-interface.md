---
title: Chat interface
navTitle: Chat interface
section: AI
order: 1070
description: Present conversation state, tools, approvals, and failures with the shared chat controller and components.
tags: [ai, ui, solidjs]
updated: 2026-10-09
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

The controller consumes a transport-neutral conversation event stream over the
conversation SSE route, like the CLI; `streamTransport` replaces it for an
application-owned chat endpoint. Changing chats closes the previous stream and
opens one for the new chat, and every connection starts from a fresh state
snapshot, so a frontend tool runs once and a resolved approval does not
reappear. When the open stream of a running turn delivers nothing for 45
seconds, one worker lease, the controller subscribes again and continues from
the turn's saved state, so a lost update such as the end of the turn heals
within a minute. The wait starts with the stream's first event, so a slow first
snapshot is never cut off, and a stream that reconnects already starts from a
fresh snapshot. A turn that waits for an approval, an answer, or a frontend
tool is not silent; once the server accepts the action, the turn runs and is
watched again. When access to the conversation ends, the controller stops the
stream and shows, in the page's language, why the chat cannot continue,
instead of reconnecting. `refreshActiveConversation()` does the same and
resolves `false` when the chat is gone, so a caller does not retry it; an
answer that a newer refresh or opening of a chat overtook changes nothing.
Opening a chat that is gone shows the same reason. Reopening or refreshing the
chat, or acting in it, subscribes again; the error clears once the new stream
connects.

Lists, Sources, files, tasks, dictations, and Project context refresh through
[AI live updates](/en/docs/ai/chat-runtime-and-streaming#ai-live-updates)
on `/api/ai/live`, not through the conversation stream.

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

Files dropped anywhere on the workspace main area around `ChatComposer`, not
only on the composer, attach to the message; the overlay says so while files
are dragged over the window. The composer accepts files and screenshots from
paste through the same bounded attachment pipeline as selection and drop. Short text
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

To let **Attach files** take files from other Cloud applications as well, pass
[`chooseFiles`](/en/docs/platform/file-providers) as `fileSelection.choose`
with `maxBytes: aiComposerChooseMaxBytes(attachments.length)`. Files from an
application are read into the browser before `readAiComposerFiles` checks
them; that budget keeps them within the draft's free slots, at most 50 MiB
each. It is `0` when the draft is full: say so instead of opening the chooser.

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

### Four places per turn

`createAiChatTimeline` shows every assistant turn in four fixed places, in this
order:

1. **Work line.** One row for everything the reader no longer needs once the
   turn ends: intermediate text, reasoning, ordinary tool steps, image
   inspections (`view_image`), and compaction. While the turn runs, it names the
   current step, such as "Reading orders.csv", with a clock and the step count;
   on phones the count appears once the turn is finished. A step that runs
   longer than 45 seconds shows its own duration instead of its target, such as
   "Running code · 3 min"; after a reload it counts from the reload, since
   blocks carry no start time. While a model call waits for its retry or the stream
   reconnects, the line reads "Reconnecting" without its shimmer, and its clock
   stands. While an approval or answer is pending it says what the turn waits
   for and since when. Finished,
   it reads "Worked 3 min" with the step count, and "Worked 1 min · stopped"
   after a stop. A failed turn reads "Worked 4 min" too and says why in a
   notice at its end; a failed turn from an earlier release, which recorded no
   reason, reads "Worked 4 min · interrupted". Expanding it shows, one level below the line, intermediate texts as quiet
   paragraphs and the steps between them directly, each with its input and
   output on demand in place. Only housekeeping, loading tools, skills, and
   knowledge and reading a loaded skill's files, folds into one row such as
   "Loaded tools and guidance · 4 steps" at step level, with the reasoning
   between those steps; it opens in place without a second indent. A run of
   housekeeping that would hold all but one of the work's steps shows its
   steps directly, so the line never opens to a summary of itself, and steps a
   reader sees while the line is open never fold away under them. The line
   opens on a click, Enter, or Space in every state, live or finished, also
   while its clock ticks, and stays open while new steps stream in; the
   conversation then keeps the line where it was instead of following the end.
   Every step stays there, including results and actions, so input and output
   remain reachable. Failed steps say "failed" in muted text; a rejected approval says
   "rejected". An app check (`code_check`) reads "Checking the app" while it
   runs, and its row names the outcome in words with its own icon: "passed",
   "3 findings", or "not passed", with warnings counted separately, such as
   "passed · 2 warnings". When the host provides `fileUrl`, an expanded
   `view_image` step of a chat image shows that image below its input and
   output, as a small thumbnail with a fixed box that loads lazily through the
   chat's file route, so it shows only what the reader may open and nothing
   above it moves when the result arrives. Its alt text is the start of what
   the step saw, the image description or the answer to its prompt. With the
   host's `onOpenFile`, the thumbnail is a button that opens the file larger;
   its name is that action, and the alt text describes it. Without `fileUrl`,
   such as in a background run transcript, the step shows no thumbnail.
2. **Results.** Presented files, `code_present` apps, cards, and
   capability tables in the order they were made. A later result with the same
   target, the same file path for `present` or the same title for
   `code_present`, replaces the earlier one at its place. A running delivery
   takes a place once its arguments have arrived, so a new version never shows
   a frame of its own first. A capability table shows the summary and links of
   its result above it. An approved call or a Cloud action that returns a table
   shows the table here and its receipt in place 4.
3. **Newest text.** While the turn runs this is a status: a new text replaces
   the previous one in the same element once its first sentence has streamed,
   and the place keeps its height until the turn ends. Finished, it is the final
   message: the turn's last text, even if a tool call followed it. A stopped or
   failed turn has no final message; its texts stay in the work line.
4. **Actions.** Open approvals, surveys, editors, and secret prompts, and
   receipts for capability actions and for every approval the user decided.
   A pending approval is a calm card with a warning tint and no border: its
   title says what will happen, such as "Mail · Send email", with "Runs only
   after you approve it" below, then the review text and fields, and Reject
   next to the action itself. On phones the fields stack under their labels and
   the two buttons share the width. A receipt is one line that names the call
   in the reader's language with what it acted on, never its raw tool name:
   "Email to Jana Berger sent" from the action's summary with its links,
   "Approved: Run code · report.ts" for an approved tool that is not a Cloud
   action, "Running: Send email" while it runs, "Rejected: Send email",
   "Failed: Send email", or "Not run: Send email · stopped" when the turn ended
   before the call ran. Once the server accepts a decision, the card turns
   into its receipt in place, before the turn reports the call; later updates
   change only the receipt's words. If the decision was made in that card,
   focus stays on its place without scrolling. An approved call carries `approved: true` on its
   tool block, live and in history, so its receipt survives a reload, also when
   the turn ended before the call returned. Links without a title read "Open",
   "Edit", or "Download" in the reader's language.

A turn without tool calls or compaction, such as a plain answer, a steering
marker, or an answer with only reasoning, has no work line. Its texts form the
message. While such a turn reconnects, a calm "Reconnecting" row stands at its
end, where it moves nothing above it. Pass `reconnecting`, such as
`() => chat.streamStatus() === "reconnecting"`, to `createAiChatTimeline` so
a lost connection shows like a model retry; Assistant then leaves the
composer's reconnecting notice to chats without a running turn. Steering and accepted survey answers split a turn into segments; each
segment has its own places, and only the last one shows the duration.

The work time is wall time minus time spent waiting for approvals and other
user actions. History uses the loop's durable timing; the live clock stands
while the turn waits for an approval or an answer and continues from the same
value afterwards. A tool the browser runs by itself, such as a Studio code run,
counts as work, live and in history.

Screen readers do not hear the work line's ticking clock or a status while it
streams: both sit outside the conversation log's live announcements. A status
is announced once it is complete, a waiting approval as one short line such as
"Approval needed: Send email" without moving focus, and the end of a turn with
work as "Answer ready". A plain answer without tools streams into the log as
before.

The live turn and its history share one layout function and the same timeline
item ids, `ai-turn:<turn id>:<segment>`. A segment is named by what opened it:
`start`, `steer:<steer id>`, or `survey:<call id>`. Consecutive steering
messages open one segment, and loading older history renames none. Results and
actions are keyed by their call. When the turn ends, the work line changes its
text and the message actions appear; nothing else moves, and host views such as
a running Studio session keep their state. Copy copies only the final message.

Turns with a work line, results, actions, or a failure notice span the full
message column, so disclosure chevrons share one right edge. Plain prose keeps
the reading width.

### Failed turns

A failed turn keeps its results and receipts in place and ends with a danger
notice: "The answer was interrupted." and the reason in the reader's language,
such as "The model service did not answer. The results so far are kept." The
reason comes from `meta.turnError` on the turn's last message, see
[Failed turns](/en/docs/ai/chat-runtime-and-streaming#failed-turns); the
provider's own message never appears. A turn that failed before the model
answered, or right after an accepted survey answer, shows the notice where its
progress stood, under the same timeline id; this includes a request forwarded
from another chat.
Screen readers hear the notice once when the turn they followed fails.

When the failed turn is the chat's newest, no turn runs, and a new turn can
finish the work, the notice offers **Continue**. Supply
`AiChatActions.onContinueTurn(message)` and send `message`, a visible request
in the reader's language to pick up where the turn stopped, through your
normal send path. The person then sees what was asked, and the next turn sees
the failed turn's finished steps. A call the failed turn left open reaches the
model as not returned, so it checks the call's effect instead of repeating it
blindly. A full context, a used-up usage limit, or lost access would fail the
next turn the same way; their notices name the next step instead of offering
**Continue**. Without `onContinueTurn` the notice shows only the reason; the
message menu's **Retry** stays available either way. When your send path goes
through the conversation draft, as the controller's `send` does, sending
replaces what the person was writing; save the composer's content back
afterwards, also when sending failed.

The controller's `error()` does not repeat a failure that the failed turn shows
in its notice; it matches the turn by `AiConversation.runTurnId` or the
`turnId` of `turn_finished`. A failure without a recorded reason, such as a
failed compaction, still reaches `error()`.

Capability titles and application icons come from the saved presentation.
Approval prompts retain their application identity and explicit decision
controls. Surveys, cards, presented files, editors, and capability tables remain
visible results. The saved presentation remains readable when an application
is temporarily unavailable. Cloud's built-in tools, including every Studio
tool, show a name in the reader's language, such as "App check" or
"App-Prüfung"; a test fails when a built-in tool has no English or German name.
Other tools without a presentation show their tool name in words.

A successful result with valid `presentation.kind: "table"` renders inline,
outside tool summaries. Rendering depends on the result itself, including in
restored history without optional application branding. Live updates replace
the previous block content without duplicating its table. Results without table
presentation remain compact; errors and approval requests retain their own UI.

`AiChatActions.renderCodePresentation(result)` lets the application render a
`code_present` result inline. Cloud calls it once per call, from the call's
first event, with an accessor: `result()` is `undefined` while the call runs and
the saved result once it completed. Hosts written for the earlier contract,
which passed the completed result as a value, read `result()` instead. Reserve the preview's final frame while the
result is pending, so the preview does not grow twice, and keep the view's
state when the result arrives; the same view stays mounted when the turn
becomes history. The host owns validation, authorized loading, durable storage,
and sandbox lifecycle. It must not execute saved code automatically when
rendering the preview: Assistant's card starts its HTML app only on a click. Without this action, `code_present` calls stay in the
work line.

Hosts can supply `AiChatActions.resolveFileLink(href)` to resolve a Markdown link
against the current conversation file manifest. Return `{path, href}` with a
reloadable host workspace URL, or `null` for ordinary links. Plain clicks invoke
`onOpenFile(path)`; modified clicks retain native navigation to that workspace
URL. Assistant resolves only existing current-chat files and same-origin links,
and any path below the chat's working folder `/temp/`, whose files its snapshot
counts but does not list; the workspace reports such a file if it is gone.
Conversation file paths are not website URLs; agents deliver files with `present`.

Assistant shows what a chat holds in the sidebar **In this chat**, in this
order: what needs attention, **Results** (files, Studio apps, and
visualizations the assistant delivered, each with the sentence it gave),
**Your files** (uploads and voice recordings; an upload the assistant hands
over with `present` stays here), **Sources** (read web pages,
each web search with its query, and the Cloud items a tool call read, bundled
per call, without stored previews), **Working files** (everything below
`/temp/`, grouped by folder, with the storage used once it passes 70 % of the
limit), and **Context** (Project, Skills the chat used, memories remembered
from it, scheduled tasks, and Secrets). Sources, Working files, and Context
start collapsed; collapsed content is not rendered.

The newest results stay on top: all results of the latest turn that delivered
one, however old, then other results of the last 24 hours up to six entries.
Older results, and every other long list, group by day for the last seven days
and by month before that. The grouping uses the snapshot's server time and the
viewer's time-zone cookie, so the server render is final. While the pointer or
focus is inside the sidebar, it keeps the state someone reads: new results
raise a **New · N** count in the heading, other changes an **Update** control;
leaving the sidebar or selecting the control shows them. After a touch inside,
the state holds until a touch outside, because touch has no hover. Opened groups
and a working folder's loaded files stay open through live changes and
deletions. Live changes reload the snapshot at most every 500 ms; the live
updates acknowledge a change only once that reload succeeded, so a failed one is
tried again. Selecting a result's title loads the chat up to the message that
delivered it, scrolls to the delivery (`data-call-id` on the present row,
`data-presentation-id` on a visualization), and adds a `?message=` history
entry. A search in the sidebar's header queries `GET /api/assistant/workspace/conversations/:id/sources`, which
takes the sources route's parameters and shows an app only while the viewer may
read it, under its current title. It finds results by title, description, or
path, and files and sources the chat read; Project context it never read stays
under Context. **Sources** shows the newest 100 and loads older ones from the
same route; a new first page starts the loaded pages over. More than 200 working
folders or 100 loose working files are counted, and search finds the rest.

CSS decides the sidebar's presentation from the chat area's width: a 20 rem
column from 56 rem, a non-modal drawer over the chat's edge below that, and a
bottom sheet on phones that Back closes. The column is open by default. Closing
it is remembered in the `assistant_context=closed` cookie, which the page reads
before rendering; reopening deletes it. The workspace's **Files** tab shows the
same list.

The sidebar offers a trash action on uploads, voice recordings, and working
files, and in the menu of a delivered file. It appears on row hover or keyboard
focus and stays visible on touch devices, and its label names the file. After
confirmation, Assistant deletes the file through the conversation file route,
closes the file's open workspace tab, reloads the list, and moves keyboard focus
to the row that takes its place. A file that another tab or the CLI already
deleted counts as deleted; other failures keep the file and show the server
message. Shared Project files stay read-only under Context. A working folder
can be deleted as a whole after confirmation; the confirmation names the
results stored in it, because they go with it. The Studio overview lists up to
500 apps the chat referenced, not only the ones in its newest sources.
Deletion never rewrites the chat history. Earlier messages keep their text; a
Markdown link to the file becomes an ordinary link, opening a presented file
reports `File not found`, and an image attachment shows its icon instead of the
thumbnail.

The work line and housekeeping groups never open by themselves. Explicit disclosure choices
survive streaming updates, the end of the turn, and a reload in the same browser
tab when session storage is available.

Generic tool rows and disclosures use `Chat.Activity` from `@k2b/ui`. Cloud
only supplies protocol-derived labels and specialized bodies such as web search
results, first-party favicons, structured data, and approval controls. Keep
those domain renderers in Cloud instead of duplicating the shared activity
shell. Use `defaultOpen` for the initial disclosure policy; hosts that must
preserve a person's choice across a remount can control it with `open` and
`onOpenChange`.

An active response always ends with the shared streaming state of
`Chat.Message`, including before the first model block arrives and after a
steering message that waits for the next model call. Until the model takes up
that message, the segment above it keeps its live work line. The streaming
state renders the minimal three-dot progress indicator; do not add a separate
generating activity or label. The live work line sets `busy` on
`Chat.Activity`, which moves a quiet text-color-to-transparency shimmer across
its icon and label instead of adding another loader or pulsing the accent
color. Reduced-motion clients keep the same text static.

While a model call waits for its
[retry](/en/docs/ai/chat-runtime-and-streaming#transient-provider-failures),
the live turn ends with one **Reconnecting** activity row (German: **Verbindung
wird wiederhergestellt**) without the shimmer. Earlier rows keep their place,
and the next turn event removes the row while the model's output continues in
the turn's places.

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

Pass approval, frontend-tool, retry, continue, fork, message-feedback, and file
handlers through `AiChatActionsProvider`. Rich Cloud blocks remain Cloud-owned JSX inside the
generic timeline.

Applications hosting code-triggered approvals can render the same public
`AiTurnBlockView` from `@k2b/cloud/ai/ui`, inside `AiChatActionsProvider`.
Provide an active tool block in `awaiting_approval` state with the server-reviewed
message, details, and `allowAlways` value. Route `onApproval` back to the
permission-aware server operation. This renderer does not authorize execution:
the server must correlate the request to its user and resource, enforce current
permissions, and reject changed or already-resolved requests. Repeat the review
in the locale the person reviewed in when you compare it: switching the language
before approving does not change the consequence. Use this shared view in a chat
or app dialog rather than inventing another approval interaction.

Assistant messages may expose helpful and needs-improvement actions. Positive
feedback saves immediately. Negative feedback collects one or more stable
reason codes or an optional short comment in a shared prompt. The rating is
private owner metadata: it is not sent back to the model and does not alter the
conversation transcript.

The controller claims each call once, runs the handler, and sends the result
back to the turn. Once the server accepts it, the call shows as finished, like
an answered approval, before the stream confirms it. Show interaction tools
only when the relevant application view is present. After the server accepts a survey answer, replace the form
with a normal user message: show each question as small context above its answer. Use option
labels for choices and retain free-text line breaks. These messages stay in
chronological order between the assistant's outputs, remain visible outside
the work line, and render the same way after reloading the conversation.
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

Every turn with the default tool source offers the server-run code tools
`code_run`, `code_action`, `code_inspect`, `code_stop`, `code_export`, and
`code_present`, and `code_check`, whichever client submits it: the web app,
`cld assistant` with or without `--detach`, an API client, or a scheduled task.
Cloud runs them in an Assistant-owned host, so they need no client.

Only tools that a client must run wait for that client. A frontend handler alone
does not advertise them to the model. Pass `clientToolIds` to
`createAiChatController` and register matching `frontendTools`. The controller
forwards only IDs that have a handler. The client-run tools are `code_open` and
`code_secret`, which need a client with a code host: the web app, or
`cld assistant` while it watches the turn. Entering a secret through
`code_secret` still needs the web app; in the CLI the call fails with that
hint. `local_bash` needs `cld assistant --allow-bash`. Detached CLI turns, API
clients without a code host, and scheduled tasks never get `code_open` or
`code_secret`. The other code tool names are still accepted in `clientToolIds`
and have no effect. Unknown names are ignored so older clients keep working
after a tool is retired. Turn and draft submissions accept at most 64 distinct
names, each 1 to 64 ASCII letters, digits, underscores, or hyphens (the tool-name
limit model providers share). Duplicates, too many names, and malformed names
are rejected. Clients without an execution host should omit this option.

Handlers receive `name`, `args`, `callId`, `turnId`, and `conversationId`. Capture
that conversation identity for asynchronous work instead of using whichever
chat is active when the work finishes. The controller submits the result to the
originating conversation. Return JSON-compatible, bounded results.

The `code_*` tools each have a flat input schema and are deferred: the agent
must call `load_tools` before using one. When a turn does not offer a
client-run tool, `load_tools` reports it with the reason `not_offered_in_turn`.
`createCloudAiCodeTools` supplies their definitions
through the AI runtime tool exports. `CODE_RUNTIME_TOOL_NAMES`,
`parseCodeToolInput`, and the internal `CodeRuntimeInput` envelope are exported
from `@k2b/cloud/ai/browser` and `@k2b/cloud/ai` for host integrations. A host
returns a call that did not complete as `CodeToolFailure`
(`{failed: true, error, guidance?}`, from `@k2b/cloud/ai/browser`); server-run
code tools report it to the model as a tool error.

`code_run` accepts a saved script `id` or one-off `code` and optional chat
`inputPaths`, takes a fixed snapshot of current source, and returns a run ID and
compact state. There is no required source revision. An app whose interface is
`index.html` does not run there; `code_open` and `code_present` show it.
`code_inspect` returns status, progress, logs, output and captured files, and can
wait for background work with `waitMs`.
Inspection also reports the tested source revision. `code_open` never starts the visible
app. `code_export` copies a captured file into the originating chat.

### Check an HTML app before showing it

Write `index.html`, optional styles/modules, and `steps.json`. Call
`code_check({id})` for saved source or `code_check({files})` for a one-off app.
Fix the findings, call `view_image` with the report's `review.prompt` for every
path in `review.paths`, and check again. The prompt asks for visible defects:
rows at different heights, cut-off, overlapping or doubled content, error
messages, raw values and wrong plurals. It leaves contrast to the measured axe
findings, so a vision model does not push apps away from the flat base style.
The paths are the three screenshots and every PDF the desktop run downloaded.
The phone run repeats the steps, so its PDFs add a path only under a file name
the desktop run did not download. `passed` means the app passed the automated
checks; it does not judge the design or business logic. The report includes
desktop before steps, desktop after steps, phone after steps, captured
downloads, call counts and an accessibility tree. Each screenshot shows the
whole page up to 2000 px tall. The check grows the viewport to the page and
measures again, because content sized in viewport units grows with it;
`cropped: true` marks a page that still continues below. All app-derived report
text is untrusted content, never agent instructions.

`code_open`, `code_present`, and the agent's `code_publish` refuse HTML apps
without a passing check for the current files and table definitions, bound to
that user and conversation. Changing `steps.json` also invalidates the check.
One-off presentation requires exactly the checked files. Scripts have no gate.
The human Studio publish flow is not gated: the self-test is an agent workflow
guard, not a security mechanism, and grants no access. The gate applies when the
tool is called: a presented or opened saved app keeps loading its current source,
so the agent checks again after every edit before asking the person to reload.
`code_restore` is a rollback to an earlier publication and is not gated.

`code_write` reports an invalid `steps.json` as a diagnostic with the step,
the field and the valid forms; `code_check` refuses it with the same message.
The screenshots show the state after the last step, so steps should end in the
typical, filled main state.

`steps.json` is an array of at most 20 steps. Actions are `click`, `check`,
`uncheck`, `fill`, `select`, `press`, `upload`, and `reload`. Targets use
`{role,name?}`, `{label}`, or `{text}`. Matching tries exact, then
case-insensitive, then substring; multiple matches fail and list candidates.
Names match the accessibility tree and exclude placeholders. `press` may omit
its target to use focus. `fill`, `select`, and `press` take a string `value`;
fill decimal numbers with a dot. `upload.file` names a chat file/path or an
app-relative source file. `reload` keeps the run's disposable data and the
app's URL hash. Disabled controls cannot be clicked, filled, selected, uploaded
to, or focused for `press`.

```json
[
  {"action":"fill","target":{"label":"New task"},"value":"Send invoice"},
  {"action":"press","value":"Enter"},
  {"action":"reload"},
  {"action":"check","target":{"role":"checkbox","name":"Send invoice"}}
]
```

Both desktop (1280×800) and phone (390×844, touch) replay the steps, in opposite
themes with the viewer's locale/time zone. Background checks use the task time
zone and the default locale/light theme when no preferences are available.
CLI checks use a light desktop theme and the service locale/time zone.
For a saved app, each run uses a separate disposable copy
of the app database, shared KV/files and only the checking user's personal KV.
Reads and writes use the normal services; real app data stays unchanged. A
database above 1000 rows or 16 MiB uses schema only and reports a warning.
Storage copies are limited to 250 MiB. In a background turn, checking a saved
app with a connected database requires a task grant that allows `export` for
that app; otherwise the start is refused with `BACKGROUND_ACCESS_DENIED`.
One-off apps have no storage or database, as in their chat card: `cloud.kv`,
`cloud.files` and `cloud.db` reject with `unavailable`.

AI runs for real. HTTP, capability actions and anything needing approval reject
with `unavailable` (“not executed during code_check”). Uncaught errors and
`console.error` output that contain this message warn instead of failing.
Read-only capability queries run for one-off apps and apps the checking user
manages. For apps the user can only use, where the normal runner would ask
first, and in background turns, every capability rejects. Downloads from
`cloud.download` and download links become readable chat files alongside
screenshots.

The check fails on runtime errors, including errors thrown in event handlers
and unhandled rejections, `console.error`, sandbox violations, missing
readiness after 10 seconds, an empty page, failed steps, serious/critical axe
findings, static lint errors, phone horizontal overflow or clipped controls in
sideways scrolling containers, at startup and after the steps. A JavaScript
engine message for a code bug, such as “Cannot read properties of null”, also
fails when the app shows it as its own message: in an element with
`role="alert"`, `role="status"` or `aria-live`, or in `<output>`. The check
looks for it after every step. The same text elsewhere, such as in a log table,
and engine messages for input errors, such as `SyntaxError: …` from parsing an
import, warn. Findings name elements by tag, id and accessible name. Fields or
buttons without main-flow steps also fail; links alone need no steps. More than
200 findings end with one error saying later findings were dropped.
Other accessibility findings, password fields, several untyped form buttons,
layout loops and fields still `:user-invalid` warn. So do misaligned rows:
children of one flex or grid row whose boxes sit at least 6 px apart because
of a margin, usually the base stylesheet's flow spacing, and field captions in
one row that do not line up. In a row aligned at the bottom, such as `.row`,
captions line up by their last line, so a caption that wraps does not warn. The
warning names the row and the CSS that fixes it, once per row pattern; a row
without its own class is asked to get one, because a selector such as
`main > div` would also reset the spacing of other blocks. Baseline alignment,
wrapped rows, items spanning rows, auto margins and a margin that lines an item
up with a field or button beside it are intentional and do not warn. The check
lays out the HTML of every `cloud.pdf.render` call at its printed width with the
base stylesheet and print media, as the renderer prints it, and reports the same
findings for the PDF. It loads no images from `assets`; the findings rest on
margins and text. Visible values such as `NaN`, `undefined`, `Invalid Date` or
`[object Object]` warn in the page and in PDFs. `cloud.chart` keeps complete
category labels and skips some at narrow widths; it does not shorten them to
one or two characters.

Checks use the existing host admission and a 45-second deadline. Each user can
hold at most 16 disposable check copies at a time, two for each of the eight
admitted code hosts; another start fails with `limit` until a check finishes or
the sweep removes copies of crashed checks. Output is at
most three screenshots, each up to 2000 px tall, and 64 downloads, 50 MiB per
file and 250 MiB total.
The accessibility tree is limited to 4 KiB. Cancellation closes pages and removes
copies; crashed hosts leave a durable cleanup marker for the service sweep
and bounded, best-effort cleanup before each new check.

CLI users run `cld assistant code check ID --chat CHAT`. For one-off files, omit
ID and pass `{files}` through `--input-file` or stdin. Local Chromium runs the
same check and saves screenshots/downloads as local files. Use `--out DIR` to
choose the output directory; otherwise the command creates and prints a new
temporary directory. Text and JSON output
include each local path alongside its chat path. Existing local files are not
overwritten.

Assistant exposes direct server tools: `code_create`, `code_read`, `code_write`,
`code_remove`, `code_list`, `code_history`, `code_update`, `code_fork`,
`code_publish`, `code_versions`, `code_restore`, and `code_sql`. These are
deferred built-ins with flat inputs, not application capabilities.
`CODE_SOURCE_TOOLS` from `@k2b/cloud/ai` supplies their shared input contracts.
Core forwards each operation to Assistant using an operation-bound invocation.
The server derives the chat context and checks current user, conversation,
Project and resource permissions. GUI and CLI use the same resource services.
Writes reuse the platform replay guard; uncertain calls are not repeated.
`cloud.capabilities.run` remains available for other applications, not these tools.
`code_write` saves one atomic batch against `expectedRevision`, preserves sibling
files and reports compilation diagnostics without rejecting incomplete source.
Conflicting revisions and duplicate paths reject the whole batch. A file can
use `{path,content}` or `{path,fromChatFile:{path,version}}`; the latter copies
validated data bytes on the server without printing/retyping them through the
model. `code_export` returns the required chat path and version. Relative JSON
imports expose data; CSV/TSV/TXT imports expose text. Execution requires a
compilable entry exporting one function.

The host owns isolation, artifact permissions, input file authorization,
cancellation, and execution deduplication. Assistant persists call ownership
and results; an uncertain execution is never automatically replayed.
Its test runs are separate from visible apps and persistent user data. Assistant
owns an isolated Chromium host for model-driven run/inspect/interact/stop/export
operations. Closing or freezing the user's tab does not suspend these operations.
Calls, results and ordered approvals are persisted; a lost host is not replayed.
Only `code_open` and `code_secret` require the user interface. The host pool admits
eight hosts. Foreground chat runs and scheduled turns have separate hosts.
Foreground hosts without an active turn expire after two idle minutes.
Scheduled hosts live for their turn; finished scheduled turns and cancelled
runs are closed by the host sweep.
The Assistant image includes Chromium; other application images do not need it.
The direct CLI code command retains its own isolated local execution host.

### Assistant apps and browser work

The Assistant **Studio** navigation opens its app catalog on hover or click;
its search button opens global search filtered to Studio apps. Use-level users
enter the standalone runner; managers enter Studio management. Management actions
include editing, publication, and access. The runner retains personal actions for copying an app,
viewing and clearing their own server-side **Personal data** (`cloud.kv.user`).
Secrets are available in management only.
Copying asks for confirmation, then opens a new chat with the copy attached
and an unsent customization prompt. Only published code is copied, not data,
secrets, or sharing settings. Anonymous public visitors have no personal-data
control; `cloud.kv.user` and database writes reject with `denied`. Permissions
use the Cloud editor in a dialog.
Artifacts are independent of chats. Cloud `auth.access` grants are linked
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

### Inspect background results

Delivered background results use ordinary assistant prose with
`meta.scheduledTask` identifying the task and occurrence. The timeline displays a
**Background run** control above the result. Hosts provide
`AiChatActions.onOpenScheduledTaskRun(taskId, occurrenceId)` to open their
permission-checked run detail view. Assistant shows the result, execution history,
and controls for returning to the chat or managing the task.

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


### Standalone apps and public links

Studio opens the standalone runner for users with **Use** access. App managers
enter the management view and select **Open fullscreen** in the header or action menu. The
runner offers **Manage** and a personal action menu beside **Restart** and **Stop**
in the bottom toolbar. Its content scrolls within the available viewport with
scroll-edge fades. Restarting shows progress in the button without adding a status row. This distinction uses app permissions,
not the global Cloud administrator role.

App managers see a **Draft** or **Published** badge beside the runtime controls.
Select it for a short explanation and a **Publish** button for saved drafts.
Publishing selects a runnable version; it does not grant public access.
**Open fullscreen** stays visible for drafts and offers publishing first.

**Copy app link** copies `/app/assistant/apps/ID/run`. This URL always runs the
latest publication, even for managers. It loads no Assistant sidebar, chat list,
chat updates, code editor or database console. Apps require sign-in and app
access. The app starts on its own for people who manage it; everyone else
selects **Start**.

Public links are switched off for now: **Manage access** does not offer
**Public**, and an existing public entry opens nothing until public sharing
returns. See [Assistant](/en/apps/assistant#standalone-apps-and-public-links).

Cloud administrators can add this URL as a **Link** in the navigation settings,
with a title, icon and audience. The shortcut's audience controls visibility,
not permission to run the app. CLI users can obtain the path with
`cld assistant code url ID` and use the existing grant/change-grant commands.

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

Administrators can select a historical publication in Studio management's **Versions**
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

Code source edits use `code_write({id, expectedRevision, files, entry?})` to
commit related files in one revision. Each file supplies `content` or
`fromChatFile: {path, version}`; the latter copies authorized UTF-8 chat data
without a model-output round trip. JSON and CSV/TSV/text imports are supported.
Stale destination revisions or source versions fail before saving any files.
CSV previews expose encoding, delimiter and raw-text choices; Assistant remembers
those choices in browser-local preferences, without modifying uploaded files.

Studio resource URLs, tool inputs and references use six-character Cloud short
IDs. UUIDs remain internal database keys and are rejected as public resource IDs.
Existing resources receive short IDs during migration; no UUID URL alias exists.


The chat's Studio section uses the canonical conversation resource index. Direct
code tools index their returned refs immediately. Rows show current authorized
metadata, source revision, publication state and the last matching run result.
A newer source revision is explicitly untested; a successful run is not a claim
of business correctness. Recent one-off runs are a separate compact list (latest
20), and exported files remain in Files. Forbidden resources are filtered again
when the context snapshot is loaded.

Managed execution reports starting, working, and approval phases in the active
tool row. Startup is bounded to 45 seconds; the server also checks the browser
event loop with a 10-second heartbeat deadline. A dead host is reported without
replaying an uncertain operation.

### Working plan and compact Studio context

Assistant shows the current working plan above its composer. The collapsible
list uses the portable, controlled `Chat.Tasks` component from `@k2b/ui`.
Applications supply items, disclosure state, localized labels and progress text.
One segment per task shows completed work in green, the current step in the
accent color, pending work in gray, and cancelled work with a striped segment.
Symbols and text provide the same information without color. Cancelled tasks
are counted separately. The current step remains visible after stopping; it is
only described as in progress while its turn is actually running.

Compact context entries use one line and consistent icon alignment. One-off
runs appear only in the Studio count, not as preview rows. The Studio tab reuses
the gallery's application cards and permission-aware menus. Start opens the app
in a workspace tab; the external-link action opens its standalone runner in a
new browser tab. Opening a context preview still does not start an app. The
Studio tab also shows the latest 20 one-off runs in a compact log table, with
the full count stated separately. Exports do not overwrite a known run status.

Secrets management uses a list with an empty-state action. Adding or replacing
a secret opens a separate dialog. Validation errors appear at their fields;
network errors and revision conflicts remain explicit. A Bearer preset supplies
the exact `Bearer ` prefix. API-key and custom-header modes remain available.
The target is an HTTPS origin: URL paths and query parameters do not narrow the
secret's destination. Only metadata is returned when listing or replacing;
existing secret values are never loaded into the browser.

The Studio console aligns timestamps, readable severity labels, and messages in
compact columns. Info, warning, and error labels use themed color badges; long
messages wrap within their column. The header identifies the executed revision.

The Studio app preview scrolls independently of its bottom console controls.
Expanded console output scrolls within its own bounded area, keeping controls
visible while browsing a long app.

Completed working plans hide automatically once every task is completed or cancelled.
A checklist action beside context usage reopens or hides the saved plan. New open
tasks restore the plan automatically; switching chats resets the disclosure.

## Select commands and inline context

Assistant recognizes `/` at a word boundary anywhere in the composer. Type a
name, or narrow the suggestions with `/skill`, `/app`, `/file`, or `/project`
followed by a search term. Select with the arrow keys and Enter or Tab; Escape
closes the menu without changing the draft. URLs, paths, and code remain text.
Suggestions temporarily replace the task list above the composer. Each result
occupies one line; closing the menu restores the task list and its open state.

`/compact`, `/fork`, and `/new` use the existing chat actions. Fork starts from
the latest assistant response. Commands preserve the surrounding draft. Skills,
Studio apps, and files insert highlighted references. Editing a reference's
label turns it into ordinary text; undo restores its identity. Saving and
reopening a draft preserves references, including versioned conversation files.
Project file references name a read-only path in the current Project.

Selecting a Project permanently assigns a previously unassigned chat. Future
turns use that Project's instructions and files. Project results disappear once
the chat belongs to a Project. A stale selection cannot replace an existing
assignment, and assignment waits until active and queued work has finished.

Projects can explicitly link Skills. Current members inherit read/use access,
so linked Skills appear in their normal catalog and search results. Content
loads only when needed, and personal disabled-Skill preferences still apply.
Links require Manage on both resources when created; they persist if the creator
later loses those rights. Revoking membership or removing a link removes inherited
access, including mounted Skill files, while direct grants remain. Project links
never grant Skill editing or access to Apps mentioned by a Skill.

An explicitly attached Skill is loaded on the server for that turn, using the
same permission checks and pinned revision as `load_skill`. Reference files are
still read on demand. A restricted tool scope or revoked Skill produces an
error; the runtime does not silently ignore the selection. Mentioning an app
never executes it or grants access.

`Chat.Composer` accepts controlled `mentions` and `onMentionsChange`, asynchronous
`searchCommands(query, signal)`, and an `accessory` for the shared task surface.
Set `draftKey` to the conversation or draft identity to isolate undo history.
A command can supply an action or a `mention` containing a `ChatAttachment`;
its payload stays application-owned. Mention offsets use the untrimmed text's
UTF-16 positions. Use `aiComposerDraft()` to restore an ordered server draft and
`aiComposerSendInput()` to preserve it when saving or sending. Hosts allowing
context during an active response must handle the `queue` intent; steering
continues to accept text only.
