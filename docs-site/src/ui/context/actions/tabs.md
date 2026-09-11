# Tabs

`Tabs` switches between a small controlled set of peer views. Prefer colocated `Tabs.Item` children when each tab owns content; use `options` for data-driven or routed tabs.

## Use Tabs

Use tabs for peer views. Use `Disclosure` for optional detail that does not replace the current view.

## Import

```tsx
import { Tabs } from "@k2b/ui";
```

## Example

```tsx
const [tab, setTab] = createSignal("overview");

<Tabs ariaLabel="Project sections" value={tab} onValueChange={setTab}>
  <Tabs.Item value="overview" label="Overview" icon="ti ti-layout-dashboard">
    <Overview />
  </Tabs.Item>
  <Tabs.Item value="activity" label="Activity" icon="ti ti-activity">
    <Activity />
  </Tabs.Item>
</Tabs>
```

`value` may be a Solid accessor or a value. `onValueChange` receives the selected item value. Each item accepts `value`, `label`, optional `icon`, optional `disabled`, and panel content as children.

## Data-driven API

Pass `options` when tabs come from data or content is rendered by a router. Each option has the same `value`, `label`, `icon`, and `disabled` contract plus an optional `panel`.

## API reference

```ts
type TabOption<T extends string = string> = {
  value: T; label: JSX.Element; icon?: string; disabled?: boolean; panel?: JSX.Element; onClose?: () => void;
  closeLabel?: string;
};

type TabsItemProps<T extends string = string> = Omit<TabOption<T>, "panel"> & {
  children?: JSX.Element;
};

type TabsProps<T extends string = string> = {
  value: MaybeAccessor<T>; onValueChange: (value: T) => void; ariaLabel: string;
  orientation?: "horizontal" | "vertical"; class?: string; variant?: "line" | "pill"; trailing?: JSX.Element;
  options?: readonly TabOption<T>[]; children?: JSX.Element;
};
```

Defaults: `orientation="horizontal"`, `variant="line"`. Supply `options` or `Tabs.Item` children. `onClose` reports intent; the host removes the item and owns its state. `ariaLabel` is required even when labels are visible.

## Accessibility

Tabs link triggers and panels with ARIA ids. Arrow keys move by orientation; Home and End select the edges. Selection and roving focus require hydration.

## Runtime

Tabs render complete server HTML. Selection and roving focus require hydration.
