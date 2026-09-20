# Chat

`Chat` is a controlled compound component for assistants and other conversational workflows. It has no knowledge of Cloud sessions, providers, tool protocols, persistence, or uploads.

`ChatTimeline` softly fades its bottom edge while more messages remain below.
The latest-message button and composer stay outside the fade. At the end of
the conversation the fade disappears. Set `scrollFade={false}` to opt out;
forced-color mode always leaves content unmasked.

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

`Chat.Composer` calls `onSubmit` with an `intent`, untrimmed text, generic attachments, and optional inline mentions. The intent is `send` while idle and `steer` while a response is running. Return `false` or throw to restore the consumed draft, attachments, and mentions; failures are passed to `onError`.

Use `state="running"` to show Stop when the draft is empty. Once the user types, Send replaces Stop and submits a steer. `menuActions` populate the Plus menu; `contextActions` sit beside context usage. `contextPopupAction` places one small action inside the context details popup and keeps it available before token usage is reported. Model options can provide an icon or provider image. Use `submitTools` for compact application controls immediately before Send or Stop; `footerTools` remains beside the add/model controls. `modelDetails` places compact application-owned details immediately after the model selector. The application owns these controls and their state. `footerContent` replaces the footer during an application-owned interaction, such as audio recording, while preserving the editor. Pass `undefined` to restore the standard controls.

Every structured chat action declares exactly one behavior: `onSelect` for an
application callback or `copyText` for clipboard content. The same contract is
used by message, menu, and context actions. Set `pressed` for persistent toggle
state such as a saved helpful rating; inline actions expose it through
`aria-pressed`.

Pasted files use the same `fileSelection.onSelect` callback as the file picker
and drag-and-drop. Use the generic `onPaste` seam only for non-file content;
call `preventDefault()` synchronously only when the application replaces the
native paste. Attachments may expose one compact application-owned action such
as moving a text attachment back into the message field. Composer attachments
stay on one horizontally scrollable row, and the controlled text field grows
up to approximately fifteen visible lines.

`Chat.Timeline` follows new messages and growing rich content while the reader remains near the bottom. Content and viewport resizing keep the latest item visible without overriding a reader who has scrolled upward. Set `hasMore` and `onLoadOlder` to load history while preserving the visible scroll position.

Use `scrollToAnchorRef` to receive a function that scrolls to a rendered `anchorId` and pauses following. It returns `false` if the anchor is not rendered yet; load the relevant history first. This also works behind an open dialog where browser focus is blocked. Following resumes when the reader returns to the bottom.

On hover-capable fine pointers, the timeline keeps its scrollbar thumb hidden
until the timeline is hovered or contains keyboard focus. Its stable scrollbar
gutter prevents the conversation from shifting when the thumb appears. Touch,
coarse-pointer, and forced-color environments retain their normal visible
scrollbar treatment.

Pass `timeLabel` for visible localized timestamps and `createdAt` for the
machine-readable `dateTime` value. `createdAt` alone intentionally renders no
runtime-locale text, which keeps SSR and hydration stable.

## API reference

```ts
type ChatRole = "user" | "assistant" | "system" | "tool";

type ChatMessageStatus = "pending" | "streaming" | "complete" | "error";

type ChatActivityTone = "neutral" | "ai" | "success" | "danger";

type ChatActionBase = {
  id: string; label: string; icon?: string; variant?: "danger"; disabled?: boolean; pressed?: boolean;
  pressedTone?: "success" | "danger";
};

type ChatAction = ChatActionBase &
  ({ onSelect: () => void | Promise<void>; copyText?: never } | { copyText: string; onSelect?: never });

type ChatAttachment = {
  id: string; name: string; size?: number; kind?: "file" | "image" | "resource"; icon?: string;
  previewUrl?: string; alt?: string; href?: string; data?: unknown; action?: ChatAction;
};

type ChatModelOption = {
  id: string; label: string; description?: string; image?: string; icon?: string;
  capabilities?: readonly string[];
};

type ChatComposerState = "idle" | "submitting" | "running" | "stopping";

type ChatSubmitIntent = "send" | "steer" | "queue";

type ChatSubmitInput = {
  intent: ChatSubmitIntent; text: string; attachments: readonly ChatAttachment[];
  mentions?: readonly ChatMention[];
};

type ChatMention = { start: number; end: number; attachment: ChatAttachment };

```

### Commands and file selection

