# Status badges

`StatusBadge` presents one semantic status vocabulary as a compact chip, dense dot, or plain text.

## Use status badges

Use a chip in cards and normal tables. Use `variant="dot"` in dense rows. Use `variant="text"` when the surrounding surface already provides enough structure.

Choose the tone by meaning: `ok`, `warning`, `error`, `degraded`, `running`, or `neutral`.

## Import

```tsx
import { StatusBadge } from "@k2b/ui";
```

## Labels and icons

Pass `label` as visible status text. Default icons follow the tone and can be replaced or removed with `icon`.

`title` adds supporting detail without replacing the visible label.

## Accessibility

Color and icons are supplementary. The visible label must state the result without either.

Do not use a status badge as a button or link. Put the interactive element around it when navigation is required.

## Runtime

Status badges render complete server HTML and need no hydration.

## Example

```tsx
<StatusBadge label="Healthy" tone="ok" />
<StatusBadge label="Running" tone="running" variant="dot" />
<StatusBadge label="Offline" tone="error" variant="text" />
```
