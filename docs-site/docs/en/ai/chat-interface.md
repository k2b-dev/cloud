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
- `@valentinkolb/cloud/ai` owns the controller, session protocol, persistence,
  tools, approvals, files, retry, fork, and steering policy.

Cloud adapters project protocol state and payloads across that boundary. There
is no second Cloud-specific chat component set.

## Compose a Cloud chat

```tsx
import type { AiPublicModelProfile } from "@valentinkolb/cloud/ai";
import { createAiChatController } from "@valentinkolb/cloud/ai/solid";
import {
  AiChatActionsProvider,
  aiChatModelOptions,
  aiComposerSendInput,
  createAiChatTimeline,
} from "@valentinkolb/cloud/ai/ui";
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
          onStop={chat.abort}
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
remain structured result data rather than user-facing labels. Older results
without a summary retain the complete generic input and response disclosure.
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
surface. Loaded tools use titles from the catalog snapshot already available to
the Assistant; resolving display text does not require another registry call.
While a loop is active, Assistant renders its blocks in their saved order. Once
the loop completes, it moves tool calls, reasoning, compaction, and every text
block except the final response into one collapsed **Worked for ...**
disclosure. Presented files remain directly visible as standalone results;
historical card calls keep their dedicated renderer. Failed work opens the
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

Pass approval, frontend-tool, retry, fork, and file handlers through
`AiChatActionsProvider`. Rich Cloud blocks remain Cloud-owned JSX inside the
generic timeline.

The controller claims each call once, runs the handler, and sends the result
back to the turn. Show interaction tools only when the relevant application
view is present. After the server accepts an interaction result, collapse the
form immediately into a waiting row. Keep the submitted answers in its details
while the assistant continues; never flash the empty form again between
acceptance and the next stream event. Accepted frontend-tool and approval
actions must not regress when a stale live event still contains the pending
block.

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
