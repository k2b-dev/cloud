# IconInput

`IconInput` selects one Tabler icon from a searchable catalogue. The parent
owns the selected class string and its persistence.

## Use IconInput

Use it when users may choose an icon for a resource or category. The default
catalogue starts with **Recommended** and offers overlapping topic filters such
as **Work**, **Food**, and **Data & tech**. Short descriptions help distinguish
icons with similar meanings.

Pass `options` when the domain should expose only a curated subset. A custom
list stays ungrouped unless you also pass `groups`; this avoids imposing the
default catalogue's topics on domain-owned choices.

## Import

```tsx
import {
  DEFAULT_ICON_GROUPS,
  DEFAULT_ICON_OPTIONS,
  IconInput,
} from "@k2b/ui";
```

`IconInput` uses `DEFAULT_ICON_OPTIONS` and `DEFAULT_ICON_GROUPS` when `options`
is omitted. Pass a domain-specific list only when the application needs a
narrower vocabulary.

## Value, groups, and search

The controlled `value` is the complete Tabler class string, for example
`"ti ti-currency-euro"`. Render it directly with `<i class={icon()}>`.

`onValueChange` receives the next class string or `null`. Empty selection is
allowed by default through `clearable`.

Groups are filters, not exclusive categories. An option may belong to several
groups, and **All** removes the group filter. Text search applies within the
active group and matches labels plus synonyms with local fuzzy filtering.
`searchLimit` defaults to `50` for non-empty searches. No request or
asynchronous option transition is involved.

Relevant properties are `label`, `description`, `placeholder`, `value`,
`onValueChange`, `error`, `required`, `clearable`, `disabled`, `options`,
`groups`, `defaultGroup`, `groupsAriaLabel`, `allGroupLabel`, and `searchLimit`.

## Accessibility

Provide a visible `label`. Option labels name the icons; the glyph is
supplementary. The group filters form a labelled radio group and support arrow
keys, Home, and End.

When the selected icon is rendered elsewhere as an action, that action still
needs its own accessible name.

## Runtime

The picker uses the interactive `Select` component and local fuzzy search, so
it must run in hydrated Solid client code. It performs no network request.

## Example

```tsx
const [icon, setIcon] = createSignal<string | null>("ti ti-star");

const groups = [
  { value: "recommended", label: "Recommended" },
  { value: "commerce", label: "Commerce" },
];

const icons = [
  {
    value: "ti ti-star",
    label: "Star",
    description: "A featured or favorite item",
    keywords: ["favorite"],
    groups: ["recommended"],
  },
  {
    value: "ti ti-shopping-cart",
    label: "Shopping cart",
    description: "Items ready to purchase",
    keywords: ["basket", "checkout"],
    groups: ["recommended", "commerce"],
  },
];

<IconInput
  label="Icon"
  options={icons}
  groups={groups}
  defaultGroup="recommended"
  value={icon()}
  onValueChange={setIcon}
/>;
```
