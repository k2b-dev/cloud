# Context usage

`Chat.ContextUsage` is the one usage control of a chat: a ring for the latest
request's context pressure and for application parts such as a budget, with
the details in one popup.

## Use Context usage

Usually pass `contextUsage` and `contextSections` to `Chat.Composer`. The
composer puts one ring right of Plus, with its box reserved for the widest
state. The context part appears once both a context-window size and meaningful
usage values are available. Supplying `contextPopupAction` keeps it available
even before usage is reported. A section alone also shows the ring. Render
`Chat.ContextUsage` directly only when an explicit unavailable state is useful
elsewhere.

The application owns limits, billing, compaction, and model selection.

## Import

```tsx
import { Chat } from "@k2b/ui";
```

## The ring

The ring follows the highest known share of all parts: the one that runs out
first. At rest it is a calm grey ring without a number; without any share it
is an empty grey circle. The context warns from 85 % of the window, and a
section from its `warnAt`, 80 % unless set. While one part warns, the ring and
its number take the warning colour, and the ring gains a centre mark, so the
state does not depend on colour. On a screen narrower than 30rem the box stays
one touch target wide: the number stays in the label and the details.

The box is reserved for a ring with "100 %", so a warning, its number, or
another share never moves the controls after it.

## Values

Pass the latest request through `usage`, an optional multi-step total through
`loopUsage`, and the configured limit through `contextWindow`. The details
show **This chat** with its share, a bar, an optional `note`, and the model,
input, output, tokens in use, the whole response, the context window, and
remaining tokens. Numbers group whole values in the inherited render locale,
such as 128,000 in English and 128.000 in German; the server render and the
browser use the same locale. Pass `formatNumber` to format them differently.

## Sections

A section is one application part after the context, such as a budget. The
control renders its heading, its `value` next to it in the warning colour once
it warns, and its `content` below. Build the content from progress bars, `dl`
rows, `p` notes, and `.k2b-chat-usage__row` lines that end in a small action,
such as a reset time with **Refresh**. `onOpen` runs each time the details
open. A section that cannot be read shows that in its content with a retry,
and passes `percent: null`, so a cached share never reads as current.

## API reference

```ts
type ChatUsage = {
  input?: number; output?: number; total?: number;
};

type ChatContextUsageData = {
  usage?: ChatUsage | null; loopUsage?: ChatUsage | null; contextWindow?: number; modelLabel?: string;
  note?: JSX.Element;
};

type ChatUsageSection = {
  id: string; title: string; percent?: number | null; warnAt?: number; value?: string;
  summary: string; content?: JSX.Element; onOpen?: () => void;
};

type ChatContextUsageProps = ChatContextUsageData & {
  sections?: readonly ChatUsageSection[]; context?: boolean;
  action?: ChatAction; onActionError?: (error: unknown) => void; formatNumber?: (value: number) => string;
  class?: string;
};
```

All usage counters are optional. A finite nonnegative `total` wins; otherwise
available `input` and `output` are summed. Invalid counters are unavailable,
not authoritative zeroes. `contextWindow` must be positive and finite.
`loopUsage` supplies separate cumulative totals rather than replacing the
latest request. `context: false` shows only the sections. `ChatAction` is
defined on the [Chat page](/en/ui/ai/chat#api-reference).

## Accessibility

The trigger's label names every part, such as "Usage: context 18% full, budget
34% used"; each section supplies its `summary`. The details repeat the values
as text and use labeled progress bars.

## Runtime

The trigger renders on the server. Opening and positioning the popup requires
browser code. The package never queries a provider or infers a model limit.

## Example

```tsx
<Chat.ContextUsage
  modelLabel="Deep"
  usage={{ input: 18_420, output: 2_140, total: 20_560 }}
  loopUsage={{ total: 31_800 }}
  contextWindow={128_000}
  sections={[
    {
      id: "budget",
      title: "Your budget",
      percent: 86,
      value: "86% used",
      summary: "budget 86% used",
      content: <ProgressBar value={86} size="xs" tone="warning" label="Your budget" />,
    },
  ]}
/>
```

## Context actions

Pass an optional `action` and `onActionError` to `Chat.ContextUsage`, or
`contextPopupAction` and `onError` to `Chat.Composer`. The action is a small
icon next to the context share, such as **Summarize now** with
`ti ti-arrows-diagonal-minimize-2`. Its `label` is the accessible name and the
tooltip. While `disabled`, it stays focusable and its tooltip shows
`disabledReason`, for example why it is off while an answer runs. Its callback
is awaited and duplicate activation is blocked while pending; the application
supplies its label and availability.

Hover opens a preview without moving focus. Clicking pins it open, including
a click after hover. Click again, click outside, or press Escape to close.
The pointer can move into the popup to reach its action. Enter or Space opens
from the trigger; Tab reaches the action. Escape from inside restores focus
to the trigger. When a control inside replaces itself, such as a retry that
succeeded, the details stay open and keep the focus. On touch devices, tap to
open. Other tooltips are unchanged.
