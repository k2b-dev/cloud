# Status badges

`StatusBadge` presents one semantic status vocabulary as a compact chip, dense dot, or plain text.

## Use status badges

Use a chip in cards and normal tables. Use `variant="dot"` in dense rows. Use `variant="text"` when the surrounding surface already provides enough structure.

Choose the tone by meaning: `info`, `ok`, `warning`, `error`, `degraded`, `running`, or `neutral`.

## Import

```tsx
import { StatusBadge } from "@k2b/ui";
```

## Labels and icons

Pass `label` as visible status text. Default icons follow the tone and can be replaced or removed with `icon`.
The neutral tone uses `ti ti-alert-square-rounded`.

`title` adds supporting detail without replacing the visible label.

In a list, status has a fixed place. Where a badge sits at the end of a row, pass
`labels` with every word that place can show, for example all states of an app.
The badge keeps the width of the longest, so its dot starts at one x in every
row and stays put when the state changes. Screen readers hear only the current
label.

Required props are `label: JSX.Element` and `tone: "info" | "ok" | "warning" | "error" | "degraded" | "running" | "neutral"`.
`variant?: "chip" | "dot" | "text"` defaults to chip. `icon?: string | null`
overrides the default icon; `null` removes it. `labels?: readonly string[]` reserves
the width of the longest possible label. `title?: string` and `class?: string`
add supporting text and layout classes.

## Accessibility

Color and icons are supplementary. The visible label must state the result without either.

Do not use a status badge as a button or link. Put the interactive element around it when navigation is required.

## Runtime

Status badges render complete server HTML and need no browser code.

## Example

```tsx
<StatusBadge label="Healthy" tone="ok" />
<StatusBadge label="Running" tone="running" variant="dot" />
<StatusBadge label="Offline" tone="error" variant="text" />
```

Use `tone="info"` for informational messages. It uses the blue information
palette without the animation of the running state.
