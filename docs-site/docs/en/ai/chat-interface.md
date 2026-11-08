---
title: Chat interface
navTitle: Chat interface
section: AI
order: 1070
description: Present conversation state, tools, approvals, and failures with the shared chat controller and components.
tags: [ai, ui, solidjs]
updated: 2026-11-07
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
import type { AiPeopleModels } from "@k2b/cloud/ai";
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
  models: AiPeopleModels["options"][number][];
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
              : chat.send({ ...payload, model: { id: props.selectedModelId() } });
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
          onCheckAction: (request) => chat.checkAction(request),
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
- approval, outcome-check, and frontend-tool actions;
- file URLs and file counts;
- one error state for the active chat.

`createConversation()` returns `null` on failure. `creationErrorStatus()` exposes
the HTTP status when the controller reports a creation failure, or `null` when
that status is unavailable. Applications can distinguish a definitive refusal (such as an unavailable
creation replay) from an uncertain write; retain local drafts in either case.

After a lost turn response, `uncertainSubmissions()` maps conversation IDs to
their confirmed submitted draft revisions. Those conversations reject further
saves and sends until resolved. `reconcileSubmission(id)` checks the exact
server record; `retrySubmission(id)` first checks it, then deliberately retries
the frozen submission if still unknown. Neither operation saves a new draft.
They return `accepted`, `unknown`, or `none`. For the active conversation,
acceptance also waits for its post-submission draft to load; a failed refresh
keeps the draft locked and can be retried. Keep unresolved local content and
later edits separate, and prevent panel removal while the outcome is unknown.
The controller's pending identity is in memory, so native page departure still
needs the application's unsaved-state warning.

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

For microphone input shared across applications, use the browser
[Live dictation source](/en/docs/ai/live-dictation). It supplies append-only text
events; the host owns insertion and draft persistence. Its server availability
helper lets SSR decide whether to render a microphone.

