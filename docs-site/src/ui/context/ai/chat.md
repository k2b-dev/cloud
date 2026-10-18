# Chat

`Chat` is a controlled compound component for assistants and other conversational workflows. It has no knowledge of Cloud sessions, providers, tool protocols, persistence, or uploads.

`ChatTimeline` softly fades its bottom edge while more messages remain below.
The latest-message button and composer stay outside the fade. At the end of
the conversation the fade disappears. Set `scrollFade={false}` to opt out;
forced-color mode always leaves content unmasked.

## Use Chat

Compose `Chat.Timeline` and `Chat.Composer` inside `Chat`. The application owns messages, draft, attachments, model selection, run state, and mutations. The components own keyboard behavior, scrolling, focus, disclosures, structured actions, and accessible status presentation.

Timeline items are plain message or activity records. Message actions and attachments are structured arrays; activity bodies remain JSX so an application can render rich tool results without coupling the package to a protocol.

`Chat.Timeline` renders rows by `id`, which must be unique within the timeline.
A new record with a known `id` updates that row in place: the message element,
its content, and any state inside it stay, even when the record object, its
status, or its actions change. Give a message the same `id` from the moment it
streams until it is stored, so finishing a response does not remount it. Pass
the same `content` element when the content itself has not changed; a new
element replaces the old one.

Use `leading` when an activity needs a host-owned visual such as a favicon. Use
the optional `accent` only for source or application identity; `success`, `warning`, and
`danger` tones continue to own semantic state colors. Keep the rich activity
body in the host so `Chat` remains independent from tool protocols.
Activity labels use the normal font weight, and their description has the same
size; hierarchy comes from color and indent. Use `ariaLabel` on an expandable
activity whose visible text abbreviates, for example "Worked 3 minutes, 49
steps" for "Worked 3 min · 49 steps".
Set `busy` on an activity while work is running. It applies a quiet horizontal
text-color-to-transparency shimmer to the activity icon and title; reduced-
motion clients keep the text static. Streaming messages retain the minimal
three-dot indicator. Applications should not add another spinner or visible
generating label.
Activity bodies are inset beneath their row by default. Set `bodyInset={false}`
when the body is a peer list that should align with the activity row itself.
An expandable row opens on a press anywhere in it, also while its label or
trailing text re-renders, such as a ticking clock: presses land on the row, and
only links, buttons, and other controls inside it stay their own targets. With
a controlled `open`, the body renders as soon as the row opens, before the host
passes its new state back.

## Import

```tsx
import { Chat, type ChatTimelineItem } from "@k2b/ui";
```

## Controlled behavior

`Chat.Composer` calls `onSubmit` with an `intent`, untrimmed text, generic attachments, and optional inline mentions. The intent is `send` while idle and `steer` while a response is running. Return `false` or throw to restore the consumed draft, attachments, and mentions; failures are passed to `onError`.

