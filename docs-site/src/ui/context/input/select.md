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

Set `viewToggle` to offer list and tile views for visual options.

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

## API reference

See [shared field props](/en/ui/getting-started#shared-field-props) for `FieldProps`, `ValueFieldProps<T>` and `MaybeAccessor<T>`.

```ts
type ChoiceOption<T extends string = string> = {
  value: T; label: string; description?: string; icon?: string; color?: string; disabled?: boolean;
  groups?: readonly string[];
};

type SelectOption = ChoiceOption<string>;

type SelectSourceOption =
  | string
  | {
      id: string;
      label?: string;
      description?: string;
      icon?: string;
      color?: string;
      groups?: readonly string[];
    }
  | SelectOption;

type SelectGroup = {
  value: string; label: string;
};

type SelectView = "list" | "grid";

type SelectGridSize = "sm" | "md" | "lg";

```

### Select props

```ts
type SelectProps = ValueFieldProps<string | null> & {
  placeholder?: string; icon?: string; activeIcon?: string; options?: SelectSourceOption[];
  fetchData?: (query: string, signal: AbortSignal, group: string | null) => Promise<SelectSourceOption[]>;
  loadOptions?: (query: string, signal: AbortSignal, group: string | null) => Promise<readonly ChoiceOption<string>[]>;
  selectedOption?: ChoiceOption<string>; selectedLabel?: () => string | undefined; fetchDebounceMs?: number;
  debounceMs?: number; searchable?: boolean;
  filterOptions?: (options: readonly SelectOption[], query: string) => readonly SelectOption[];
  groups?: readonly SelectGroup[]; defaultGroup?: string; groupsAriaLabel?: string; allGroupLabel?: string;
  viewToggle?: boolean; defaultView?: SelectView; gridSize?: SelectGridSize; searchPlaceholder?: string;
  clearable?: boolean; name?: string;
};

```

### MultiSelectInput props

```ts
type MultiSelectOption =
  | string
  | { id: string; label?: string; description?: string; icon?: string; color?: string; groups?: readonly string[] }
  | ChoiceOption<string>;

type MultiSelectFetchDataFn = (query: string, signal: AbortSignal, group: string | null) => Promise<MultiSelectOption[]>;

type MultiSelectInputProps = ValueFieldProps<string[]> & {
  options?: MultiSelectOption[]; fetchData?: MultiSelectFetchDataFn;
  selectedOptions?: () => MultiSelectOption[]; placeholder?: string; icon?: string; activeIcon?: string;
  fetchDebounceMs?: number; debounceMs?: number;
  loadOptions?: (query: string, signal: AbortSignal, group: string | null) => Promise<readonly ChoiceOption<string>[]>;
  groups?: readonly SelectGroup[]; defaultGroup?: string; groupsAriaLabel?: string; allGroupLabel?: string;
  searchable?: boolean; clearable?: boolean; name?: string;
  renderOption?: (option: ChoiceOption<string>) => JSX.Element;
  renderValue?: (option: ChoiceOption<string>) => JSX.Element; searchPlaceholder?: string;
  loadingLabel?: string; noResultsLabel?: string; emptyLabel?: string; retryLabel?: string;
  clearLabel?: string;
};

```

### SelectChip props

```ts
type SelectChipOption<T extends string | number = string> = {
  value: T; label: string; description?: string; icon?: string; image?: string; disabled?: boolean;
};

type SelectChipProps<T extends string | number = string> = ValueFieldProps<T> & {
  value: MaybeAccessor<T>; options: SelectChipOption<T>[]; icon?: string; iconOnly?: boolean;
  size?: ButtonSize; placeholder?: string; position?: DropdownPosition; menuWidth?: string; name?: string;
};
```

`fetchData` takes precedence over `loadOptions`; either remote source takes precedence over `options`. Debounce is `fetchDebounceMs ?? debounceMs ?? 200` milliseconds. Static `Select` search defaults off; static `MultiSelectInput` search defaults on. Remote search is always enabled. Render callbacks belong to `MultiSelectInput`, not `Select`. They receive normalized `ChoiceOption<string>` objects and return Solid content.

`SelectChip.size` uses [ButtonSize](/en/ui/actions/buttons); `position` uses [DropdownPosition](/en/ui/actions/menus#api-reference). `menuWidth` is a CSS length, default `"10rem"`. `SelectChip` does not accept `null`; represent an explicit empty choice with an option of your value type.

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
