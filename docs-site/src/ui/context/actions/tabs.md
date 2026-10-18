# Tabs

`Tabs` switches in-page panels. `ViewTabs` navigates between views of an object with ordinary `?view=` links. Prefer colocated `Tabs.Item` children when each panel owns content; use `options` for data-driven panels.

## Use Tabs

Use `Tabs` for in-page panels and `ViewTabs` for URL-backed object views in `AppWorkspace.Head`. Use `Disclosure` for optional detail that does not replace the current view.

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

Pass `options` when in-page tabs come from data. Each option has the same `value`, `label`, `icon`, and `disabled` contract plus an optional `panel`.

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

Tabs link triggers and panels with ARIA ids. Arrow keys move by orientation; Home and End select the edges. Selection and roving focus require browser code.

## Runtime

Tabs render complete server HTML. Selection and roving focus require browser code.

## Workspace tabs

Use `variant="pill"` for compact rounded tabs. Long labels use the shared
[fade utility](/en/ui/layout/navigation#label-overflow). Each option (or `Tabs.Item`)
may provide `onClose` and a localized `closeLabel`. Closing reports intent;
the application owns confirmation, item removal, and the next selected value.
Delete or Backspace closes the focused tab when a close handler is present.
The selected tab always shows its close control. With any pointer that can
hover, including a mouse on a tablet, other tabs show theirs on hover or
keyboard focus; touch-only screens show every close control.

The classic tab list scrolls horizontally and never vertically; its focus ring stays whole inside it. Where the platform shows
scrollbars, the horizontal one is thin. Subtle overflow fades appear only at edges
with hidden content and disappear when the list fits. Vertical tabs are not
masked; forced-color mode leaves every orientation unmasked. The active tab
remains visible. Use
`trailing` for a fixed action outside the scrollport, such as an IconButton or
Dropdown trigger. The application owns that action and its menu entries.
Do not nest a close button inside a tab label.

These options change navigation chrome only. Applications that keep running
sessions or editor drafts mounted should continue rendering their content
outside `Tabs`; switching the active panel is not a keep-alive mechanism.

## ViewTabs

Use `ViewTabs` beside the title in [the workspace head](/en/ui/layout/workspace#objects-on-the-left-views-in-the-head).
The server reads `current` from `?view=`; an unknown id selects nothing.
Each visible view is a normal link in the Tab order, with `aria-current="page"`
on the open view. These links form a labelled navigation landmark, with no
ARIA tablist or roving focus.

```tsx
import { ViewTabs } from "@k2b/ui";

<ViewTabs label="Views" current={currentView} items={[
  { id: "list", label: "List", href: "?view=list", icon: "ti ti-list", count: 12 },
  { id: "board", label: "Board", href: "?view=board", icon: "ti ti-layout-board" },
]} />;
```

`max` defaults to 5. Beyond that limit, **More +n** holds the remaining
views. When the head is narrow, CSS keeps at most three views (or `max`, if
smaller). The current view always stays visible by replacing the last visible
slot when needed. The menu lists the views hidden at the time it opens, in
original order, with counts as quiet trailing text. It never repeats the
current view. Opening the menu is the only step that reads CSS visibility;
the server already renders the final strip and both counts.

Navigation defaults to `"document"`. Use `"enhanced"` only with `onNavigate`
inside an island that loads and applies the destination. Without that callback,
links keep document navigation.

Both tab controls have a soft appearance: no tray, baseline, selection ring,
or underline. The selected view uses the app tint. Font weight never changes
with selection or hover, so neighbouring controls keep their positions.
Keyboard focus retains its visible focus ring.

```ts
type ViewTab = {
  id: string; label: string; href: string; icon?: string; count?: number | string;
};
type ViewTabsProps = {
  label: string; items: readonly ViewTab[]; current: string | undefined; max?: number;
  navigation?: "enhanced" | "document";
  onNavigate?: (event: LinkNavigateEvent) => void | Promise<void>;
  class?: string;
};
```
