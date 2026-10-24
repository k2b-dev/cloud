---
title: Chat interface
navTitle: Chat interface
section: AI
order: 1070
description: Present conversation state, tools, approvals, and failures with the shared chat controller and components.
tags: [ai, ui, solidjs]
updated: 2026-10-21
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

Lists, Sources, files, routines, dictations, and Project context refresh through
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
2. **Results.** Presented files and code views, `code_present` apps, charts, cards, and
   capability tables in the order they were made. A later result with the same
   target, the same file path for `present` or the same title for
   `code_present`, replaces the earlier one at its place. A running delivery
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
   sparkline, 10rem for stat and 12rem for barGauge. A group stacks 2..6 charts;
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
   its own height. Stats summaries carry per-item booleans for sparkline, sub
   and delta to reserve the exact tile height; details summaries carry the
   field count and the label, reference flag and text length of the first
   twelve fields, so wrapped values keep their room on a phone. These
   summaries contain no values. A card's text wraps instead of being cut off. While the call runs, the work
   line names the step and the place stays empty. Table header labels stay on one line and the table
   scrolls sideways, so up to eight rows fit the reserved height on a phone.
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
value afterwards. A tool the browser runs by itself, such as a Studio code run,
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
entry. A search from the sidebar's header queries `GET /api/assistant/workspace/conversations/:id/sources`, which
takes the sources route's parameters and shows an app only while the viewer may
read it, under its current title. It finds results by title, description, or
path, and files and sources the chat read; Project context it never read stays
under Context. **Sources** shows the newest 100 and loads older ones from the
same route; a new first page starts the loaded pages over. More than 200 working
folders or 100 loose working files are counted, and search finds the rest.

