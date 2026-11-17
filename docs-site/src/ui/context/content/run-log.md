# RunLog

`RunLog` shows one run: its state in a tinted head, one row per step, and
foldable output. It is a standalone `@k2b/ui` component. The application owns
execution, connection, time, permissions, and loading earlier entries.

## Use RunLog

Use it for an operation with steps and diagnostic output, on a page or next
to the object it processes. Use `ActivityList` for past events, `ProgressPath`
for fixed stages, `ChatTasks` for a composer's plan, and `LogEntriesTable` for
an operational table with source and metadata.

## Import

```tsx
import { RunLog, type RunEntry, type RunLogProps } from "@k2b/ui";
```

## Data and state

`state` is `idle`, `starting`, `running`, `succeeded`, or `failed`.
Idle and starting render only the head when no step plan is known and output
is closed. A supplied plan reserves the body in every run state. A lost connection is application
metadata, such as `meta="Connection lost, reconnecting …"`; keep the last
known run and entries visible.

`entries` is one ordered stream of `RunEntry` records:

- A log has `kind: "log"`, `id`, `at`, `level` (`info`, `warn`, `error`), and
  `text`. It renders as plain text, including strings that contain markup.
- A step has `kind: "step"`, `id`, `at`, `label`, and `status` (`pending`,
  `running`, `succeeded`, `failed`, `skipped`). Optional `icon` is a complete
  Tabler class. `description` appears behind ⓘ. `message` is the result or
  reason, kept on one line with its full text in a tooltip. `startedAt` and
  `endedAt` supply its duration, using the shared millisecond/second/minute
  formatter. Each step with `startedAt` also contributes one quiet `▸` marker
  to the output, ordered by time among the log lines.

Later records for the same step id update its original row. Unknown kinds
are ignored. A pending step after a successful run displays as skipped; after
a failed run it stays pending. Output timestamps use the inherited locale and
the runtime's local timezone through `Intl.DateTimeFormat`; an already
formatted time string is displayed unchanged. SSR hosts use the same timezone
as their browser rendering, or supply already formatted timestamps. No clock
runs in the component. Supply `duration` in milliseconds to update the run's clock.

## Layout and disclosures

Create all steps at the beginning of a run. A fixed step count reserves the
same height from idle through starting, execution, success, failure, changing
reasons, clocks, metadata, and output counts. A step added later adds a row.
For more than five steps, a fixed five-row window and an earlier-steps
button keep the height constant. The default window contains the running step,
or the failed step when none is running. The button moves through earlier
steps and then back to that current window. When the current step is at the
beginning, it first offers the remaining steps.

`size="compact"` shows only the head and current step. Activating it unfolds
the same card downwards; its head then shows the run state. `size="full"`
is the default. `output="closed"` is the default; `open` starts with output
expanded and `hidden` omits it. A changed `output` prop updates its disclosure.
The open output band is 180 px high and scrolls, including while it is empty.
Its count includes the step markers. New lines follow the end until
the reader scrolls up or requests older output. Only disclosure changes
animate height; reduced motion makes them instant.

`olderCount` adds to the output count and shows an earlier-output button;
`onLoadOlder` tells the application to load. Without the callback it is
disabled. The application supplies loading, error, and recovery feedback
through `meta` and updates `entries` and `olderCount` after loading.

## Actions and colour

`actions` is a readonly array of `{ icon, label, onClick?, href?, primary?,
disabled?, disabledReason? }`. A small symbol and word sit in the head.
Multiple actions become one Actions menu in a container at most 480 px wide.
One action stays visible. Compact actions appear when the card is expanded.
An action without a callback or link is disabled. `href` retains native link
behaviour. Disabled reasons appear as tooltips or menu descriptions.

The head and running marks inherit the primary tokens. Put the card under
`data-k2b-primary="ai"` for plum; other hosts keep their application accent.
Success and failure retain their semantic colours. Output levels use the same
`data-level` semantic tokens as `LogEntriesTable`. Info lines are neutral;
step markers, warnings and errors have their own tone. Warnings and errors
also carry labelled icons.

## Accessibility

Only the run state is in `role="status"`; duration and the current step stay
outside this live region. Output uses `role="log"` and
`aria-live="off"` so streamed lines never overwhelm announcements.
Steps have spoken states as well as marks and colour. Disclosures expose
`aria-expanded` and `aria-controls`; collapsed regions are inert and hidden
from assistive technology. Native buttons support Enter and Space. All
controls show an inset focus ring without moving content, and phone targets
are at least 44 px high. Step descriptions and reasons are available on
keyboard focus. Labels use the inherited UI locale (English or German).

## Runtime

The server and the first browser render use the same props. The browser owns
only the local compact, output, and earlier-step disclosures. No fetching,
subscription, execution, or timer runs inside `RunLog`.

## Example

```tsx
<RunLog
  state="running"
  duration={6000}
  meta="Today, 16:42"
  entries={[
    { kind: "step", id: "read", at: "2026-11-17T16:42:07Z",
      label: "Read document", icon: "ti ti-file-text", status: "running" },
    { kind: "log", id: "line-1", at: "2026-11-17T16:42:07Z",
      level: "info", text: "Received a PDF with two pages" },
  ]}
  output="open"
/>
```