```ts
type ChatCommandContext = {
  setValue: (value: string) => void; submit: () => void; focus: () => void;
};

type ChatCommand = {
  name: string; description: string; icon?: string; label?: string; disabled?: boolean;
  action?: (context: ChatCommandContext) => void | Promise<void>;
  mention?: ChatAttachment;
};

type ChatFileSelection = {
  onSelect: (files: readonly File[]) => void | Promise<void>; onError?: (error: unknown) => void;
  accept?: string; multiple?: boolean; disabled?: boolean; label?: string;
};

type ChatPasteHandler = (event: ClipboardEvent & { currentTarget: HTMLTextAreaElement; target: Element }) => void;

```

### Root and timeline

```ts
type ChatRootProps = {
  children: JSX.Element; class?: string; label?: string;
};

type ChatMessageItem = {
  kind: "message"; id: string; role: ChatRole; content?: JSX.Element; label?: string;
  createdAt?: string | Date; timeLabel?: string; status?: ChatMessageStatus;
  attachments?: readonly ChatAttachment[]; actions?: readonly ChatAction[];
  actionDisplay?: "auto" | "inline" | "menu"; anchorId?: string | number; class?: string;
};

type ChatActivityItem = {
  kind: "activity"; id: string; label: string; description?: string; icon?: string; leading?: JSX.Element;
  accent?: string; tone?: ChatActivityTone; busy?: boolean; trailing?: JSX.Element; defaultOpen?: boolean;
  anchorId?: string | number; content?: JSX.Element; class?: string;
};

type ChatTimelineItem = ChatMessageItem | ChatActivityItem;

type ChatTimelineProps = {
  items: readonly ChatTimelineItem[]; conversationKey?: string | null; loading?: boolean; hasMore?: boolean;
  loadingOlder?: boolean; onLoadOlder?: () => boolean | void | Promise<boolean | void>; emptyTitle?: string;
  emptyDescription?: string; navigation?: JSX.Element; onActionError?: (error: unknown) => void;
  viewportRef?: (element: HTMLDivElement) => void; contentRef?: (element: HTMLDivElement) => void;
  scrollToAnchorRef?: (scrollToAnchor: (anchorId: string | number) => boolean) => void;
  label?: string; followThreshold?: number; scrollFade?: boolean; class?: string;
};

```

### Composer

```ts
type ChatComposerProps = {
  value: string; onValueChange: (value: string) => void;
  onSubmit: (input: ChatSubmitInput) => boolean | void | Promise<boolean | void>;
  runningSubmitIntent?: "steer" | "queue"; onStop?: () => void | Promise<void>;
  onError?: (error: unknown) => void; state?: ChatComposerState; attachments?: readonly ChatAttachment[];
  onAttachmentsChange?: (attachments: readonly ChatAttachment[]) => void; fileSelection?: ChatFileSelection;
  onPaste?: ChatPasteHandler; menuActions?: readonly ChatAction[]; models?: readonly ChatModelOption[];
  selectedModelId?: string | null; onModelChange?: (modelId: string) => void;
  commands?: readonly ChatCommand[]; contextUsage?: ChatContextUsageData;
  searchCommands?: (query: string, signal: AbortSignal) => Promise<readonly ChatCommand[]>;
  mentions?: readonly ChatMention[]; onMentionsChange?: (mentions: readonly ChatMention[]) => void;
  accessory?: JSX.Element; draftKey?: unknown;
  contextActions?: readonly ChatAction[]; contextPopupAction?: ChatAction; footerTools?: JSX.Element; modelDetails?: JSX.Element;
  submitTools?: JSX.Element; footerContent?: JSX.Element; placeholder?: string; label?: string;
  inputLabel?: string; disabled?: boolean; error?: string; focusToken?: unknown; class?: string;
};

```

### Direct message and activity components

```ts
type ChatMessageProps = {
  role: ChatRole; children?: JSX.Element; label?: string; createdAt?: string | Date; timeLabel?: string;
  status?: ChatMessageStatus; attachments?: readonly ChatAttachment[]; actions?: readonly ChatAction[];
  actionDisplay?: "auto" | "inline" | "menu"; anchorId?: string | number;
  onActionError?: (error: unknown) => void; class?: string;
};

type ChatActivityProps = {
  label: string; description?: string; icon?: string; leading?: JSX.Element; accent?: string;
  tone?: ChatActivityTone; busy?: boolean; trailing?: JSX.Element; open?: boolean;
  onOpenChange?: (open: boolean) => void; defaultOpen?: boolean; bodyInset?: boolean;
  anchorId?: string | number; children?: JSX.Element; class?: string;
};
```