**In this chat** is the workspace's shared
[Detail](/en/ui/layout/workspace#detail-and-panel) with a
[`DetailPanel`](/en/ui/layout/detail-panel), like the details of Mail and the
other applications: a resizable column beside the chat when it fits next to a
480 px chat column, otherwise a drawer behind **Details** in the workspace head,
and a page on phones that its close button or Escape leaves. The column is open
by default. Closing it is remembered in the `assistant_context=closed` cookie,
which the page reads before rendering; reopening deletes it. Parking the drawer
or the phone page is not remembered. An action that leaves the details, such as
opening a file or jumping to a result, parks a drawer or phone page first. An
empty **Results** section reads **None yet**. The workspace's **Files** tab
shows the same list.

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

Action cards span the message column. The sentence wraps and keeps its typed
chips; the preview and two decision buttons stay within that width on phones.
Every value needed to decide belongs in the review. Technical arguments, when
available, are secondary to the reviewed consequence.

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

Every turn with the default tool source offers the server-run code tools
`code_run`, `code_action`, `code_inspect`, `code_stop`, `code_export`, and
`code_present`, and `code_check`, whichever client submits it: the web app,
`cld assistant` with or without `--detach`, an API client, or a routine.
Cloud runs them in an Assistant-owned host, so they need no client.

Only tools that a client must run wait for that client. A frontend handler alone
does not advertise them to the model. Pass `clientToolIds` to
`createAiChatController` and register matching `frontendTools`. The controller
forwards only IDs that have a handler. The client-run tools are `code_open` and
`code_secret`, which need a client with a code host: the web app, or
`cld assistant` while it watches the turn. Entering a secret through
`code_secret` still needs the web app; in the CLI the call fails with that
hint. The local client tools `local_bash`, `local_list`, `local_read`,
`local_upload`, `local_download`, `local_write`, `local_move`, and
`load_local_skill` also need a client that declares and handles them.
See [local client tools](/en/docs/ai/tools-and-approvals#run-an-optional-tool-in-a-local-cli)
for execution and approval boundaries. Detached CLI
turns, API clients without a code host, and routines never get `code_open` or
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
`code_run` and `code_inspect` also return `views`: paths and chart, group, table, stats, details or explorer
summaries without values. Present each view with `present({path})`.
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
themes with the viewer's locale/time zone. Background checks use the routine time
zone and the default locale/light theme when no preferences are available.
CLI checks use a light desktop theme and the service locale/time zone.
For a saved app, each run uses a separate disposable copy
of the app database, shared KV/files and only the checking user's personal KV.
Reads and writes use the normal services; real app data stays unchanged. A
database above 1000 rows or 16 MiB uses schema only and reports a warning.
Storage copies are limited to 250 MiB. In a background turn, checking a saved
app with a connected database requires a routine grant that allows `export` for
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
`[object Object]` warn in the page and in PDFs.

`cloud.chart(options)` returns chart markup for apps, scripts and PDFs without
needing a DOM. It takes the same kinds and options as chat charts and maps them
through the same path: bar, line, scatter, pie, donut, histogram, gauge,
sparkline, boxplot, heatmap, barGauge and stat. See
[Tools and approvals](/en/docs/ai/tools-and-approvals#tool-contracts) for data,
axes, declarative formats, references, thresholds, series style/role and limits.
There is no grouped or stacked bar mode, or second y axis. For related computed
measures in chat, use `cloud.view.group`.

Function `format(value)` is also accepted on axes and values. `width` and
`height` set the logical size: 480 × 280 by default, or 160 × 40 for sparkline.
Apps redraw stretched charts at their measured width when `width` is omitted;
pie, donut and gauge keep their aspect ratio. Date and ISO-with-offset x values
become the viewer's wall-clock time; ISO strings without an offset, including
`YYYY-MM` and date-times with a space or fractions, stay as written. When every
x is at midnight, the axis shows days. Date references become wall-clock
date-time strings. Labels may be numbers. Category labels remain complete; some
are skipped when they do not fit.

An app redraws with whatever its data or filters leave, so `cloud.chart()`
does not apply the chat's size and fit limits: empty data, a one-point line,
more than 8 series or 480 points, empty titles and long labels draw, and
missing or non-finite values are left out. It throws `invalid` with a path such
as `series[0].data[2].x` for unknown kinds and wrong option types, and for
input the renderer cannot draw: a fixed domain that does not contain every
value, or values too close for their size to label an axis. Options supported
only by stdlib and outside this contract are ignored.
Pie and donut slices show shares, so a value `format` only changes the values
in chat tooltips and tables. A scatter comparison series (`role: "reference"`)
draws hollow points in chat; `cloud.chart()` draws them filled.

Checks use the existing host admission and a 45-second deadline. Each user can
hold at most 16 disposable check copies at a time, two for each of the eight
admitted code hosts; another start fails with `limit` until a check finishes or
the sweep removes copies of crashed checks. Output is at
most three screenshots, each up to 2000 px tall, and 64 downloads, 50 MiB per
file and 250 MiB total.
The accessibility tree is limited to 4 KiB. Cancellation closes pages and removes
copies; crashed hosts leave a durable cleanup marker for the service sweep
and bounded, best-effort cleanup before each new check.

CLI users run `cld assistant code check ID --chat CHAT`. CHAT is the chat ID
shown in Assistant (the public short ID). For one-off files, omit
ID and pass `{files}` through `--input-file` or stdin. Local Chromium runs the
same check and saves screenshots/downloads as local files. Use `--out DIR` to
choose the output directory; otherwise the command creates and prints a new
temporary directory. Text and JSON output
include each local path alongside its chat path. Existing local files are not
overwritten.

Assistant exposes direct server tools: `code_create`, `code_read`, `code_write`,
`code_import`, `code_remove`, `code_list`, `code_history`, `code_update`,
`code_fork`, `code_publish`, `code_versions`, `code_restore`, and `code_sql`.
These are deferred built-ins with flat inputs, not application capabilities.
`CODE_SOURCE_TOOLS` from `@k2b/cloud/ai` supplies their shared input contracts.
Core forwards each operation to Assistant using an operation-bound invocation.
The server derives the chat context and checks current user, conversation,
Project and resource permissions. GUI and CLI use the same resource services.
Writes reuse the platform replay guard; uncertain calls are not repeated.
`cloud.capabilities.run` remains available for other applications, not these tools.
`code_create` accepts optional top-level `html` and `steps` strings for the initial
`index.html` and `steps.json`, so a small single-file app can be created in one call.
Without `html`, it starts with a minimal page; supplied source returns diagnostics
without rejecting incomplete code.
`code_write` saves one complete file per call with top-level `path` and `content`.
Source text travels only in top-level strings because some providers corrupt
strings nested in array arguments. Other files stay unchanged. Pass the revision
from `code_read`, `code_create` or the previous write as `expectedRevision`, then
chain each returned revision into the next call. A stale revision returns
`CONFLICT` without saving. Re-read and reconcile before retrying. The tool
description tells the model to send one write at a time: calls sent together in
one model response share a revision, so every call after the first conflicts.
Results list `lines` and `length` (UTF-16 units) for every file, so a model
can see when content arrived cut, plus compiler diagnostics for the saved state.
A trailing newline adds no extra line. Diagnostics do not reject incomplete
source: a missing import remains a finding until its file is saved. A normal
multi-file build is one call per file with no approval.

`code_import` atomically copies exact chat, Project or App `fromFile` references
as UTF-8 source without printing their bytes. Use `code_file_stat` first. Imports
carry references only and receive one fresh review for the whole batch, because
source may be shared or published. Source file and bundle byte limits apply;
stale destination revisions, source versions or duplicate paths reject the batch.
Relative JSON imports expose data; CSV/TSV/TXT imports expose text. Execution
requires a compilable entry exporting one function.

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

An app, calculator, converter, timer, form or other tool a person asks for is a
saved Studio app, even when it keeps no data: the `code_create` prompt hint and
tool descriptions route it there, so it appears in the Studio catalog. Charts,
tables, key figures and explorers of a one-off result stay views. A small app
takes one `code_create` with its first `html` and `steps`, one `code_check` with
its screenshot review, and `code_open`. `code_present` with `files` shows a
throwaway card only when the person asks for a preview they do not want to keep.

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
`meta.scheduledTask` identifying the routine and occurrence. The timeline displays a
**Background run** control above the result. Hosts provide
`AiChatActions.onOpenScheduledTaskRun(taskId, occurrenceId)` to open their
permission-checked run detail view. Assistant shows the result, execution history,
and controls for returning to the chat or managing the routine.

### Open chat content beside the conversation

The context panel is the entry point for apps, files, images, sources, project
knowledge, and routines. Compact sections show a preview; View all opens
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
voice inputs), sources and references, project knowledge, and routines
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

Code source edits use `code_write({id, expectedRevision, path, content, entry?})`
to save one file per revision. File imports use
`code_import({id, expectedRevision, files: [{path, fromFile}], entry?})` with exact
versioned references from `code_file_stat`. One review covers the import batch.
JSON and CSV/TSV/text imports are supported. Stale destination revisions or source
versions fail before saving any files. Both tools return `lines` and `length` for
every file, the new revision, and diagnostics.
CSV previews expose encoding, delimiter and raw-text choices; Assistant remembers
those choices in browser-local preferences, without modifying uploaded files.

Studio resource URLs, tool inputs and references use six-character Cloud short
IDs. UUIDs remain internal database keys and are rejected as public resource IDs.
Existing resources receive short IDs during migration; no UUID URL alias exists.
Assistant endpoints that take a chat also accept its short ID and check the same
chat permissions for both forms.


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
| Studio apps | `app`, `apps`, `studio` |
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
with `q3` already entered. `/app q` narrows to Studio apps from Assistant, even
before the catalog loads.

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
Commands preserve the surrounding draft. Skills, Studio apps, and files insert
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
