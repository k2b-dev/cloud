# AutocompleteSelect

`AutocompleteSelect` is a controlled, keyboard-first field for choosing one
value through an asynchronous search. The application owns the selected value,
ranking, and the rule for when typed text is safe to accept.

## Use AutocompleteSelect

Use it when an experienced user may know an ID or label and must move through a
form quickly, while other users still need search and browse affordances.

Use `Select` for a normal persistent choice from a known list. Use `Combobox`
when choosing an item performs an action and then clears the input. Use
`AutocompleteEditor` when suggestions complete text rather than select a value.

## Import

```tsx
import {
  AutocompleteSelect,
  type AutocompleteSelectOption,
  type AutocompleteSelectSearchResult,
} from "@k2b/ui";
```

## Controlled value and initial display

Pass a string ID or `null` through `value` and update it with `onValueChange`.
Set a default in the parent's initial signal. Pass `selectedOption` when the
initial or remotely loaded value needs a label before it appears in search
results. `formatValue` controls the committed display without changing the ID.

Keyboard focus selects the complete committed display. Typing replaces it.
The first edit emits `null`, so stale selected data cannot be submitted while
the user is entering a replacement. Escape restores the value and display that
were present when editing began. If `clearable` is set, an optional field may
also be cleared by replacing its text with an empty string and leaving it.

## Authoritative asynchronous matching

`search(query, signal, group)` returns ranked `options` and may return one
`match`:

```ts
type AutocompleteSelectSearchResult = {
  options: readonly AutocompleteSelectOption[];
  match?: AutocompleteSelectOption;
};
```

The component deliberately does not infer a match from the first suggestion.
Only `match` may be accepted automatically on Tab or blur. This keeps fuzzy or
partial results useful for browsing without turning an uncertain query into a
silent selection. The provider can therefore apply domain-specific rules such
as exact ID, exact label, or one unambiguous prefix.

Typing starts a debounced search and aborts stale requests. Set `debounceMs` to
match the source; it defaults to 150 ms. When a user presses Tab before the
request finishes, native focus movement continues immediately. The resolved
request then commits its authoritative match or adds the no-match error without
moving focus back.

`noMatchText` customizes validation copy. Search failures remain technical
errors with retry; an empty successful result is not presented as a failed
request.

## Filter suggestions by group

Pass `groups` to expose the same compact group filters as `Select`. The active
group is the third `search` argument; it is `null` for the built-in **All**
choice. Changing the group immediately repeats the current search. Use
`defaultGroup`, `groupsAriaLabel`, and `allGroupLabel` to configure the initial
filter and its labels.

The option viewport owns wheel scrolling while the popover is open. Wheel
input over any part of the popover never scrolls the page, including when the
result list is too short to scroll or has reached either edge.

```tsx
<AutocompleteSelect
  label="Category"
  value={category}
  onValueChange={setCategory}
  groups={[
    { value: "recommended", label: "Recommended" },
    { value: "food", label: "Food" },
    { value: "work", label: "Work" },
  ]}
  defaultGroup="recommended"
  search={(query, signal, group) => categoryApi.search(query, { signal, group })}
/>
```

## Keyboard behavior

| Key | Result |
| --- | --- |
| Type | Replace the selected display and search asynchronously |
| Tab or blur | Accept only an authoritative match; otherwise report no match |
| Arrow Up or Down | Open results and explicitly focus a suggestion |
| Enter | Accept the focused suggestion |
| Escape | Restore the value present when editing began |

The clear action is deliberately outside the Tab order. Pointer users can still
clear the value, while the editable field itself opens the options without adding
another keyboard stop to the form's native field order.

## Accessibility

Use a visible `label` and useful `description`. The text input exposes combobox,
listbox, expanded, active-descendant, required, invalid, description, and error
semantics. Loading and accepted matches are announced through a polite live
region. Native custom validity prevents an unresolved edit from becoming a
valid submitted value.

## Runtime

The committed value and display render in server HTML. Searching, inline
completion, cancellation, popover navigation, and snapshot restoration require
hydrated Solid client code. The component calls `search` only after interaction;
it does not fetch during server rendering.

## Example

```tsx
const [category, setCategory] = createSignal<string | null>("551");

const search = async (query: string, signal: AbortSignal, group: string | null) => {
  const result = await categoryApi.search(query, { signal, group });
  return {
    options: result.suggestions,
    match: result.exactOrUnambiguousMatch,
  };
};

<AutocompleteSelect
  label="Category"
  description="Enter a code or search by label."
  value={category}
  onValueChange={setCategory}
  selectedOption={{ value: "551", label: "Paintings" }}
  search={search}
  formatValue={(option) => `${option.value} — ${option.label}`}
  noMatchText="No matching category found"
/>;
```
