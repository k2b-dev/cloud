# Progress

`ProgressBar` presents determinate progress from 0 to 100. Its neutral track stays
visible against muted surfaces in both themes, so the full length remains clear.

## Use progress

Use the default tone for ordinary work, success for a positive completion state, and danger when the progress itself represents a limit or failing state.

## Import

```tsx
import { ProgressBar } from "@k2b/ui";
```

## API reference

```ts
type ProgressBarTone = Extract<IntentTone, "info" | "success" | "danger">;

type ProgressBarProps = {
  value: number; size?: "xs" | "sm" | "md"; tone?: ProgressBarTone; showValue?: boolean; label: string;
  class?: string;
};
```

`IntentTone` is defined in [shared API conventions](/en/ui/getting-started#icons-tones-and-navigation); here only `"info" | "success" | "danger"` are accepted. Defaults: `size="md"`, `tone="info"`, `showValue=false`. Finite values round to an integer and clamp to 0–100; non-finite values render 0.

## Accessibility

Pass a task-specific `label`. Tone supplements the numeric value and must not carry meaning alone.

## Runtime

`ProgressBar` renders on the server and needs no hydration for its initial value.

## Example

```tsx
<ProgressBar value={72.4} label="Upload progress" tone="success" showValue />
```
