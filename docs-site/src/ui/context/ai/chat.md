# Chat

`Chat` is a controlled compound component for assistants and other conversational workflows. It has no knowledge of Cloud sessions, providers, tool protocols, persistence, or uploads.

## Use Chat

Compose `Chat.Timeline` and `Chat.Composer` inside `Chat`. The application owns messages, draft, attachments, model selection, run state, and mutations. The components own keyboard behavior, scrolling, focus, disclosures, structured actions, and accessible status presentation.

Timeline items are plain message or activity records. Message actions and attachments are structured arrays; activity bodies remain JSX so an application can render rich tool results without coupling the package to a protocol.

Use `leading` when an activity needs a host-owned visual such as a favicon. Use
the optional `accent` only for source or application identity; `success` and
`danger` tones continue to own semantic state colors. Keep the rich activity
body in the host so `Chat` remains independent from tool protocols.
Set `busy` on an activity while work is running. It applies a quiet horizontal
text-color-to-transparency shimmer to the activity icon and title; reduced-
motion clients keep the text static. Streaming messages retain the minimal
three-dot indicator. Applications should not add another spinner or visible
generating label.
Activity bodies are inset beneath their row by default. Set `bodyInset={false}`
when the body is a peer list that should align with the activity row itself.

## Import

```tsx
import { Chat, type ChatTimelineItem } from "@k2b/ui";
```

## Controlled behavior

`Chat.Composer` calls `onSubmit` with an `intent`, trimmed text, and generic attachments. The intent is `send` while idle and `steer` while a response is running. Return `false` or throw to restore the consumed draft and attachments; failures are passed to `onError`.

Use `state="running"` to show Stop when the draft is empty. Once the user types, Send replaces Stop and submits a steer. `menuActions` populate the Plus menu; `contextActions` sit beside context usage. Model options can provide an icon or provider image.

Every structured chat action declares exactly one behavior: `onSelect` for an
application callback or `copyText` for clipboard content. The same contract is
used by message, menu, and context actions.

Pasted files use the same `fileSelection.onSelect` callback as the file picker
and drag-and-drop. Use the generic `onPaste` seam only for non-file content;
call `preventDefault()` synchronously only when the application replaces the
native paste. Attachments may expose one compact application-owned action such
as moving a text attachment back into the message field. Composer attachments
stay on one horizontally scrollable row, and the controlled text field grows
up to approximately fifteen visible lines.

`Chat.Timeline` follows new messages and growing rich content while the reader remains near the bottom. Content and viewport resizing keep the latest item visible without overriding a reader who has scrolled upward. Set `hasMore` and `onLoadOlder` to load history while preserving the visible scroll position.

On hover-capable fine pointers, the timeline keeps its scrollbar thumb hidden
until the timeline is hovered or contains keyboard focus. Its stable scrollbar
gutter prevents the conversation from shifting when the thumb appears. Touch,
coarse-pointer, and forced-color environments retain their normal visible
scrollbar treatment.

Pass `timeLabel` for visible localized timestamps and `createdAt` for the
machine-readable `dateTime` value. `createdAt` alone intentionally renders no
runtime-locale text, which keeps SSR and hydration stable.

## Accessibility

Pass a useful conversation `label` when more than one chat is visible. Visual role labels are intentionally omitted, while screen readers still receive the message role. Time, status, menus, attachments, model selection, context usage, and history loading remain keyboard reachable and named.

User metadata appears on hover or keyboard focus and remains visible on devices without hover. Color and icons are supplementary.

## Runtime

Initial messages render on the server. Editing, commands, scrolling, file selection, menus, model changes, and submission require hydration.

Raw files selected, dropped, or pasted are handed to
`fileSelection.onSelect`. The package never uploads, persists, streams,
authorizes, retries, or executes tools.

The family uses `--k2b-ai-accent`, `--k2b-ai-accent-hover`, `--k2b-ai-border`, and `--k2b-ai-surface`, which can be themed independently from the general accent stack.

## Example

```tsx
const [draft, setDraft] = createSignal("");

<Chat>
  <Chat.Timeline items={items()} conversationKey={conversationId()} />
  <Chat.Composer
    value={draft()}
    onValueChange={setDraft}
    onSubmit={submit}
    state={runState()}
    attachments={attachments()}
    onAttachmentsChange={setAttachments}
    menuActions={[{ id: "new", label: "New chat", onSelect: createChat }]}
    models={models}
    selectedModelId={modelId()}
    onModelChange={setModelId}
    contextUsage={{ usage: usage(), contextWindow: 128_000 }}
  />
</Chat>;
```