`ChatRootProps` belongs to `Chat`, the other component props to `.Timeline`, `.Composer`, `.Message`, and `.Activity`. `ChatActionBase` is the common shape shown here; consumers import `ChatAction`. For usage data see [Context usage](/en/ui/ai/context-usage#api-reference).

Defaults: composer `state="idle"`, `runningSubmitIntent="steer"`; timeline `followThreshold=96` CSS pixels. Set `runningSubmitIntent="queue"` to submit queued messages while running. `submitting` and `stopping` block submission. `onLoadOlder` can return false to report that no page was loaded; rejected loads become retryable history errors. `onStop` may be async and failures reach `onError`.

`Chat.Activity` supports controlled `open`/`onOpenChange`; timeline activity records expose only `defaultOpen`. `bodyInset` belongs to the direct Activity component, not the timeline record. Message/activity `content` is JSX, not automatically parsed Markdown. Use `MarkdownView` for Markdown strings.

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

```tsx typecheck
import { Chat, MarkdownView, type ChatTimelineItem } from "@k2b/ui";
import { createSignal } from "solid-js";

export function Conversation() {
  const [draft, setDraft] = createSignal("");
  const [items, setItems] = createSignal<ChatTimelineItem[]>([
    { kind: "message", id: "welcome", role: "assistant", content: "How can I help?" },
  ]);
  return (
    <Chat label="Project conversation">
      <Chat.Timeline items={items()} conversationKey="project" />
      <Chat.Composer
        value={draft()}
        onValueChange={setDraft}
        onSubmit={({ text }) => {
          setItems((current) => [...current, {
            kind: "message", id: crypto.randomUUID(), role: "user",
            content: <MarkdownView markdown={text} />,
          }]);
        }}
      />
    </Chat>
  );
}
```

The timeline shows the latest message before JavaScript loads. Messages remain
in chronological order, and loading older messages preserves the reader's position.

Feedback actions can set `pressedTone="success"` or `pressedTone="danger"` to
mark their selected state with the semantic icon color and no persistent
background. `pressed` continues to expose the toggle state to assistive technology.

Activity rows keep their label and muted metadata on one line. Use `renderBody`
for expensive diagnostic details: it is mounted only while the activity is open.
Use a bounded, keyboard-focusable scrolling region for long input/output payloads.
Busy activity uses the same text shimmer as inline guidance, with reduced-motion
and forced-colors support. Waiting for user input is a separate state.

## Working plans

Use `Chat.Tasks` above the composer for a compact working plan. Pass `items`
with stable `id`, `content`, and `status` (`pending`, `in_progress`, `completed`,
`cancelled`), controlled `open`/`onOpenChange`, a `label`, a `progressLabel`,
and localized `statusLabels`. The component renders one colored segment per
item and a bounded, scrollable disclosure. Status symbols and labels complement
color; cancelled work has a striped segment and a struck-through description.

The host decides when a plan exists, persists it, counts cancelled work
separately, and translates execution state into labels. Do not label a paused
current step as running. This component does not start tasks or infer progress.

Message file attachments use compact horizontal chips with an icon and a single
filename line. Long filenames truncate; the attachment row wraps when needed.
Image attachments retain their thumbnail presentation.


## Application-owned model details

Use `Chat.ContextPopup` in `modelDetails` for a compact button with custom
details, such as an application allowance. Pass the trigger text as children,
`content` for the panel, and a complete `aria-label`. The button defaults to
`type="button"`. Hover previews the panel; click or keyboard activation pins
it open. Escape and outside click close it. Interactive panel content is
reachable with Tab. Popup-owned click, pointer-enter/leave and ref props are
not part of its public props. Applications own data loading and authorization.

### Composer commands and mentions

Use `commands` for local actions or reference choices, and `searchCommands(query,
signal)` for asynchronous discovery. Commands match at the caret, including in
the middle of a draft. A reference choice supplies `mention: ChatAttachment`;
control its ranges with `mentions` and `onMentionsChange`. The submitted text is
untrimmed so UTF-16 range offsets remain valid. A modified reference becomes
plain text; undo/redo restores both text and reference identity.

Pass the task list through `accessory`. An empty conditional accessory reserves no
row or spacing, including after hydration. Suggestions use that same location and
restore the task list without changing its open state. Set `draftKey` when
switching conversations so undo cannot bring content from another chat back.

When changing a controlled draft outside the composer, use
`reconcileChatMentions(before, after, mentions)` from `@k2b/ui` to update its
reference ranges alongside the text. Edits before a reference shift its offsets;
edits overlapping a reference remove its identity. The helper treats the changed
span between the shared prefix and suffix as one replacement.

```ts
import { reconcileChatMentions, type ChatMention } from "@k2b/ui";

function replaceDraft(before: string, after: string, mentions: readonly ChatMention[]) {
  return { text: after, mentions: reconcileChatMentions(before, after, mentions) };
}
```
