# List queries: filter, sort, group

The one way to let people filter, sort or group a list or table. Recipe:
`recipes/filtered-table.tsx`.

## The three parts

1. **Declare** the list once with `defineListQuery` from
   `@k2b/ui/v2/list-query`, in a module the server and the island both
   import. Every field, value, sort and group is declared; labels are the
   app's final strings, keys and values are stable codes in the address.
2. **Read** the address on the server with `query.parse(searchParams)`, query
   your own data with your own access checks, and render the first picture
   from that state. Resolve the names of lookup codes there too.
3. **Show** it with `FilterBar` (in `Pane status`, above the `StatusRow`) and
   `ListOrder` (in `StatusRow filters`). Both write the address and call
   `onChange` with the new state; the app loads its rows for it.

```tsx
<Pane
  label="Artikel"
  status={
    <>
      <FilterBar query={articleQuery} state={state()} onChange={change} results={`${total} Artikel`} />
      <StatusRow lead={`${total} Artikel`} filters={<ListOrder query={articleQuery} state={state()} onChange={change} />} />
    </>
  }
>
```

## Field kinds

| Kind | Statement | Editor |
| --- | --- | --- |
| `choice` | "Status ist Eingeliefert oder Fotografiert" | listbox with checks (one tick with `multiple: false`), counts with `counts: true` |
| `lookup` | "Einlieferer ist Haus Bergmann" | `Lookup`: search, 200 ms wait, abort, placeholders, empty, failed with retry |
| `numberRange` | "Preis ab 500 €", "500 € bis 2.000 €" | presets and two fields, applied on Enter or leaving the field |
| `dateRange`, `timeRange` | "Eingang letzte 30 Tage" | presets, then "Von …" and "Bis …" with their values; each opens a `DatePicker` beside the editor like a submenu (to the left where the right has no room; a sheet step on the phone). `timeRange` adds hour and minute, applied with "Übernehmen" |
| `bool` | "2FA ist aus" | yes or no |
| `text` | "Request-ID ist 7f3a9c" | one field |

A `numberRange` writes its numbers with `unit` after them, or with `format`
(`Intl.NumberFormatOptions` in the render locale) as the table writes them:
`format: { style: "currency", currency: "EUR" }` gives "ab 12.345.678,90 €".
A `choice` with every value chosen filters nothing and says so: "Stufe ist
beliebig".

A field with `required` (a log's time range) is framed like a field and has
no × at its default; changed, it is tinted and × returns it to the default.

## Rules

- The island keeps one signal that mirrors the address: it starts with the
  state the server parsed and is set in `onChange`. That is the only filter
  state; never parse search parameters yourself, keep filter values the
  address does not hold, or build a row of filter `Chip`s or a filter
  `Popover`. One declaration, one bar.
- `names` are per field (`{ consignor: [...] }`): two lookups may use the same
  code for different things.
- `timeZone` (default "UTC") is the zone points in time are read and entered
  in. Give the person's zone, the same on the server and in the island.
  Around a change of the clocks an unchanged bound keeps its instant, a typed
  time that occurs twice means its first occurrence, a skipped one is refused
  at its calendar.
- `views.current` carries the query the view holds: renaming keeps it,
  updating replaces it with the state shown.
- `@k2b/ui` filters nothing and stores nothing. The server filters; saved
  views live where the app decides: pass `ViewStore`s (`device` as a cookie,
  `person` and `app` in the app's own table) through `FilterBar views`, or
  none, and there is no saving.
- Load views on the server and give them to the head's `Tabs`;
  `viewIcon(scope)` gives a saved view's tab its symbol.
- A value the address cannot hold is refused at its field; nothing is
  written.
