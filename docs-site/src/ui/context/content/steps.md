# Steps

`Steps` presents instructions as an ordered list with accent numbers.

## Use Steps

Use it when the reader follows a sequence.

## Import

```tsx
import { Steps } from "@k2b/ui";
```

## Example

```tsx
<Steps start={2}>
  <li>Select Share.</li>
  <li>Copy the link.</li>
</Steps>
```

`start` sets the first number. The host's `--app-accent` sets the number color;
it falls back to `--k2b-action`. The list has no background surface.
Trusted HTML can use `<ol class="k2b-steps">`. For a different starting number,
set both `start` and `style="--k2b-steps-start: 2"` on that element.

## Accessibility

Native ordered-list semantics preserve the sequence. Each child is an `li`.

## Runtime

Numbers use CSS counters. The list works without JavaScript.
