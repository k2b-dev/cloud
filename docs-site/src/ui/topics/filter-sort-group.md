---
thumbnail: filtered-table
---

# Filter, sort, group

A list that people narrow down, order or put into groups. Each active filter reads as a sentence, the sort and the grouping stand in words, and the address holds all of it, so reload, back and a shared link show the same list.

## A table people filter

Orders with two active filters: "Status ist Offen oder In Arbeit" and "Betrag ab 500 €". The list is declared once with `defineListQuery`, in a module the server and the island both import. `FilterBar` shows the filters as statements above the `StatusRow`, and `ListOrder` shows the sort and the grouping in its `filters`. Switch the state: no order matches, the rows load, or the editor of the status filter is open.

<Example recipe="filtered-table" height="520" default="Filtered" />

## A folder: two rows above list and detail

A page head has at most two full-width rows above its list and its detail: the path with the deeds, then the filters with the count, the order and the display at the `FilterBar`'s `end`. Without a `StatusRow` under it, the bar is the status row of the list (52 px); while files are selected, a `StatusRow selection` takes its place at the same height, and on the phone its actions float at the bottom. Switch the state: the grid of pictures, and three photos selected.

<Example recipe="files" height="720" default="List" />

## Cloud shows, the app filters

`@k2b/ui` gives the frontend and the types: the declaration, the bar, the editors and the address. It filters nothing and stores nothing.

- **The server filters.** It reads the address with `query.parse(searchParams)`, queries its own data with its own access checks, and renders the first picture from that state. It also resolves the names of lookup codes.
- **The island keeps one signal** that mirrors the address. It starts with the state the server parsed and is set in `onChange`, where the app loads its rows again. Never parse search parameters yourself, keep filter values the address does not hold, or build filter chips by hand.
- **Views live where the app decides.** Pass zero, one or more `ViewStore`s to `FilterBar views`: `device` as a cookie the server reads, `person` and `app` in the app's own table. Without stores there is no saving. Load the views on the server and give them to the head's `Tabs`; `viewIcon(scope)` gives a saved view's tab its symbol.
- **The address has a limit.** A value or a sort that would make the query longer than 2,000 characters is offered locked, with one hint under the list. A value the address cannot hold is refused at its field, and nothing is written.

## What the person sees

- **Statements.** Each filter is a sentence in the app's tint: "Status ist Eingeliefert oder Fotografiert", "und", "Preis ab 500 €". More than three values read "A, B oder 2 weitere". Pressing the words opens the field's editor; the small × removes the filter, and the focus moves to the next statement.
- **"+ Filter"** lists the fields, the common ones first. A field without a value is a dashed statement that applies once it has one. **"Zurücksetzen"** returns to the current view in one step.
- **Sort and group** stand in words in the status row: "⇅ Fällig ↑" and "Nach Status", each a menu with one choice.
- **On the phone** the bar is one line that scrolls sideways. Every tap opens the filter sheet: every field with its value, sort and group, and "Zurücksetzen" and "9 Aufträge zeigen" at the foot.
- **Values that load.** A `lookup` field opens `Lookup`: a search that waits 200 ms, aborts an older search, shows placeholder rows while it loads, and says "Erneut versuchen" when it fails. `Lookup` also works in a form.

The field kinds: `choice` (a listbox with ticks, counts with `counts: true`), `lookup`, `numberRange` ("Preis ab 500 €"), `dateRange` and `timeRange` ("Eingang letzte 30 Tage", read in the `timeZone` you pass, "UTC" by default), `bool` and `text`.

## Filter bar or a plain search?

### FilterBar

- People narrow a list by several fields: status, amount, a person.
- The state belongs in the address, shared by a link.
- Sort and grouping are choices people make.

### Search field

- One text is enough: a name, a number.
- `Input type="search"` in the head `Bar`; declare it as the query's `search`, so it lives in the address as well.
- No statements, no views.

## Parts

Each part in one line. Props are generated from the types of `@k2b/ui/v2`; the declaration comes from `@k2b/ui/v2/list-query`.

### defineListQuery

The one declaration of fields, search, sorts and groups, shared by the server (`parse`) and the island; labels are the app's final strings, keys and values are stable codes in the address.

### FilterBar

The active filters as statements, in `Pane status` above the `StatusRow`; it writes the address and calls `onChange`.

<Props of="FilterBar" />

### ListOrder

The sort and the grouping in words, in `StatusRow filters`.

<Props of="ListOrder" />

### Lookup

Values that load while the person types, in a filter (the bar opens it) or in a form.

<Props of="Lookup" />

## Not in v2 yet

Filters inside a column head and a free query builder (and, or, brackets). Until they ship, use the `FilterBar` with its fields and write `// k2b-ui gap: …` at that place.

## Do and don't

### Do

- Declare the list once with `defineListQuery` and import it on the server and in the island.
- Filter on the server, with your own access checks.
- Start the island's signal with what the server parsed.
- Pass `views` only when the app stores views.

### Don't

- Parse search parameters yourself or keep filter state outside the address.
- Build a row of filter `Chip`s or a filter `Popover` by hand.
- Expect `@k2b/ui` to filter rows or to store views.
- Put sort or grouping into a filter statement; they stand in `ListOrder`.

## Next

[Record and detail](/en/ui/v2/record-and-detail)
