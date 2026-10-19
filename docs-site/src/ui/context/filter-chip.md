# FilterChip

`FilterChip` groups related list filters behind one compact trigger. The caller owns the selected values and decides how they affect the URL, query, or dataset.

## Use FilterChip

Use it when several optional filters should stay available without occupying a permanent filter bar.

Keep frequently changed or required controls visible instead. Use `Select` for one ordinary form value.

## Import

```tsx
import {
  FilterChip,
  FilterToggle,
  type FilterToggleProps,
  type FilterChipSection,
} from "@k2b/ui";
```

## State model

`FilterChip` is controlled. Pass the selected option values through `value` and update the owning state in `onValueChange`.

Each section chooses its selection behavior:

- the default is single-select within that section;
- `multiple: true` allows several values from that section;
- `layout: "row"` sets a few short single-select options side by side as one
  segmented row under its `label`, which names the choice (see
  [menus](/en/ui/actions/menus#items-and-sections)); selecting the chosen
  option again keeps it, and a row value in `defaultValue` keeps a choice
  through Reset too;
- selections from other sections stay intact;
- option values must be unique across all sections.

Changes are emitted immediately. This makes the component suitable for URL-backed filters and live data queries.

## Properties

| Property | Type | Default | Purpose |
| --- | --- | --- | --- |
| `label` | `string` | required | Names the filter in the trigger and its accessible label. |
| `icon` | `string` | required | Adds a Tabler icon to the trigger. |
| `options` | `readonly FilterChipSection[]` | required | Defines sections and their options. |
| `value` | `readonly string[]` | required | Contains all selected option values. |
| `onValueChange` | `(value: string[]) => void` | yes | Receives the complete next selection. |
| `class` | `string` | none | Adds classes to the trigger. |
| `isActive` | `boolean` | `value.length > 0` | Overrides the active trigger treatment. |
| `position` | `"bottom-left" \| "bottom-right"` | `"bottom-left"` | Positions the dropdown relative to the trigger. |
| `defaultValue` | `readonly string[]` | none | A non-empty array resets to a baseline instead of clearing all values. |
| `disabled` | `boolean` | `false` | Disables the trigger and menu actions. |
| `iconOnly` | `boolean` | `false` | Shows only the icon; the label stays the accessible name and appears as its tooltip. |
| `variant` | `ButtonVariant` | none | Uses the standard button appearance, for example `input` beside a search field. Omit to keep the default filter field. |
| `showValue` | `boolean` | `false` | An active chip names its first value instead of a count ("Tags: Customer"). Use it in `AppWorkspace.Head`. |

## Sections and options

```ts
type FilterChipSection = {
  label?: string;
  options: readonly FilterChipOption[];
  multiple?: boolean;
  layout?: "row";
};

type FilterChipOption = {
  value: string;
  label: string;
  icon?: string;
  color?: string;
};
```

Use section labels when the dropdown combines different filter dimensions. Icons suit single-select status choices. Colors can identify tags or categories. A row section suits a short display choice that belongs with the filters, such as what a color shows, without a control of its own in the toolbar.

The menu shows up to 32rem (and at most 80 % of the viewport height) before it scrolls, so several labelled sections stay visible at once.

## Active values and surface

The chip is a soft surface without a border. An active chip is tinted in the
app's selection color.

With `showValue`, an active chip names its first selected option in section
order instead of a count: **Tags: Customer**, and with three selected values
**Tags: Customer +2**. Pass only the filter's name as `label`, such as
`"Tags"`. If that option has a color, a small dot appears before its name; the
name always shows, so color is never the only signal. The chip grows with its
value, so use `showValue` where the row may wrap, as in
[the workspace head](/en/ui/layout/workspace#objects-on-the-left-views-in-the-head).
There the chips share the view row while there is room, and `Head.filtered`
shows one shared **Reset** beside them. The chip's own menu reset stays.

Without `showValue`, an active chip keeps the count described below, so a
toolbar built around a stable chip width keeps its geometry.

## Clear and reset

Without `defaultValue`, an active filter shows its selected count and offers **Clear**. An empty `defaultValue={[]}` has the same clear/count behavior.

With a non-empty `defaultValue`, the trigger hides the count and offers **Reset** whenever the current values differ from the baseline. At the baseline, no reset action is shown.

Reset emits `defaultValue` as it is, and Clear emits an empty selection. A row section with no value in `defaultValue` ends up with no choice either way, so give every row its baseline value there. For a display choice that Reset should leave alone, such as what a color shows, put the current choice into `defaultValue`: Reset then appears only for changed filters and keeps the choice.

## Accessibility

`label` is the accessible name, including in `iconOnly` mode. With `showValue`, an active chip's name also carries the value it shows. Option labels must remain meaningful without relying on their icon or color.

The options are menu items: on touch devices each option is at least 44 px (2.75rem) tall, as described in [menus](/en/ui/actions/menus#touch-menus).

## Runtime

`FilterChip` is interactive and requires browser code. The parent page can remain server rendered.

## Example

```tsx
const [filters, setFilters] = createSignal<string[]>(["open", "ui"]);

const sections: FilterChipSection[] = [
  {
    label: "Status",
    options: [
      { value: "open", label: "Open", icon: "ti ti-circle" },
      { value: "done", label: "Done", icon: "ti ti-check" },
    ],
  },
  {
    label: "Tags",
    multiple: true,
    options: [
      { value: "urgent", label: "Urgent", color: "#ef4444" },
      { value: "ui", label: "UI", color: "#14b8a6" },
    ],
  },
];

<FilterChip
  label="Filter"
  icon="ti ti-filter"
  options={sections}
  value={filters()}
  onValueChange={setFilters}
/>;
```

## FilterToggle

Use `FilterToggle` for one on/off filter, such as **Service accounts** or
**Only mine**. The parent owns `active` and updates the URL or filter state.
It has the same look and app selection tint as an active `FilterChip`.
Selection changes only color and background, so neighboring chips stay in place.

Pass `href` to render a native link that works without JavaScript. The active
link carries `aria-current="true"`. Without `href`, it renders a button with
`aria-pressed`; use `onClick` to update the controlled state. A disabled toggle
renders a disabled button even when `href` is supplied.

```tsx
const [onlyMine, setOnlyMine] = createSignal(false);

<FilterToggle
  label="Only mine"
  icon="ti ti-user"
  active={onlyMine()}
  onClick={() => setOnlyMine(!onlyMine())}
/>;

<FilterToggle
  label="Service accounts"
  icon="ti ti-user-key"
  active={showServiceAccounts}
  href={serviceAccountsToggleUrl}
/>;
```

```ts
type FilterToggleProps = {
  label: JSX.Element;
  icon: string;
  active: boolean;
  href?: string;
  onClick?: (event: MouseEvent) => void;
  title?: string;
  disabled?: boolean;
  class?: string;
};
```
