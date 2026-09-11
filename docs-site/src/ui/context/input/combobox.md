# Combobox

`Combobox` searches asynchronous options and immediately hands the selected
item to the parent. It clears after each selection and does not own a selected
value.

## Use Combobox

Use it for repeated add actions such as adding members, resources, or references.

Use `Select` when one selected value must remain visible. Use
`MultiSelectInput` when the field itself owns a visible list of selections.

## Import

```tsx
import {
  Combobox,
  type ComboboxOption,
  type ComboboxProps,
} from "@k2b/ui";
```

## Search and selection

`fetchData(query, signal)` runs immediately with an empty query when the field
opens and after a 150 ms debounce while the user types. Set `debounceMs` when
the data source needs a different delay. A new query or closed popover aborts
the previous request.

Each result has `id`, `label`, and optional `description` and `icon`. The
selected callback receives that complete object. `Combobox` adds the `ti`
family class itself, so pass the bare Tabler name such as `ti-user` for `icon`.
Select, MultiSelectInput, and FilterChip take the complete class instead.

`onSelect` receives the complete option. The component then clears the query, closes the result list, and returns focus to the input so another item can be added.

Use `query` with a direct string or Solid accessor when the application needs
to own the current search text. `onQueryChange` receives each edit and the
automatic clear after selection.

Loading keeps the previous results visible. A failed lookup replaces the list with its error and a retry action.

## API reference

See [shared field props](/en/ui/getting-started#shared-field-props) for `FieldProps`, `ValueFieldProps<T>` and `MaybeAccessor<T>`.

```ts
type ComboboxOption = { id: string; label: string; description?: string; icon?: string };

type ComboboxProps = FieldProps & {
  query?: MaybeAccessor<string>; onQueryChange?: (query: string) => void; placeholder?: string;
  fetchData: (query: string, signal: AbortSignal) => Promise<ComboboxOption[]>;
  onSelect: (option: ComboboxOption) => void; debounceMs?: number;
};
```

`debounceMs` defaults to `150`. Omit `query` for internal query state; supplying it makes the host responsible for applying `onQueryChange`.

## Accessibility

The input exposes combobox, expanded, controlled-list, and active-option state.
The results use listbox and option semantics with keyboard navigation.

Use the shared `label`, `description`, reactive `error`, `required`, and
`disabled` properties for field semantics. When surrounding UI already names
the control, provide the native `"aria-label"` property. A placeholder is not
a persistent label.

## Runtime

`Combobox` requires hydrated Solid client code. It uses browser focus, the Popover API, measured viewport placement that matches the field width, request cancellation, and keyboard events.

## Example

```tsx
const people = [
  { id: "user-1", label: "Alice", description: "Design" },
  { id: "user-2", label: "Bob", description: "Engineering" },
];
const [memberIds, setMemberIds] = createSignal<string[]>([]);

<Combobox
  placeholder="Search people to add"
  debounceMs={150}
  fetchData={async (query, signal) =>
    people.filter((person) =>
      person.label.toLowerCase().includes(query.toLowerCase())
    )
  }
  onSelect={(person) =>
    setMemberIds((current) =>
      current.includes(person.id)
        ? current
        : [...current, person.id]
    )
  }
/>;
```
