# Select inputs

`Select`, `MultiSelectInput`, and `SelectChip` cover three different selection
tasks. The parent owns every selected value.

## Use select inputs

Choose from the state transition, not from the desired visual shape:

| Task                                        | Component            | Value contract                 |
| ------------------------------------------- | -------------------- | ------------------------------ |
| Choose one value in a form                  | `Select`             | one controlled value or `null` |
| Type, validate, and keep one remote value   | `AutocompleteSelect` | one controlled ID or `null`    |
| Choose several values                       | `MultiSelectInput`   | one controlled ID array        |
| Choose one compact toolbar value            | `SelectChip`         | one controlled value           |
| Filter a result set                         | `FilterChip`         | controlled filter state        |
| Find an item, perform an action, then clear | `Combobox`           | selected item callback         |
| Run a secondary action or open a link       | `Dropdown`           | no field value                 |

Do not rebuild select rows in a `Dropdown`. That loses the shared field,
listbox, or radio semantics and makes alignment and keyboard behavior the
consumer's responsibility. `Dropdown` therefore accepts only declarative
actions and choices. See [Dropdown and ContextMenu](../actions/menus) for
action menus.

## Import

```tsx
import {
  MultiSelectInput,
  type MultiSelectInputProps,
  type MultiSelectOption,
  Select,
  SelectChip,
} from "@k2b/ui";
```

## Select

Pass the selected value directly or through a Solid accessor. Selection and
clearing are atomic actions, so both `onValueChange` and `onValueCommit`
receive the complete next value. Clearing emits `null`.

Static options may be strings, `{ id, label?, description?, icon?, color? }`,
or normalized `{ value, label, description?, icon?, color?, disabled?, groups? }`
objects.

`Select.fetchData(query, signal, group)` and
`MultiSelectInput.fetchData(query, signal, group)` accept their convenient
source shapes. Their `loadOptions(query, signal, group)` variants accept
normalized options. They run with
an empty query when the dropdown opens, debounce later input, and abort stale
requests. `group` is the active group value or `null` for all options. Pass
`selectedOption` when the current value needs display metadata before the first
result arrives, or `selectedOptions` for `MultiSelectInput`.

Remote sources always show the search field. Set `searchable` to add it to a
static option list, where it filters labels, descriptions, and values in the
browser. In `Select`, an option `color` replaces the icon with a color dot on the
trigger and in the list. `MultiSelectInput` tints the option icon and the
selected pill with it instead.

### Filter one list by group

Pass `groups` to `Select` or `MultiSelectInput` when a long option list benefits
from a short set of filters.
Each option lists its group values through `option.groups`; one option may
belong to several groups. `defaultGroup` selects the initial group. The built-in
**All** choice removes the group filter, and `allGroupLabel` can rename it.

For static options, the active group and text search are combined. For remote
options, apply the third `group` argument in the data source and return the
matching page. The component does not filter a partial remote result page in
the browser.

Group chips stay on one horizontal row. When they exceed the dropdown width,
the row scrolls by touch or trackpad and reveals an overlay scrollbar on hover
or keyboard focus without changing the toolbar height.

```tsx
<Select
  label="Icon"
  value={icon()}
  onValueChange={setIcon}
  options={[
    {
      value: "ti ti-briefcase",
      label: "Briefcase",
      groups: ["recommended", "work"],
    },
    {
      value: "ti ti-coffee",
      label: "Coffee",
      groups: ["recommended", "food"],
    },
  ]}
  groups={[
    { value: "recommended", label: "Recommended" },
    { value: "food", label: "Food" },
    { value: "work", label: "Work" },
  ]}
  defaultGroup="recommended"
  searchable
/>;
```

### Switch between list and tile views

Set `viewToggle` when visual options benefit from both detailed rows and a
compact tile overview. One transparent icon button appears at the right edge
of the group filters, or right-aligned below the search field when no groups
are present. It shows the available alternative: `ti-category-2` in list view
and `ti-list-details` in tile view. Hover changes only the icon color.

