# Disclosure

`Disclosure` reveals optional detail without creating another peer view.

## Use Disclosure

Use it for advanced settings, explanations, or secondary controls that can stay collapsed. Use `Tabs` when content areas are peers.

## Import

```tsx
import { Disclosure } from "@k2b/ui";
```

## Example

```tsx
const [advanced, setAdvanced] = createSignal(false);

<Disclosure
  summary="Advanced settings"
  icon="ti ti-adjustments"
  value={advanced}
  onValueChange={setAdvanced}
>
  <AdvancedSettings />
</Disclosure>
```

Use `surface="paper"` (the default) for a standalone framed group. Use
`surface="plain"` inside an existing surface to avoid a second frame. Both
use an inset summary hover while collapsed. When expanded, the header and
content share one subtle surface, which becomes stronger when the header is
hovered. Disabled summaries do not paint a hover state.

The semibold header leads the smaller body text. Let explanatory text inherit
the component's typography rather than applying a larger paragraph style.
Only the header toggles the disclosure: content stays selectable, and links
and controls inside it retain their normal interaction.

Pass `value` for controlled state or `defaultValue` for local initial state.

## API reference

```ts
type DisclosureProps = {
  surface?: "paper" | "plain";
  summary: JSX.Element; children: JSX.Element; value?: MaybeAccessor<boolean>; defaultValue?: boolean;
  onValueChange?: (value: boolean) => void; icon?: string; disabled?: boolean; class?: string;
};
```

`value` accepts a boolean or accessor. Without it, `defaultValue` initializes internal state (default false). `disabled` blocks toggling; `onValueChange` reports the next open state.

## Accessibility

The component preserves native `details` and `summary` semantics and occupies only its current content height.

## Runtime

Native uncontrolled disclosure works without JavaScript; controlled synchronization requires hydration.
