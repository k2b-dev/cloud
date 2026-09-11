# Context usage

`Chat.ContextUsage` shows the latest request's context pressure as a compact percentage with a detailed popup.

## Use Context usage

Usually pass `contextUsage` to `Chat.Composer`. The composer omits the compact
indicator until both a context-window size and meaningful usage values are
available. Supplying `contextPopupAction` keeps it available even before usage
is reported. Render `Chat.ContextUsage` directly only when an explicit
unavailable state is useful elsewhere.

The application owns limits, billing, compaction, and model selection.

## Import

```tsx
import { Chat } from "@k2b/ui";
```

## Values

Pass the latest request through `usage`, an optional multi-step total through
`loopUsage`, and the configured limit through `contextWindow`. The compact
trigger shows only the percentage; the popup exposes model, input, output,
loop total, window, and remaining tokens. Number output is SSR-stable by
default. Localized hosts can pass `formatNumber` explicitly.

## API reference

```ts
type ChatUsage = {
  input?: number; output?: number; total?: number;
};

type ChatContextUsageData = {
  usage?: ChatUsage | null; loopUsage?: ChatUsage | null; contextWindow?: number; modelLabel?: string;
};

type ChatContextUsageProps = ChatContextUsageData & {
  action?: ChatAction; onActionError?: (error: unknown) => void; formatNumber?: (value: number) => string;
  class?: string;
};
```

All usage counters are optional. A finite nonnegative `total` wins; otherwise available `input` and `output` are summed. Invalid counters are unavailable, not authoritative zeroes. `contextWindow` must be positive and finite. `loopUsage` supplies separate cumulative totals rather than replacing the latest request. `ChatAction` is defined on the [Chat page](/en/ui/ai/chat#api-reference).

## Accessibility

The trigger has a complete accessible label. The popup repeats values as text and uses a labeled progress bar, so the state does not depend on color.

## Runtime

The trigger renders on the server. Opening and positioning the popup requires hydration. The package never queries a provider or infers a model limit.

## Example

```tsx
<Chat.ContextUsage
  modelLabel="Deep"
  usage={{ input: 18_420, output: 2_140, total: 20_560 }}
  loopUsage={{ total: 31_800 }}
  contextWindow={128_000}
/>
```

## Context actions

Pass an optional `action` and `onActionError` to `Chat.ContextUsage`, or
`contextPopupAction` and `onError` to `Chat.Composer`. The small action appears
inside the details popup. Its callback is awaited and duplicate activation is
blocked while pending; the application supplies its label and availability.

Hover opens a preview without moving focus. Clicking pins it open, including
a click after hover. Click again, click outside, or press Escape to close.
The pointer can move into the popup to reach its action. Enter or Space opens
from the trigger; Tab reaches the action. Escape from inside restores focus
to the trigger. On touch devices, tap to open. Other tooltips are unchanged.