`defaultView` accepts `"list"` or `"grid"` and defaults to `"list"`.
`gridSize` accepts `"sm"`, `"md"`, or `"lg"` and defaults to `"md"`:

| Size | Tile content                  | Minimum tile width |
| ---- | ----------------------------- | ------------------ |
| `sm` | icon or color plus label      | `4.5rem`           |
| `md` | icon, label, and description  | `7rem`             |
| `lg` | roomier label and description | `9rem`             |

The switch changes presentation only. Search, groups, remote loading,
disabled options, keyboard focus, and selection continue to use the same
option list. The chosen view stays local to the mounted `Select`; remounting
starts from `defaultView`. Without `viewToggle`, `Select` always keeps the
list layout.

```tsx
<Select
  label="Icon"
  value={icon()}
  onValueChange={setIcon}
  options={icons}
  groups={iconGroups}
  defaultGroup="recommended"
  viewToggle
  defaultView="grid"
  gridSize="md"
  searchable
/>;
```

## MultiSelectInput

Pass the selected array directly or through a Solid accessor. Every selection
change reports the complete next array through both `onValueChange` and
`onValueCommit`. Static options may carry a color for selected pills.

It supports the same static or remote option sources. For remote data, `selectedOptions` supplies labels and metadata for selected IDs that are not in the current result page.

The dropdown always opens with a search field, which filters a static option
list in the browser. Pass `searchable={false}` for a short fixed list.

## SelectChip

`SelectChip` accepts its current `value` directly or through a Solid accessor.
Each selection closes the menu before reporting through both value callbacks,
so a consumer update cannot leave stale option content visible. Its options use
`{ value, label }`, and their values may be strings or numbers. Optional
`icon`, `image`, and `description` metadata supports compact rich choices such
as model or environment selectors; use `menuWidth` only when their copy needs
more than the default `10rem`.

Selection popovers dismiss synchronously. Do not add a generic host-level
`[popover]` display or overlay transition around them; `@k2b/ui` explicitly
keeps interactive choice surfaces immediate.

Keep it for compact toolbars. It supports the same field label, description,
reactive error, required, and disabled state, but has no clear state.

Set `iconOnly` together with an `icon` and `"aria-label"` when the surrounding
toolbar or section header already explains the control's context. The trigger
then uses the shared icon-button treatment while the menu keeps the same radio
selection contract. Use `size` only with this icon-only form.

```tsx
const [permission, setPermission] = createSignal("read");

<SelectChip
  aria-label="Permission"
  value={permission}
  onValueChange={setPermission}
  options={[
    { value: "read", label: "View", icon: "ti ti-eye" },
    { value: "write", label: "Edit", icon: "ti ti-pencil" },
    { value: "admin", label: "Manage", icon: "ti ti-shield" },
  ]}
/>;

<SelectChip
  aria-label="Sort notes"
  icon="ti ti-arrows-sort"
  iconOnly
  size="xs"
  value={sort()}
  onValueChange={setSort}
  options={sortOptions}
/>;
```

## Accessibility

Use visible labels on `Select` and `MultiSelectInput`. Their triggers expose combobox, listbox, expanded, selected, required, disabled, description, and error state. Select groups use a labelled radio group; arrow keys, Home, and End change the active group. The optional layout button names the view it will open and does not change the listbox semantics.

Option labels must remain clear without icons or colors. If the surrounding
toolbar already names a `SelectChip`, use the native `"aria-label"` property
instead of repeating a visible label.

## Runtime

Triggers and selected values render in server HTML. Dropdown positioning, keyboard navigation, remote loading, selection, and clearing require hydrated Solid client code.

## Example

```tsx
const [status, setStatus] = createSignal("open");

<Select
  label="Status"
  placeholder="Choose a status"
  options={[
    { id: "open", label: "Open", icon: "ti ti-circle" },
    { id: "done", label: "Done", icon: "ti ti-check" },
  ]}
  value={status}
  onValueChange={setStatus}
  clearable
/>;
```