Lists, Sources, files, routines, dictations, and Project context refresh through
[AI live updates](/en/docs/ai/chat-runtime-and-streaming#ai-live-updates)
on `/api/ai/live`, not through the conversation stream.

## Suggest the next message

Interactive browser chats with the default tool source offer
`suggest_next_message({ text: string | null })` when the person's
`suggestNextMessage` preference is on (the default). Project composers,
local clients, routines, workflows and background runs do not load it. A
chat inside a Project is still an interactive chat.

The platform prompt includes **Suggestions → Next message** only while the
tool is loaded. It asks for one plain sentence in the person's language, at
most 120 characters, only when the answer ends with a question or offers an
obvious next step. `null` deliberately means no suggestion. Completed requests,
failures, refusals, blockers, pending question cards or approvals, thanks and
requests for brevity or no suggestions should produce none. A suggestion uses
only the person's messages and the visible answer, never unseen tool data.

The server rejects multiline text, more than 200 Unicode characters, URLs,
Markdown, mentions and text equal to the person's last message after Unicode,
case, punctuation and whitespace normalization. Rejected text means no
suggestion. The first closing call wins, including `null` or invalid text. An alone,
last call following answer text in the same model step ends the loop without
another model request. Other calls receive
`noted, call only alone after the answer` and the loop continues. Their arguments
are stored as `{ text: null }` and do not count as a suggestion. The call
never appears as a tool block.

The latest completed answer can carry the optional field
`suggestedNextMessage: { text: string; dismissedAt: string | null }` in the
conversation detail, message page, initial stream snapshot and completed-turn
stream event. Only the person who triggered the run receives it. A newer
message or turn, an error, stop, redirect, queued message, pending approval or
question hides it. Reloading preserves both the suggestion and its dismissal.
Model history, exported answer text, title enrichment, search and notifications
exclude this field.

Dismiss it with
`DELETE /api/ai/conversations/:conversationId/messages/:messageId/suggested-next-message`,
using public chat and message IDs. The route checks conversation access and the
trigger person's identity, sets `dismissedAt` once and returns
`{ dismissed: true }`. Repeating it is safe. Keep a dismissed suggestion hidden.
Use `GET /api/ai/prefs` and `PUT /api/ai/prefs` with
`{ suggestNextMessage: false }` to turn generation off. No additional provider
or model request is made for a suggestion.

## Attach Cloud resources

Treat a Cloud resource like another composer attachment: keep its structured
`ref`, plus optional `title`, `icon`, and root-relative `href` presentation
metadata. `aiComposerSendInput()` preserves that data for the conversation
draft, and sent messages render it as an attachment chip. A supplied `href`
links the chip back to the owning application.

Assistant also links every Cloud resource it mentions in an answer when the
resource result or supplied context provides an exact open or edit URL. It
never constructs a Cloud resource URL from an ID.

A scheme-less answer link starting with `app/` or `open/` opens as the
root-relative Cloud path (`/app/...`, `/open/...`), so a dropped leading slash
still opens the resource; other links stay as written.

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
with `maxTotalBytes: aiComposerChooseMaxBytes(attachments.length)`. Files from an
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
   reason, reads "Worked 4 min · interrupted". Expanding it shows work at the
   same left edge as the line: intermediate texts as quiet paragraphs and the
   steps between them directly, each with its input and output on demand in
   place. Housekeeping, loading tools, skills, and knowledge and reading a
   loaded skill's files, folds into one row such as
   "Loaded tools and guidance · 4 steps" at step level, with the reasoning
   between those steps; it opens in place without a second indent. A run of
   housekeeping that would hold all but one of the work's steps shows its
   steps directly, so the line never opens to a summary of itself. Consecutive
   calls that differ only in paging, their `offset`, `length`, `limit`,
   `cursor`, `after`, `page`, or `pageSize`, such as reading one file in
   parts, also fold into one row such as "Read file · /products.csv · 3 times"
   that opens in place to the individual calls, provided at least two other
   steps remain outside it. Calls with any other differing argument, such as
   another storage, address book, filter, or written content, stay separate
   rows; so does a failed or rejected call, and text between the calls ends
   the run. A folded row shows its count at its end, like the line's step
   count, so a narrow screen shortens the target but never the count. Its
   steps keep their place, open state, and focus while they finish and when
   the turn becomes history. A row a reader sees while the line is open
   never folds away under them, also when reasoning after it or a call's
   arguments arrive later and would make it part of a group; the next time
   the line opens, it folds like in history. The line opens on a click, Enter,
   or Space in every state, live or finished,
   also while its clock ticks, and stays open while new steps stream in. Opening
   or closing it never scrolls the conversation; afterwards the conversation
   follows new steps only while its end is still in view.
   Every step stays there, including results and actions, so input and output
   remain reachable. A step that acts on something reads as its sentence: what
   it will do while it runs, what it did once done, such as "Wrote report.md",
   and what did not happen after a rejection. Failed steps say "failed" in muted text; a rejected approval says
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
   its name is that action, and the alt text describes it. Without `fileUrl`
   the step shows no thumbnail. The run history of a routine passes the
   file route of the routine's chat, so its thumbnails, files and views load with
   the viewer's access as in the chat. Run details and run history are kept
   for 90 days after the run finished. Afterwards the run's details show
   **This run is no longer available**, and the result stays in the chat. A
   one-off routine keeps its run, but its run history then shows **No run
   history**. A routine older than 90 days without a newer run shows **No runs
   in the last 90 days** instead of **No occurrences yet**.
2. **Results.** Presented files and native code views, charts, cards, and
   capability tables in the order they were made. A later result with the same
   target, such as the same file path for `present`, replaces the earlier one
   at its place. A running delivery
   takes a place once its arguments have arrived, so a new version never shows
   a frame of its own first. A capability table shows the summary and links of
   its result above it. An approved call or a Cloud action that returns a table
   shows the table here and its receipt in place 4. A chart draws in full with
   its first frame, at a fixed height, with its title, a Diagram/Table switch,
   and Copy data; the table scrolls inside the same height, so neither the
   finished call nor the switch moves anything. While the model still writes a
   chart's arguments, the work line says it prepares a chart. Text output of
   `cld assistant`, interactive or not, prints chart data tables (one per chart
   for a group) and a card's title and value instead. Series legends wrap below
   the chart inside its fixed viewport: 18rem for ordinary charts, 8rem for
   sparkline, 10rem for stat and 12rem for barGauge. A single chart whose
   drawing is taller, such as a bar chart with many rows, takes that height up
   to 40rem and scrolls inside beyond it; charts of a group and chart views that
   load later keep 18rem. A group stacks 2..6 charts;
   `layout: "grid"` uses two columns when the chat column is at least 42rem wide,
   and one column on phones. With `linkX`, line charts of the same x type share
   a cursor on hover, arrow keys and tap. A phone tap pins it; dragging scrolls
   the page. Each chart keeps its own y axis.
   A card shows one stat tile, the same look as stats views; its `tone` is
   not shown, and its trend stays neutral because a card does not say whether
   up is better. A presented `/views/*.view.json` file renders inline
   as a chart, group, table, stats, details or explorer. Stats show 1..6 comparable key
   figures above charts, with optional scope text, sparkline and change;
   use them instead of several cards or stat charts for computed figures.
   Details show one record's 1..100 exact fields, such as a checked invoice,
   as read-only rows. Table ref columns and details ref fields show Cloud
   objects found by a script instead of Markdown links. They carry only
   `{type, id, title?}`, never a URL; on click, a confirmation precedes opening
   through the owning app's reader with the viewer's current access. The finished
   `present` summary reserves its height while loading;
   group summaries list each chart's kind and title, so every frame reserves
   its own height. Stats summaries carry per-item booleans for sparkline, sub, delta
   and comparison to reserve the exact tile height; details summaries carry the
   field count and the label, reference flag and text length of the first
   twelve fields, so wrapped values keep their room on a phone. These
   summaries contain no values. A card's text wraps instead of being cut off. While the call runs, the work
   line names the step and the place stays empty. Table header labels stay on one line and the table
   scrolls sideways, so up to eight rows fit the reserved height on a phone.
   Chart, group and explorer drawings load when Chat first shows one. Their
   headings, controls and plot areas reserve the same space while the code and
   data arrive. A drawing that came from the server stays visible until its
   browser code is ready, including when reopening history. Its accessible name
   remains available, “Loading chart” is announced politely, and its controls
   look disabled until they can respond. If that code cannot
   load, that chart shows **The chart could not be loaded** with **Reload**.
   The composer, sidebar and other chat controls remain usable while charts load
   and if loading fails.

   A table with `search` or `groupBy` shows a search field or a group choice
   beside its title. The summary reserves their space while the controls load,
   then shows them disabled until the file arrives. If the controls cannot load,
   a notice offers to reload the page. Stats also keep their reserved tiles while
   loading; if their display cannot download, the same notice offers a reload.
   Search matches the shown cells and never leaves the browser; Copy data keeps
   every row. A column's `priority` hides it on a narrow table, and each row's
   details button shows the hidden values.
   Readers validate the file again; missing or invalid data shows unavailable
   in that frame. A group chart that cannot be drawn shows unavailable in its
   own frame. The CLI fetches and validates views and prints their tables
   (first 100 rows per table, plus a table footer), or `View unavailable: <path>`.
   Stats and details use Field/Value tables; reference text includes `(type:id)`.
   An explorer shows one typed dataset in up to six chart views and a table, picked
   in the header's switcher. Its summary lists the view ids, labels and kinds
   and the `step`, `filter` and `compare` flags, so the slider row and the row
   with the series filter and the comparison pin are reserved before the file
   loads. Those rows never wrap: the slider spans the block, and a long column
   label, step name, filter label or step label in the pin is shortened on one
   line. The step name keeps the width of the longest one, so the slider never
   resizes while stepping. The chart, its legend and the table share one
   18rem viewport, also on a phone. The series filter shows the chart's colors
   only while the shown view colors its series by the filter column. A view
   that draws no value of the shown rows says so in the reader's language
   instead of showing an empty plot; only the shown view is drawn. Filtering
   removes rows from every chart and the table; the step starts at the last
   step in row order. Pinning a step and
   moving the slider adds that step as dashed lines or hollow scatter points in
   the same colors. Comparison needs a step and line/scatter views. Numeric
   axes and heatmap color bounds cover the whole dataset, so filtering and
   stepping never rescale them; date x axes follow the shown points. A selected
   row stays selected across charts and the table. The table renders up to 100
   rows of the current state, including the pinned step, in the reader's sort;
   **Copy data** copies all of them and, like a table view, puts an
   apostrophe before text that a spreadsheet would read as a formula. Explorer
   files contain plain data,
   validated on write and on every read. Filtering, steps, comparison,
   row selection and sorting run in the browser and reset on reload. The CLI prints the title,
   subtitle and the table of the initial state: the last step with every filter
   value visible (first 100 rows).
   [Tools and approvals](/en/docs/ai/tools-and-approvals) defines these contracts.
3. **Newest text.** While the turn runs this is a status: a new text replaces
   the previous one in the same element once its first sentence has streamed,
   and the place keeps its height until the turn ends. A text that ends the
   turn so far may still be the answer and keeps answer typography. As soon as
   a step starts after it, it reads quietly in the muted, smaller style of the
   intermediate texts in the expanded work line, also while an approval or
   survey waits for the user; its card says what is asked. It changes together
   with the work line's new step and keeps its line height. The place keeps the
   height the text has as the answer, also when the chat opens while a step
   runs, so nothing moves when the text turns quiet, is replaced, or becomes
   the final message.
   Finished, it is the final message in answer typography: the turn's last
   text, even if a tool call followed it. A stopped or failed turn has no final
   message; its texts stay in the work line.
4. **Actions.** Open approvals, surveys, editors, and secret prompts, and
   receipts for capability actions and for every approval the user decided.
   The question and result use the same card: a sentence with typed chips,
   Cloud's reason line, a preview of the thing, two answers naming the deed and
   target, and one outcome line. The model's `approvalReason` is not shown.
   Reasons come from the review or declared policy; legacy reviews and Actions
   without a policy read `app_asks`. On phones the card wraps within the chat.
   Where offered, the quiet **Yes, and don't ask again in this chat** link
   remembers the reviewed scope. **Always approve** is no longer offered;
   earlier choices still apply until the next major release.

   Cloud stores the review with the tool call before asking, so reloads keep
   the sentence, chips, and preview even after the app changes. Legacy reviews
   keep their original question and details. The outcome is running, done,
   rejected, not run, or unknown. A receipt states only what the app confirmed.
   A pending approval at the end of a stopped turn reads as not run. A question
   nobody answered before its turn ended reads as expired and offers **Ask
   again**, which sends a visible message through `onContinueTurn`. An answer
   that did not reach the server says so and offers **Answer again**.

   After an unknown outcome, a review's `check` Query runs once. `done` and
   `not_done` settle the card; `pending` and failed checks keep the unknown
   line. **Check again** runs only this Query once per press, never the Action.
   Without a check, there is no repeat button. Connect `onCheckAction` to the
   controller's `checkAction`; propagate failures to the card. See
   [Tools and approvals](/en/docs/ai/tools-and-approvals#read-an-action-outcome).

   Outcome times use the reader's zone. Pass `timeZone: getTimeZone(c)` from
   the page to `createAiChatTimeline` so history and the first browser render
   agree. Old history without a time shows none. Links without titles read
   "Open", "Edit", or "Download" in the reader's language.

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
value afterwards. A tool the browser runs by itself, such as a Chat code run,
counts as work, live and in history.

Screen readers do not hear the work line's ticking clock or a status while it
streams: both sit outside the conversation log's live announcements. A status
is announced once it is complete, a waiting approval as one short line such as
"Approval needed: Send email to jana@example.com" without moving focus, and the end of a turn with
work as "Answer ready". A plain answer without tools streams into the log as
before.

The live turn and its history share one layout function and the same timeline
item ids, `ai-turn:<turn id>:<segment>`. A segment is named by what opened it:
`start`, `steer:<steer id>`, or `survey:<call id>`. Consecutive steering
messages open one segment, and loading older history renames none. Results and
actions are keyed by their call. When the turn ends, the work line changes its
text and the message actions appear; nothing else moves, and host views such as
a running code job keep their state. Copy copies only the final message.

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
A turn whose last step failed and that ends without an answer also fails and
shows this notice.
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
controls. Surveys, charts, cards, presented files, editors, and capability
tables remain visible results. The saved presentation remains readable when an application
is temporarily unavailable. Cloud's built-in tools, including every code
tool, show a name in the reader's language, such as "App check" or
"App-Prüfung"; a test fails when a built-in tool has no English or German name.
Other tools without a presentation show their tool name in words.

A successful result with valid `presentation.kind: "table"` renders inline,
outside tool summaries. Rendering depends on the result itself, including in
restored history without optional application branding. Live updates replace
the previous block content without duplicating its table. Results without table
presentation remain compact; errors and approval requests retain their own UI.

Hosts can supply `AiChatActions.resolveFileLink(href)` to resolve a Markdown link
against the current conversation file manifest. Return `{path, href}` with a
reloadable host workspace URL, or `null` for ordinary links. Plain clicks invoke
`onOpenFile(path)`; modified clicks retain native navigation to that workspace
URL. Assistant resolves only existing current-chat files and same-origin links,
and any path below the chat's working folder `/temp/`, whose files its snapshot
counts but does not list; the workspace reports such a file if it is gone.
Conversation file paths are not website URLs; agents deliver files with `present`.

Assistant shows what a chat holds in the sidebar **In this chat**, in this
order: what needs attention, **Results** (files and
visualizations the assistant delivered, each with the sentence it gave),
**Your files** (uploads and voice recordings; an upload the assistant hands
over with `present` stays here), **Sources** (read web pages,
each web search with its query, and the Cloud items a tool call read, bundled
per call, without stored previews), **Working files** (everything below
`/temp/`, grouped by folder, with the storage used once it passes 70 % of the
limit), and **Context** (Project, Skills the chat used, memories remembered
from it, routines, and Secrets). Sources, Working files, and Context
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
results stored in it, because they go with it.
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

Action cards span the message column. The sentence wraps and keeps its typed
chips; the preview and two decision buttons stay within that width on phones.
Every value needed to decide belongs in the review. Technical arguments, when
available, are secondary to the reviewed consequence.

## Explore places and routes

The built-in `map` tool presents verified places, routes, and tours directly in
chat. The shared turn renderer places the first map below the tool activity and
above the answer. Pins come from Core's Geo results. Web descriptions can cite
only sources already read in that conversation; they cannot supply pin locations.
Opening hours can be unknown. Stored provider times and attribution remain with
the results.

Select a pin or a list row to show its information. Arrow keys, Home, and End move
through the list. On phones and in the Assistant panel, four rows appear first;
**All places** expands the list in the conversation. The information card keeps
its height, including when an opening schedule or description is missing.

Follow-up searches reuse `mapId` and the current revision. A second group uses
letters and a second color on the original map; later searches replace that
secondary group. Earlier questions and answers remain. The follow-up answer
includes **Jump to map**. Reloading resolves that original result from the saved
map rather than restoring the old search.

**Route here** accepts a starting address or a location the person explicitly
shares with their browser. Denying location access leaves the address option
available. Route stops have letters, and each leg shows distance and duration.
An ambiguous address shows up to five server candidates before route calculation
continues.

Inserting or moving a stop, optimizing the order, and changing travel options
produce a calculated proposal. The map keeps the original route until the person
accepts it. **Discard** preserves the route; an accepted change has a timestamp
and **Undo**. Options can apply to the entire tour or one leg. Along-route place
searches use the saved route and an explicit kilometer window. The search form
accepts an optional place name alongside the category controls; the provider
searches for that name within the selected category and route corridor. Navigation
opens the destination in an external navigation app; Cloud does not provide live
turn-by-turn navigation.

**Save as Notebook** asks for a writable notebook. Each place group becomes a
shared `:::map` block, and the complete accepted route is kept in a route block.
Large maps are saved in parts without shortening geometry or changing the
source. Saving does not call the geographic provider. The export omits `savedAt`
because the map has no durable save timestamp: opening-hours reads refresh the
viewing time, which must not change a resumable export. Notebook labels the
provenance date as the calculation date.

Confirmed progress and a link to any known partial note stay visible. **Cancel**
stops further requests and keeps saved parts. **Resume save** checks the note
before continuing; **Check save outcome** reconciles an uncertain append.
If the last part is still unresolved, check again later; it is never sent twice.
A changed map source or edited note stops the save and exposes recovery links.
An uncertain create cannot be repeated, even after 24 hours: open the selected
notebook to find the possible note. A receipt left by an earlier save flow also
opens Notebook recovery instead of creating another note.

Progress survives reload in this browser, separately for each signed-in owner,
conversation, map and revision. Completed receipts are retained to prevent a
second save of that source. Browser local storage and Web Locks support are
required; unavailable storage or another tab saving the same source produces
visible feedback before another write. Clearing browser data also removes
these receipts, so check the notebook before starting over.

A missing Geo configuration or exhausted allowance shows a short explanation
without starting a map or provider query. Budget messages include their reset
time. Only administrators receive settings links. Other failures retain the
conversation and saved results with a retry action. `GEO_COST_OVERRUN` records
actual usage and stops later paid work. The map shows charged and unresolved
credits; only an explicit click on **Continue calculation** can resume that map.
The model cannot retry it or start further paid map work in that turn. A later
user turn may request another map. Core reserves the whole chain using straight-line
distance times 2; there is no selectable kilometre allowance. This estimate is
not a guaranteed ceiling on the provider invoice. Budget refusals show required,
available and missing credits when the service supplies them. If unresolved
addresses make the reservation too large, **Change stop** offers address
suggestions. Selecting one keeps its coordinates even if the next calculation
still needs a smaller reservation. Resolve the remaining stops the same way;
editing a selected address clears its old coordinates. Suggestions consume the
same Core budget, so recovery requires credits to remain available.

Map reads, exports, and changes check the conversation's current owner. Writes
also check the saved revision before provider work. A conflict offers the current
state instead of overwriting it. A fork receives independent copies of the maps
in its copied history. The server and browser use the same saved snapshot;
tool/model transport uses compact references without route geometry.

## Handle frontend tools

Pass approval, outcome-check, frontend-tool, retry, continue, fork, message-feedback, and file
handlers through `AiChatActionsProvider`. Rich Cloud blocks remain Cloud-owned JSX inside the
generic timeline.

Applications hosting code-triggered approvals can render the same public
`AiTurnBlockView` from `@k2b/cloud/ai/ui`, inside `AiChatActionsProvider`.
Provide an active tool block in `awaiting_approval` state with its stored `review`
and pending approval metadata. Route `onApproval` back to the
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

Every turn with the default tool source offers server-run `code_run`,
`code_inspect`, `code_stop` and `code_export`, including detached CLI and
routine turns. They use Assistant's runner host and need no connected client.
Studio authoring, HTML checks, app opening, actions and HTML presentations are
not advertised in chat. Lasting Code's `code_read`, `code_write` and
`code_check` accept Code inputs only.

Only tools a client must execute wait for that client. Register matching
`frontendTools` and `clientToolIds` with `createAiChatController`. Chat
`code_secret` needs the trusted web UI; CLI and unattended turns can use existing
chat secrets but do not offer secret entry. Local CLI tools also need a
client that declares and handles them; see
[local client tools](/en/docs/ai/tools-and-approvals#run-an-optional-tool-in-a-local-cli).

Unknown client tool names are ignored. Turn and draft submissions accept at
most 64 distinct names, each 1 to 64 ASCII letters, digits, underscores or
hyphens. Duplicates, excessive counts and malformed names are rejected.

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

`code_run` accepts inline JavaScript/TypeScript `code` and optional current-chat
`inputPaths`, and returns a run ID and compact state. Saved Studio `id`,
`version`, and `resourceId` contexts are unavailable on this chat path.
Runs execute in the Code runner (workerd), including background turns, with
the person's turn approvals and routine HTTP grants. Studio RSQL database
grants and app storage are unavailable; use application capabilities and
chat/Project file tools. `code_secret` opens trusted secret entry in the chat
UI; it does not start a browser execution host.
See [One-off chat jobs](/en/docs/platform/code-runs#one-off-chat-jobs) for limits:
the runner's deadline includes approval waits and its bridge limits also
apply to selected files and exports.
`code_run` and `code_inspect` also return `views`: paths and chart, group, table, stats, details or explorer
summaries without values. Present each view with `present({path})`.
`code_inspect` returns status, progress, logs, output and captured files, and can
wait for background work with `waitMs`.
`code_export` copies a captured file into the originating chat.

### Chat code execution

Assistant owns the chat host and persists call ownership, results and ordered
approvals. One-off scripts execute on the Code runner. Closing the browser tab
does not stop a run; a lost host is never replayed. `code_secret` opens trusted
secret entry in the web interface. Native views and exported files remain chat
files. For lasting Code, use the Code tools and [Code authoring](/en/docs/platform/gustav-code-tools).

Studio apps, HTML checks and presentations, machine execution, and the direct
`cld assistant code` commands are retired. See [Studio retirement](/en/docs/operations/studio-retirement).

### Inspect background results

Delivered background results use ordinary assistant prose with
`meta.scheduledTask` identifying the routine and occurrence. The timeline displays a
**Background run** control above the result. Hosts provide
`AiChatActions.onOpenScheduledTaskRun(taskId, occurrenceId)` to open their
permission-checked run detail view. Assistant shows the result, execution history,
and controls for returning to the chat or managing the routine.

### Open chat content beside the conversation

The context panel opens files, images, native views, sources and Project
knowledge beside the conversation. Tabs keep their state when switching.
External references open separately. On small screens, the chat header's Open
menu provides the same entries. Closing a dirty text editor asks before
discarding edits.

### Working plan and chat context

Assistant shows the current working plan above its composer. The collapsible
list uses the portable, controlled `Chat.Tasks` component from `@k2b/ui`.
Applications supply items, disclosure state, localized labels and progress text.
One segment per task shows completed work in green, the current step in the
accent color, pending work in gray, and cancelled work with a striped segment.
Symbols and text provide the same information without color. Cancelled tasks
are counted separately. The current step remains visible after stopping; it is
only described as in progress while its turn is actually running.

Compact context entries use one line and consistent icon alignment. Working
files include the latest one-off script runs and their full count. The chat
workspace opens files, sources and knowledge; it does not mount Studio app or
routine tabs. Routine details remain in dialogs until routine retirement.


Secrets management uses a list with an empty-state action. Adding or replacing
a secret opens a separate dialog. Validation errors appear at their fields;
network errors and revision conflicts remain explicit. A Bearer preset supplies
the exact `Bearer ` prefix. API-key and custom-header modes remain available.
The target is an HTTPS origin: URL paths and query parameters do not narrow the
secret's destination. Only metadata is returned when listing or replacing;
existing secret values are never loaded into the browser.

Completed working plans hide automatically once every task is completed or cancelled.
A checklist action beside context usage reopens or hides the saved plan. New open
tasks restore the plan automatically; switching chats resets the disclosure.

## Select commands and inline context

Assistant recognizes `/` at a word boundary anywhere in the composer. **+**
opens the same list with a search field on top, including on phones. Its
sections stay in this order: **Recent**, **Insert**, **Skills**, **Files in this
chat**, **This chat**, **Routines**, **Open in apps** (German: **Zuletzt** and
**In Apps öffnen**).
Files appear when searching or narrowing to files. Type a name, or narrow by
typing one of these words followed by a space:

| List | German and English words |
| --- | --- |
| Skills | `skill`, `skills` |
| Files in this chat | `datei`, `dateien`, `file`, `files` |
| Projects | `projekt`, `projekte`, `project`, `projects` |
| Models | `model`, `models`, `modell`, `modelle` |
| Routines | `routine`, `routinen` |

**Open in apps** lists Commands that accept an empty input from other apps in
your navigation. Choosing one saves this chat's draft with its references and
attachments, then opens the app with a return link to the chat. A new or project
composer creates the chat before saving. The target app decides whether to use
the return link; returning restores the saved draft.

While the catalog loads, placeholders stay at the end of the list. If loading
fails, choose **Try again**. A save conflict or failure opens nothing and gives
the reason in the composer status line. If the app cannot be reached, the menu
stays open with an explanation on the row; choosing it again retries. After the
page changes, the target app shows its own errors and checks access.

The full words also list their category without a trailing space, including
`/project` and `/projekt` for Projects.

For example, `/skill invoice` searches Skills. Exact words win; from three
letters, the shortest completion wins when unique. Move with the arrow keys
and choose with plain Enter or Tab. Tab on a narrowing row writes its word;
Enter runs its action, or narrows if it only offers a list. Shift+Enter adds a
line, Shift+Tab moves focus back, and Ctrl/⌘+Enter sends. Escape closes the menu
for this `/`, even if you keep typing. `/ ` opens nothing, so `50 / 2` stays
arithmetic. An unmatched search shows its query; adding a space closes the menu
and leaves the text. URLs, paths, and code remain text.

Suggestions temporarily replace the task list; closing restores it and its open
state. Matching previous results stay visible while the next search loads.
Switching lists clears previous results. Screen readers announce the number
of suggestions once the search settles.

**Insert** (**Einfügen**) starts with **Insert from Cloud** and **Attach file**.
Choose **+**, then **Attach file** to use the device and app file selection.
**Insert from Cloud** (**Aus Cloud einfügen**) inserts a reference into the text
at the caret stored when **+** was pressed. It replaces the former resource
attachment from the **+** menu; the model receives the same resource.
A space separates the reference from a preceding word. Search tags such as
Notes appear here only while typing. In German, `/notiz q3` narrows
the list to **Notizen aus Notebooks**; Enter opens Notes in the resource picker
with `q3` already entered. The retired Studio `/app` scope is no longer offered.

Cloud searches end with **Search Cloud for “…”**, or the corresponding search
row for a tag scope. An unmatched `/xylo` shows **Nothing found for “xylo”** and
that Cloud search row. The picker previews resources you can read. Choosing one
inserts its name as a reference where `/…` was; Ctrl/⌘+Z restores the token in
one step. Escape in the picker keeps `/…` and returns focus to the composer.
From **+**, cancelling the picker restores the stored caret or selection.
Escape, **+** again, Back on a phone, or a press outside closes the list;
an outside press with any pointer type does not activate what lies beneath it.
**Search this chat** is a row in **This chat** in the same list.
References remain available while a response runs. File attachment waits for
the response to finish. Cloud insert rows explain when the message has reached its
16-item limit, counting attachments and inline references together. If the
message fills up while the picker is open, the choice is not inserted, `/…`
stays, and the composer shows the limit.

**Recent** (**Zuletzt**) leads the list before you type. It shows up to four
references you sent in your own Assistant messages, the ones you sent most
often first, then the most recent. Each row names the item and one line with its
kind and place, such as **Note · Sales**. Choosing one inserts the reference
like any insert row. While you type, **Recent** is gone: matching recent
references come first in **Insert**, recent Skills first in **Skills**, and
`/notiz q3` lists matching recent notes above the row that searches Notes. Each
entry appears once, so a Skill under **Recent** is not repeated under
**Skills**. Without history, the list starts with **Insert**.

The server checks each reference before it names it: up to eight of your
latest different references are read again by their app as you, and anything
you can no longer read, or whose app does not answer in time, is left out.
Routine runs and messages from other chats do not count. Recent loads once
when the composer appears. If you type `/` before it arrives, or the load
fails, that list opens without **Recent** and nothing is added while it is
open; the next `/` shows it, or asks again after a failure. A failed load shows
no error, because nothing in the list depends on it. Actions are never sorted
by your use. See
[AI resources and access](/en/docs/ai/resources-and-access#recently-sent-references).

The Skills overview shows the first four enabled Skills. If there are more,
**All N Skills** narrows to the full Skill list with Enter or Tab. If the Skill
list fails to load, **Skills could not be loaded** with **Try again** takes the
place of the Skills; the other sections stay. Choosing it loads the list again.

The **This chat** entries are **Choose model**, **Assign to project**,
**Compact chat**, **Fork chat**, **Search this chat**, and **New chat**.
Choose model opens the composer's model menu. Type `/model ` or `/modell ` to
list models directly; a check marks the current model. Choosing another model
applies it to this chat and confirms the choice. You can change models once the
current response finishes. While you record a dictation, Choose model lists the
models instead of opening the menu. Assign to project opens the Project list.
The names `/compact`, `/fork`, and `/new` still find those actions. Compact chat
summarizes older history to free up room. Fork chat starts from the latest
assistant response and brings your draft along. New chat starts empty and keeps
the previous chat in the list. Search this chat opens search scoped to this
chat's messages and files. It is absent from the overview for an empty chat;
searching for it explains why it is unavailable. Compact and Fork are absent
from the overview until their prerequisites are met; searching finds them with
a reason. While a response runs, they remain visible with a waiting reason. An unavailable command explains why. Selecting
it leaves the menu open. Cancelling a command keeps `/…` in your unchanged
draft; failures restore it too and show a message above the composer until the
next edit or command.
Commands preserve the surrounding draft. Skills and files insert
highlighted references. Editing a reference's
label turns it into ordinary text; undo restores its identity. Saving and
reopening a draft preserves references, including versioned conversation files.
Project file references name a read-only path in the current Project.

**Routines** offers **New routine** and your own routines.
New routine inserts a reference to Assistant's scheduled-tasks Skill;
send it with your request to describe what should happen and when. If you
turned off that Skill, or it is unavailable to you, the row explains why and
inserts nothing.

Choosing an active routine runs it now. The composer shows a starting status while
the request is pending and a running status only after the server accepts the
run. The result arrives in the routine's chat. A failed request restores
`/…` and explains the failure in plain words: the routine already runs, no longer
exists, was started too often, or was not accepted. If the server is
unreachable or gives no clear answer, the composer says it cannot tell whether
the routine started. Choosing the routine again in the same browser tab, also after a
reload, checks the earlier start instead of starting it a second time. If that
run already finished, the status says so and points to the routine's chat. Paused routines say **Paused. Resume the routine first.**
Routines that need attention explain that you must intervene before they can run.
Selecting either sends no run request.

Routines load once per menu opening. The overview shows up to five routines, newest
first, after New routine. Searching or narrowing with `routine` or
`routinen` shows all matching loaded routines, including paused routines and those
that need attention; completed routines are excluded. If routine loading fails,
**Routines could not be loaded** with **Try again** replaces the routine
rows. Choosing it reloads the list and preserves `/…` while results load.

Selecting a Project permanently assigns a previously unassigned chat. Future
turns use that Project's instructions and files. Once the chat belongs to a
Project, assignment leaves the overview. Searching for it explains the existing assignment; the narrowed Project list also shows
why another Project cannot be chosen. A stale selection cannot replace an existing
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
`searchCommands(query, signal, { scope })`, and an `accessory` for the shared task surface.
Application authors define fixed sections with `commandSections` and assign
rows through `section`. Define narrowing words with `commandScopes` and give
a row a `scope` to let Tab write its first word. Resolved scopes send only the
remaining search text and the scope id to the callback. Use `hiddenUntilSearch`
with `reason` for commands that do not apply, `keywords` for alternate names,
and `app` for a searchable application name. Titles and one description or
reason wrap without truncation; title matches appear in bold. See the
[Chat component](/en/ui/ai/chat#commands-and-file-selection) for ranking and
loading rules.
Set `draftKey` to the conversation or draft identity to isolate undo history.
A command can supply an action or a `mention` containing a `ChatAttachment`;
its payload stays application-owned. Mention offsets use the untrimmed text's
UTF-16 positions. Use `aiComposerDraft()` to restore an ordered server draft and
`aiComposerSendInput()` to preserve it when saving or sending. Hosts allowing
context during an active response must handle the `queue` intent; steering
continues to accept text only.
