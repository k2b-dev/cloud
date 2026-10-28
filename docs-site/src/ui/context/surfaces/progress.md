# Progress

`ProgressBar` presents determinate progress from 0 to 100. Its neutral track stays
visible against muted surfaces in both themes, so the full length remains clear.
`ProgressRing` presents the same value as a 1rem ring without a number, for
places too small for a bar, such as a toolbar or a chat composer.

## Use progress

Use the default tone for ordinary work, success for a positive completion state, warning when a limit is close, and danger when the progress itself represents a reached limit or failing state.

Use the ring only next to a control or text that names the value, for example a button whose label says "Usage: 35%". In warning the ring adds a centre dot and in danger an exclamation mark, so the states differ without colour.

Use `DotStrip` for a fixed window of outcomes, not for a percentage. Each dot
is one item in order; the tone says what happened: `accent` (the app colour)
for "it worked", `warning` for skipped, `danger` for failed, `ai` for an
outcome that came from AI, and `muted` for "nothing to do". Always show a
legend or counts next to it, because colour alone carries no meaning. Pass
`length` while the window is still filling: the remaining slots stay as empty
rings, so the strip keeps its size and nothing shifts. `waiting` shows every
slot as a quiet placeholder before anything was checked.

## Import

```tsx
import { DotStrip, ProgressBar, ProgressRing } from "@k2b/ui";
```

## API reference

```ts
type ProgressBarTone = Extract<IntentTone, "info" | "success" | "warning" | "danger">;

type ProgressBarProps = {
  value: number; size?: "xs" | "sm" | "md"; tone?: ProgressBarTone; showValue?: boolean; label: string;
  class?: string;
};

type ProgressRingTone = Extract<IntentTone, "info" | "warning" | "danger">;

type ProgressRingProps = {
  value: number; tone?: ProgressRingTone; label?: string; class?: string;
};

type DotStripTone = "accent" | "warning" | "danger" | "ai" | "muted";

type DotStripProps = {
  dots: readonly DotStripTone[]; length?: number; waiting?: boolean; selected?: number | null;
  size?: "md" | "lg"; columns?: number; label: string; class?: string;
};
```

`IntentTone` is defined in [shared API conventions](/en/ui/getting-started#icons-tones-and-navigation); each component accepts only the tones listed above. Defaults: `size="md"`, `tone="info"`, `showValue=false`. Finite values round to an integer and clamp to 0–100; non-finite values render 0.

## Accessibility

Pass a task-specific `label`. Tone supplements the numeric value and must not carry meaning alone.

`DotStrip` is one image with the `label` as its name. Put the counts into the
label ("Last 50 mails: 17 matched, 6 skipped, 27 not"); single dots are not
announced. `selected` adds a ring around one dot for the item shown next to the
strip. `columns` wraps long windows into rows, for example 25 per row on a phone.

`ProgressRing` with a `label` is a named progressbar. Without one it is hidden from assistive technology; the surrounding control must then carry the name and the value.

## Runtime

`ProgressBar`, `ProgressRing` and `DotStrip` render on the server and need no browser code for their initial value.

## Example

```tsx
<ProgressBar value={72.4} label="Upload progress" tone="success" showValue />
<ProgressRing value={92} tone="warning" label="Storage used" />
<DotStrip dots={["accent", "muted", "warning", "accent"]} length={50} label="Last 50 mails: 2 matched, 1 skipped, 1 not, 46 open" />
```