Use `state="running"` to show Stop when the draft is empty. Once the user types, Send replaces Stop and submits a steer. `menuActions` populate the Plus menu; `contextActions` sit beside context usage. `contextPopupAction` places one small action inside the context details popup and keeps it available before token usage is reported. Model options can provide an icon or provider image. Use `submitTools` for compact application controls immediately before Send or Stop; `footerTools` remains beside the add/model controls. `modelDetails` places compact application-owned details immediately after the model selector. The application owns these controls and their state. On touch screens the footer keeps 0.625rem from the message field, so the touch areas of its compact controls never take taps from the field. `footerContent` replaces the footer during an application-owned interaction, such as audio recording, while preserving the editor. Pass `undefined` to restore the standard controls.

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
up to approximately fifteen visible lines. The conversation variant grows
differently; see [Conversations between people](#conversations-between-people).

`Chat.Timeline` follows new messages and growing rich content while the reader remains near the bottom. Content and viewport resizing keep the latest item visible without overriding a reader who has scrolled upward. A reader who opens or closes an expandable row in the timeline keeps that row where it was: the timeline does not follow the end for that change, and it keeps following new content only if the end is still in view afterwards. Set `hasMore` and `onLoadOlder` to load history while preserving the visible scroll position.

Use `scrollToAnchorRef` to receive a function that scrolls to a rendered `anchorId` and pauses following. It returns `false` if the anchor is not rendered yet; load the relevant history first. This also works behind an open dialog where browser focus is blocked. Following resumes when the reader returns to the bottom.

On hover-capable fine pointers, the timeline keeps its scrollbar thumb hidden
until the timeline is hovered or contains keyboard focus. Its stable scrollbar
gutter prevents the conversation from shifting when the thumb appears. Touch,
coarse-pointer, and forced-color environments retain their normal visible
scrollbar treatment.

Pass `timeLabel` for visible localized timestamps and `createdAt` for the
machine-readable `dateTime` value. `createdAt` alone intentionally renders no
runtime-locale text, which keeps the server HTML and the browser render identical.

## Questions and outcomes

Use `Chat.Decision` for one question in a conversation. The host owns the answer,
execution, expiry, and any policy change. Use verb-and-target answers such as
"Send to Lea" and "Keep draft"; never offer "Approve all". Answers are at
least 44 px high; on phones they share the row, and a long label wraps
inside its button.

The sentence, preview title, header rows, and answers share one left edge, with
no separate column or card surface. Reason, preview line, outcome, and activity
text start 24 px from that edge, after their icon. The sentence uses
`--k2b-chat-decision-size`: 18 px, or 17 px below 48 rem, at weight 400.

Use [ReferenceChip](/en/ui/content/label-chip#referencechip) for objects, places,
people, and times inside the sentence. Chips show at most 40 user-perceived
characters, cut in the middle, while retaining the full title as their accessible
name and tooltip. Person chips show a name and avatar, never an address. Put
addresses in `Chat.Preview.Header`. A gone object or place is struck through and
has no link.

Set `state` synchronously in each answer's `onSelect`, before awaiting work, so
the question collapses immediately. `open` shows the question;
`sending`, `decided`, and `expired` show the `outcome` slot. An answer given here focuses `Chat.Outcome` and
announces its current sentence. An outcome action that reopens the question
returns focus to the sentence and briefly highlights it. A host that cannot
take an answer returns the question from `sending` to `open`; focus then goes
back to the sentence as well. Changes from elsewhere do not move focus. Handle
rejected answer callbacks with `onAnswerError` and show a recoverable outcome.

Pass `Chat.Outcome` only the lines this flow can reach. Every supplied line
occupies the same grid cell, including hidden alternatives, so the longest line
reserves the height. This keeps running-to-done transitions still without
reserving space for unrelated outcomes. Only the current line is visible and
accessible; inactive action links leave the tab order. `actions` under a line
stay in the cell while the line is hidden, so a line with buttons reserves
their row from the start. When a line's own action switches `current`, such
as "Send again" to running, focus stays on the outcome instead of the hidden
link. `running` sets `aria-busy` on the words only, never
on an ancestor of the live region. Pass `onActionError` to receive an error a
line's `action` throws or rejects with, and show a recoverable line. While an
action's promise is pending, further presses are ignored. A polite
live region starts empty in SSR and on initial history
mount; it announces an answer given here and every subsequent `current` change,
including detail, time, and action link text with spaces between them; buttons
under the line are not announced.

Use `unavailable` to disable confirm and remember while keeping decline enabled.
Its reason replaces the original reason in the same described element. The
optional quiet `remember` answer is host policy: the component neither stores
consent nor widens permissions. On touch screens it is a full 44 px row, so a
low tap on either answer never reaches it.

Compose the actual content with `Chat.Preview`: header fields stand immediately
before their values; `emphasis` identifies a Bcc label; `note` can say when a mail
will be sent. `Excerpt` preserves line breaks and fades after about three lines.
`ReadMore` should open the exact version being reviewed. `Lines` names a list of
consequences, and `Line` can also stand alone for an attachment or warning.
`People` shows overlapping decorative avatars followed by readable names.

Use `Chat.Mark change="added"` for new words and `change="removed"` for removed
words, or mark an entire preview line with its `mark` prop. Screen readers hear
"new:" / "removed:" in English and "neu:" / "weg:" in German. Added marks use
`--k2b-mark-accent`, which defaults to `--k2b-ai-accent`; a host may override it
for the local context. Use `Chat.Activity tone="warning"` for a partial result
or an answer whose outcome is not yet known. An activity `label` may be a
sentence with `ReferenceChip`s, such as "Read [Week 42]". In an expandable
activity the whole row is the disclosure `<summary>`, so give its chips no
`href`: a link inside the summary would be a nested control.

```tsx typecheck
import { Chat, ReferenceChip, type ChatDecisionState } from "@k2b/ui";
import { createSignal } from "solid-js";

export function MailQuestion() {
  const [state, setState] = createSignal<ChatDecisionState>("open");
  const [current, setCurrent] = createSignal("running");
  return <Chat.Decision
    state={state()}
    sentence={<>Send the draft to <ReferenceChip kind="person" name="Lea Berg" />?</>}
    reason={{ text: "You asked to check mail before sending." }}
    preview={<Chat.Preview><Chat.Preview.Title>Workshop delivery</Chat.Preview.Title></Chat.Preview>}
    confirm={{ label: "Send to Lea", onSelect: () => {
      setCurrent("running");
      setState("sending");
      // Complete the host-owned operation, then set current and state.
    } }}
    decline={{ label: "Keep draft", onSelect: () => {
      setCurrent("declined");
      setState("decided");
    } }}
    outcome={<Chat.Outcome current={current()} lines={{
      running: { tone: "running", text: "Sending the mail to Lea." },
      done: { tone: "done", text: "Sent the mail to Lea.", time: "09:41" },
      declined: { tone: "off", text: "Kept the draft.", detail: "You declined." },
    }} />}
  />;
}
```

## API reference

```ts
type ChatRole = "user" | "assistant" | "system" | "tool";

type ChatMessageStatus = "pending" | "streaming" | "complete" | "error";

type ChatActivityTone = "neutral" | "ai" | "success" | "warning" | "danger";

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

### Decision, outcome, preview, and marks

`Chat.Decision`, `Chat.Outcome`, `Chat.Preview`, and `Chat.Mark` are members of
`Chat`; import their types directly from `@k2b/ui`.

```ts
type ChatDecisionState = "open" | "sending" | "decided" | "expired";
type ChatDecisionAnswer = {
  label: string; icon?: string; onSelect: () => void | Promise<void>;
};
type ChatDecisionReason = {
  text: JSX.Element; icon?: string; tone?: "neutral" | "danger" | "warning";
};
type ChatDecisionProps = {
  state: ChatDecisionState; sentence: JSX.Element; reason: ChatDecisionReason;
  preview?: JSX.Element;
  confirm: ChatDecisionAnswer & { variant?: "ai" | "primary" | "danger" };
  decline: ChatDecisionAnswer; remember?: ChatDecisionAnswer;
  unavailable?: ChatDecisionReason; outcome?: JSX.Element;
  onAnswerError?: (error: unknown) => void; anchorId?: string | number; class?: string;
};
type ChatOutcomeTone = "running" | "done" | "off" | "waiting" | "warning" | "error";
type ChatOutcomeLine = {
  tone: ChatOutcomeTone; text: JSX.Element; detail?: JSX.Element; time?: string;
  icon?: string; action?: { label: string; onSelect: () => void | Promise<void> };
  actions?: JSX.Element;
};
type ChatOutcomeProps = {
  lines: Readonly<Record<string, ChatOutcomeLine>>; current: string;
  onActionError?: (error: unknown) => void; anchorId?: string | number; class?: string;
};
type ChatPreviewPerson = { name?: string; address?: string };
type ChatPreviewHeaderRow = {
  label: string; people?: readonly ChatPreviewPerson[]; value?: JSX.Element; emphasis?: boolean;
};
type ChatPreviewProps = { children: JSX.Element; class?: string };
type ChatPreviewHeaderProps = { rows: readonly ChatPreviewHeaderRow[]; note?: JSX.Element };
type ChatPreviewTitleProps = { children: JSX.Element; meta?: JSX.Element };
type ChatPreviewReadMoreProps = { href: string; children: JSX.Element; title?: string };
type ChatPreviewLineProps = {
  icon: string; accent?: string; tone?: "default" | "muted" | "warning";
  mark?: "added" | "removed"; meta?: JSX.Element; children: JSX.Element;
};
type ChatPreviewPeopleProps = {
  people: readonly { name: string; src?: string | null }[]; children: JSX.Element;
};
type ChatMarkProps = { change: "added" | "removed"; children: JSX.Element };
```

| Member | Props / behavior |
| --- | --- |
| `Chat.Decision` | `ChatDecisionProps`; confirm defaults to `ai`, decline to `subtle`, remember to `text`. Reason defaults to `neutral` and an info icon. |
| `Chat.Outcome` | `ChatOutcomeProps`; tone chooses the default icon, `icon` overrides it. The root accepts programmatic focus with `tabindex=-1`. |
| `Chat.Preview` | `ChatPreviewProps`; groups preview parts without a surface. |
| `Chat.Preview.Header` | `ChatPreviewHeaderProps`; semantic description list with optional note. |
| `Chat.Preview.Title` | `ChatPreviewTitleProps`; title with quiet trailing metadata. |
| `Chat.Preview.Sentence` | `{ children: JSX.Element }`; a rule or instruction. |
| `Chat.Preview.Excerpt` | `{ children: JSX.Element }`; fading text excerpt. |
| `Chat.Preview.ReadMore` | `ChatPreviewReadMoreProps`; ordinary link to the reviewed version. |
| `Chat.Preview.Lines` | `{ label?: string; children: JSX.Element }`; `ul` with an optional accessible name. |
| `Chat.Preview.Line` | `ChatPreviewLineProps`; `li` inside Lines, otherwise `p`; accent colors its decorative icon. |
| `Chat.Preview.People` | `ChatPreviewPeopleProps`; decorative avatars and host-supplied names. |
| `Chat.Mark` | `ChatMarkProps`; semantic `mark` or `del` with a localized spoken prefix. |

### Commands and file selection

```ts
type ChatCommandContext = {
  setValue: (value: string) => void; submit: () => void; focus: () => void;
  openModelSelection: () => Promise<string | null>;
};

type ChatCommandResult = void | "cancelled" | { done: string };

type ChatCommand = {
  id?: string; name: string; description: string; icon?: string; label?: string;
  keywords?: readonly string[]; reason?: string; busyLabel?: string; disabled?: boolean;
  section?: string; scope?: string; hiddenUntilSearch?: boolean; app?: string;
  action?: (context: ChatCommandContext) => ChatCommandResult | Promise<ChatCommandResult>;
  mention?: ChatAttachment;
  selected?: boolean; searchAgain?: boolean;
};

type ChatCommandSection = { id: string; label: string; searched?: boolean; searchOnly?: boolean };
type ChatCommandScope = { id: string; title: string; words: readonly string[] };
type ChatCommandSearch = { scope?: string; opening: number };

type ChatFileSelection = {
  onSelect: (files: readonly File[]) => void | Promise<void>; onError?: (error: unknown) => void;
  choose?: () => Promise<readonly File[]>; accept?: string; multiple?: boolean; disabled?: boolean; label?: string;
};

type ChatPasteHandler = (event: ClipboardEvent & { currentTarget: HTMLTextAreaElement; target: Element }) => void;

```

Give `commandSections` in display order and each command a `section` id. The
order stays fixed while searching. The overview keeps consumer row order;
searching ranks rows inside each section. Commands without a known section
appear at the end without a heading. Without `commandSections`, the list stays
flat. Each `id` (defaulting to `name`) appears once among visible matches: the
first section wins, then a matching static row wins over a server row in the
same section. A static row without a match never hides a fresh server result.

Search ignores case, accents and German umlauts (`ä=a`, `ß=ss`). Its ranking
ladder is: title starts with query, title word starts with query, title contains
query, keyword starts with query, `app` starts with query, description word
starts with query (3+ characters), then one typo in a title word or keyword
prefix (4+ characters). The title is `label ?? name`; when a label exists,
`name` remains a search word alongside `keywords`. `app` is searchable and is
not displayed. Equal ranks keep static rows first, then server rows, each in
consumer order.

`searchCommands(query, signal, { scope, opening })` runs after a 120 ms debounce. Fresh
server results remain visible even without a local match, after matching rows.
Retained results from an earlier query must match the new query; changing scope
clears them. Marking follows the top row until an arrow key moves it, then
stays on that entry while results arrive. Typing starts at the top again.
Enter and Tab wait for fresh server rows; clicks may choose retained matching
rows. Local matches remain available while loading.
Server rows are requested again when the composer’s running state changes, so
reasons that depend on it stay current.

The `opening` number identifies one opening of the list. It stays the same
while typing, narrowing, or moving with arrow keys. A new `/`, closing and
reopening the list, or switching drafts starts another opening. Consumers can
cache discovery per opening with their own cancellation controller; the search
`signal` still belongs to one query.

Set `searchAgain: true` for a retry row. Enter, Tab, and click preserve the
current `/…`, query, and scope, run no action, and immediately search with a new
opening. Current matching rows remain visible while loading.

Use `matchesChatCommand(command, query)` from `@k2b/ui` to filter server rows
with the same ranking rules. It returns true for an empty or whitespace query.
Fresh server rows are never removed by the composer, so consumers own that
filtering.

Use `commandScopes` for first-word narrowing. Only a word followed by
whitespace can resolve: an exact word wins if unique. Otherwise, with at least
three letters, the scope with the shortest extension wins; a tie resolves to
nothing. Both paths ignore case and accents. A resolved scope shows one group
with `scope.title`, containing only server rows. The search callback receives
the rest of the query and `{ scope: scope.id, opening }`; otherwise it receives
the whole query and `{ scope: undefined, opening }`.

Tab on a command with `scope` replaces the query after `/` with that scope's
`words[0]` and a space, through normal undoable editing. Enter runs its action or
inserts its mention; a scope-only row also narrows on Enter. An unavailable
row keeps its reason and never narrows.

An action may return `{ mention: attachment }` after a picker resolves. The
reference replaces the original token at its position, using the same edit as
a row's `mention`. Ctrl/⌘+Z restores `/…` in one step. Returning `"cancelled"`
keeps the token. If the draft changed, or moved to another `draftKey`, while
the picker was open, the composer inserts nothing and shows a visible
explanation.

Set `attachFiles: true` to use the composer's `fileSelection` from a slash row.
Its `choose` function runs synchronously inside the key or click activation so
the device's file dialog can open. The token leaves; resolving with `[]` brings
it back if the draft is unchanged. The same `onSelect` handles selected files.
A row with `reason` cannot open file selection.

Use `commandFallback({ query, scope })` for a final row built immediately from
the current search. Unscoped, it follows **Nothing found for “…”** when no rows
match and does not count as a match. In a scope, it is the last row inside that
group. Return `undefined` when no fallback applies. It participates in keyboard
selection; adding a space after an unmatched unscoped query still closes the
list. The overview has no fallback.

Set `hiddenUntilSearch` for rows that do not apply to the current context.
They are absent from the overview and appear with their reason when matched;
scoped results do not hide them. A `searched` section shows a quiet heading
spinner while loading. An empty section gets a heading and placeholder only
before the first search settles for this slash token and scope, or when retained
results still contain a row for that section. Other empty sections stay hidden
while the next query loads. A resolved scope always keeps its title and shows a
placeholder while loading without rows. Placeholders are skipped by arrow keys.
A `searchOnly` section, such as
files of the current chat, is absent from the overview, placeholder included,
and appears while searching or narrowed.

A settled empty list says `Nothing found for “<query>”`. A scope with no search
text uses the generic empty message. After an unmatched query settles, a
trailing space closes the list for that `/` and leaves ordinary text. Resolving
a scope keeps it open. `/ ` opens nothing, so `50 / 2` stays arithmetic.
A separate polite screen-reader status announces the number of suggestions
350 ms after the visible model settles, without repeating the same text for
the same query. Action status and unavailable reasons use their own region.

Each row shows a title and at most one description or reason beneath it. Both
wrap; nothing is truncated. The title match is bold. Rows have no preview,
badges, key hints, or `/name` suffix. Groups have labelled headings; arrow keys
wrap across all rows and skip placeholders. Emoji suggestions keep their own
markup and selection behavior.

Set `selected: true` to show a trailing check mark and localized visually
hidden “selected” text. This marks a chosen value independently of the row
currently marked by the arrow keys.

Command actions can call `await context.openModelSelection()` to open the
composer's own model control. It resolves with the chosen model id after
`onModelChange` runs, or `null` on Escape, outside close, or an unavailable
control (including running, no models, no change callback, or `footerContent`
replacing the footer). For the states your application knows, give the command
a `reason`, or drop its action so Enter narrows to its `scope`; it never
resolves `null` silently. The control stays
usable while that command awaits a choice. Return `"cancelled"` on null
to restore the token. The action's normal completion restores field focus.

Set `reason` when a command is unavailable. It replaces the description and is
associated with the option for screen readers. Enter, Tab, and click keep the
list open, perform no action, and announce the reason. Legacy `disabled` still
prevents selection and keeps the description.

An action returning `"cancelled"` restores the exact `/…` token and mentions
when the draft is unchanged. Rejections use the same restoration guard, and a
restored draft leaves no undo step behind. The caret returns after the token
and the list stays closed until the next edit.
The persistent status line shows `busyLabel` while working, `{ done }` for
about three seconds, and a failure message until the next edit, the next
command, or a switch to another draft.
Command failures are reported once there, without calling `onError`; only a
failure that arrives after the composer unmounted goes to `onError`.
The visible status hides while suggestions are open and takes no layout space.

Only plain Enter or Tab chooses a command. Shift+Enter breaks the line,
Shift+Tab moves focus back, and Ctrl/⌘+Enter sends even with suggestions open.
Nothing chooses during IME composition. Escape closes suggestions for the
current `/`, including while more text is typed into that token; a new `/`
can open them again.

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
  kind: "activity"; id: string; label: JSX.Element; description?: string; icon?: string; leading?: JSX.Element;
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
  commandSections?: readonly ChatCommandSection[]; commandScopes?: readonly ChatCommandScope[];
  searchCommands?: (query: string, signal: AbortSignal, search: ChatCommandSearch) => Promise<readonly ChatCommand[]>;
  mentions?: readonly ChatMention[]; onMentionsChange?: (mentions: readonly ChatMention[]) => void;
  accessory?: JSX.Element; draftKey?: unknown;
  contextActions?: readonly ChatAction[]; contextPopupAction?: ChatAction; footerTools?: JSX.Element; modelDetails?: JSX.Element;
  submitTools?: JSX.Element; footerContent?: JSX.Element; placeholder?: string; label?: string;
  inputLabel?: string; disabled?: boolean; error?: string; focusToken?: unknown; class?: string;
  variant?: "default" | "conversation"; sendKey?: "enter" | "mod-enter"; formatting?: boolean;
  emoji?: ChatComposerEmoji; microphone?: ChatComposerMicrophone; hint?: JSX.Element;
};

type ChatDictationState = "listening" | "refining" | "refined" | "unrefined" | "interrupted";

type ChatComposerMicrophone = {
  onDictate?: () => void; onVoiceMessage?: () => void; dictation?: ChatDictationState | null;
  onRestoreOriginal?: () => void; disabled?: boolean;
};

type ChatComposerEmoji = {
  onOpen: (context: { anchor: HTMLElement; insert: (text: string) => void }) => void;
  skinTone?: EmojiSkinTone; onPick?: (emoji: string) => void;
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
  label: JSX.Element; ariaLabel?: string; description?: string; icon?: string; leading?: JSX.Element; accent?: string;
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

Initial messages render on the server. Editing, commands, scrolling, file selection, menus, model changes, and submission require browser code.

Raw files selected, dropped, or pasted are handed to
`fileSelection.onSelect`. With `fileSelection.choose`, **Attach files** calls it
inside the menu activation instead of opening the device's file dialog, and
hands its files to `onSelect`, only the first one when `multiple` is `false`;
a rejection reaches `onError`. The package never uploads, persists, streams,
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
Image attachments retain their thumbnail presentation. When a thumbnail no
longer loads, for example because the file was deleted, the chip shows the
attachment icon instead of a broken image and keeps the filename as its title.
A changed `previewUrl` loads the thumbnail again.


## Application-owned model details

Use `Chat.ContextPopup` in `modelDetails` for a compact button with custom
details, such as an application's usage indicator. Pass the trigger content as
children, `content` for the panel, and a complete `aria-label` that names the
state and its value. The button defaults to `type="button"` and to the same
trigger style as the context indicator; a `class` replaces that style. Hover
previews the panel; click or keyboard activation pins it open. Escape and
outside click close it. `onOpen` runs each time the panel opens, which is the
place to refresh its data instead of offering a refresh button. Interactive
panel content is reachable with Tab. Popup-owned click, pointer-enter/leave and
ref props are not part of its public props. Applications own data loading and
authorization.

Build the panel with `Chat.ContextPanel` so it matches the context details: it
takes a `title` and lays out its children with the same type and spacing. Inside
it use a `dl` with one `div` per `dt`/`dd` row, an `xs` `ProgressBar`, and a short
`p` for a muted note. Wrap each repeated group in a `section`.

```tsx
<Chat.ContextPopup
  aria-label="Usage: 35%"
  onOpen={refresh}
  content={
    <Chat.ContextPanel title="Usage">
      <section>
        <dl>
          <div>
            <dt>Used</dt>
            <dd>35%</dd>
          </div>
        </dl>
        <ProgressBar value={35} size="xs" label="Usage" />
        <p>Resets in 5 hours</p>
      </section>
    </Chat.ContextPanel>
  }
>
  <ProgressRing value={35} />
</Chat.ContextPopup>
```

An icon-only trigger, such as `<i class="ti ti-infinity" />`, takes the same
box as a `ProgressRing`, so one can replace the other without moving the
composer. An empty ring means 0 %, so do not use one for a value you do not
have: show `<i class="ti ti-circle-dashed" />` when the value could not be
loaded. While the state is not known yet, render
`<span class="k2b-chat-context" aria-hidden="true">` with the same dashed
circle: it keeps the trigger's box and is not interactive.

### Composer commands and mentions

Use `commands` for local actions or reference choices, and `searchCommands(query,
signal, { scope })` for asynchronous discovery. Commands match at the caret, including in
the middle of a draft. A long command name or description wraps in the
suggestion list instead of ending in an ellipsis. A reference choice supplies `mention: ChatAttachment`;
control its ranges with `mentions` and `onMentionsChange`. The submitted text is
untrimmed so UTF-16 range offsets remain valid. A modified reference becomes
plain text; undo/redo restores both text and reference identity.

Pass the task list through `accessory`. An empty conditional accessory reserves no
row or spacing, including after mount. Suggestions use that same location and
restore the task list without changing its open state. Without an accessory, they
float above the composer, which does not move when they open or close. Set `draftKey` when
switching conversations so undo cannot bring content from another chat back.

On touch-only phones (narrow screens, or low screens in landscape), command
suggestions form a column-wide sheet directly above and flush with the composer.
Rows are at least 48px tall, with the name above the description. The sheet can
grow up to the scroll container or visual viewport, minus the top safe area.
A tap beside it closes only the list and reaches nothing beneath; the field
keeps focus and the keyboard stays open. Back closes the list first through one
same-URL history entry, removed on every other close path. A Back or Forward
that only moves onto or off this entry does not reach application `popstate`
listeners when the browser supports the Navigation API. Without it, only the
synthetic Back on close is suppressed. Submitting on a touch-only device waits
for the sheet's entry to leave before calling `onSubmit`, including when a tap
on Send has already closed the list. With a mouse or trackpad, an outside click
closes the list and then acts normally. Emoji suggestions keep their floating list.

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

## Conversations between people

Set `variant="conversation"` for messages between people, for example under a
[`VirtualFeed`](/en/ui/content/virtual-feed) of
[message rows](/en/ui/content/message-rows). Without it, the composer keeps
the assistant prompt's behavior.

The conversation composer is one row without a card: an attach button with a
plain plus, a quiet pill-shaped field, and a round Send button. The field is muted at rest
and shows the surface with a ring while it has focus; only its paint changes.
Formatting, emoji, and the microphone sit inside the field at its end. Send is
dimmed until there is something to send. With `fileSelection` alone, the
attach button opens the file choice directly; with `menuActions`, it opens the
add menu. The footer props of the assistant prompt (`models`, `modelDetails`,
`contextUsage`, `contextActions`, `contextPopupAction`, `footerTools`,
`submitTools`, `footerContent`) have no place in this row and are not rendered.

- **Size:** the field starts with one line and grows with its text up to a
  third of the nearest size container, then scrolls. Give the conversation's
  frame `container-type: size`; without one, the cap is a third of the small
  viewport height. A hidden copy measures the text, so the field never
  collapses for a frame and the feed above keeps the newest message in place.
  A placeholder longer than the empty field stays on its one line and ends
  with an ellipsis.
- **Hint line:** one line of fixed height above the field, always reserved,
  so a hint never moves the field. Pass `hint` for short application notes,
  such as what people without access see after a reference was attached.
  Longer text ends with an ellipsis. The default variant shows the line only
  while it has content.
- **Enter:** `sendKey="enter"` (the default) sends on Enter and breaks the
  line on Shift+Enter; `sendKey="mod-enter"` breaks the line on Enter. Ctrl/⌘+Enter
  always sends, also while command suggestions are open; there, Enter and Tab
  pick a suggestion. In both modes, Enter breaks the line while the caret is
  inside an open fenced code block (with backticks or tildes, also in a quote)
  and on touch-only devices, where Send sends. It never sends during IME input,
  including the Enter that confirms a conversion. The application stores the
  person's choice.
- **Focus:** pressing Send or another composer button keeps the field
  focused, so a phone's keyboard stays open. The field also stays editable
  while an asynchronous `onSubmit` runs. If the submission is rejected, the
  draft comes back in front of anything typed in the meantime.

`sendKey` also works without the conversation variant: `"mod-enter"` there
breaks the line on Enter and sends on Ctrl/⌘+Enter.

### Formatting, emoji, and microphone

These work in both variants. In the conversation variant they sit inside the
field; in the default variant, in the footer.

- **`formatting`** adds "Aa". It opens one short row of fixed height with
  Bold, Italic, and Bullet list, which is all a chat message needs; other
  Markdown, such as code, quotes, or links, is typed and still renders. In the
  conversation variant the row sits above the field and starts at the field's
  left edge, not at the attach button; in the default variant it sits above
  the footer. The composer grows upward by that row, like a new line of text,
  so the field and every control stay where they are and a feed that follows
  the newest message keeps it in view. On a coarse pointer each button is
  2.75rem. The buttons write Markdown into the field, keep the selection, and
  remove their formatting on a second press. Ctrl/⌘+B, Ctrl/⌘+I, and
  Ctrl/⌘+Shift+8 do the same while `formatting` is set; other shortcuts keep
  their browser meaning.
- **`emoji`** adds an emoji button. `onOpen` receives the button as `anchor`
  and an `insert` function that puts the chosen text at the caret; open
  [`EmojiPicker.Popover`](/en/ui/input/emoji-picker) there. Touch-only
  devices hide the button, because their keyboard has emoji.
  It also completes shortcodes: a colon after a space or at the start, then two
  letters, such as `:th` or `:dau`, lists up to eight emoji whose GitHub
  shortcode, English or German name, or keyword starts with them, above the
  field. Emoticons such as `:DD`, `:-D`, or `:-P` match nothing and send as
  typed; a sign counts only where a shortcode starts with it, as in `:+1`. Up
  and Down choose, a plain Enter or Tab inserts, and Escape closes the list;
  Shift+Enter still breaks the line and Ctrl/⌘+Enter still sends. Typing the
  closing colon of a known shortcode, such as `:tada:`, turns it into 🎉.
  Inline code, fenced code blocks, URLs, and times such as `10:30` stay text,
  and the browser's undo brings the shortcode back. Emoji with skin tones come
  in `skinTone`, and `onPick` reports every emoji the completion inserted, for
  example to remember it with `rememberEmoji`. The emoji data loads with the
  first colon typed; a shortcode closed before it arrived turns into its emoji
  when it arrives, unless the draft changed in the meantime.
- **`microphone`** adds a microphone before Send, or at the end of the field
  in the conversation variant. Dictation comes first: a
  tap calls `onDictate`, which starts or stops the application's live
  dictation. Holding the microphone for half a second calls `onVoiceMessage`
  instead, unless the composer was disabled during the press. The small menu
  next to it offers both, so keyboard and screen reader users reach each
  action. Without `onDictate`, a tap opens that menu; a key press also moves
  the focus into it. Omit `onVoiceMessage` where the browser cannot record.

Pass the dictation state as `microphone.dictation`. The composer shows it at
fixed places: the microphone turns into Stop while `listening` and waits
while `refining`, and the hint line says what happens. With `refined`,
the hint line offers "Restore original", which calls `onRestoreOriginal` and is
disabled whenever the microphone is.
`unrefined` and `interrupted` keep the text and say so. The application owns
the audio, the transcription, the text it writes into the draft, and when a
state ends; the composer never records or sends anything itself.

```tsx
<Chat.Composer
  variant="conversation"
  value={draft()}
  onValueChange={setDraft}
  onSubmit={({ text }) => send(text)}
  sendKey={preferences.sendKey}
  formatting
  emoji={{ onOpen: setEmojiTarget, skinTone: tone(), onPick: remember }}
  microphone={{
    onDictate: dictation.toggle,
    onVoiceMessage: recordVoiceMessage,
    dictation: dictation.state(),
    onRestoreOriginal: dictation.restore,
  }}
  hint={hint()}
  placeholder="Message Workshop"
/>
<EmojiPicker.Popover
  anchor={emojiTarget()?.anchor}
  recent={recent()}
  skinTone={tone()}
  onSkinToneChange={setTone}
  onPick={(emoji) => {
    emojiTarget()?.insert(emoji);
    remember(emoji);
  }}
  onClose={() => setEmojiTarget(undefined)}
/>
```
