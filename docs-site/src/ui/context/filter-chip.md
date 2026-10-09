# FilterChip

`FilterChip` groups related list filters behind one compact trigger. The caller owns the selected values and decides how they affect the URL, query, or dataset.

## Use FilterChip

Use it when several optional filters should stay available without occupying a permanent filter bar.

Keep frequently changed or required controls visible instead. Use `Select` for one ordinary form value.

## Import

```tsx
import {
  FilterChip,
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

## Clear and reset

Without `defaultValue`, an active filter shows its selected count and offers **Clear**. An empty `defaultValue={[]}` has the same clear/count behavior.

With a non-empty `defaultValue`, the trigger hides the count and offers **Reset** whenever the current values differ from the baseline. At the baseline, no reset action is shown.

Reset emits `defaultValue` as it is, and Clear emits an empty selection. A row section with no value in `defaultValue` ends up with no choice either way, so give every row its baseline value there. For a display choice that Reset should leave alone, such as what a color shows, put the current choice into `defaultValue`: Reset then appears only for changed filters and keeps the choice.

## Accessibility

`label` is always the accessible name, including in `iconOnly` mode. Option labels must remain meaningful without relying on their icon or color.

The options are menu items: on touch devices each option is at least 44 px (2.75rem) tall, as described in [menus](/en/ui/actions/menus#touch-menus).

## Runtime

`FilterChip` is interactive and must run in hydrated Solid client code. The parent page can remain server rendered.

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
