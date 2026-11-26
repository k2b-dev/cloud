---
thumbnail: filtered-table
---

# Filter, sort, group

A list that people narrow down, order or put into groups. Each active filter reads as a sentence, the sort and the grouping stand in words, and the address holds all of it, so reload, back and a shared link show the same list.

## A table people filter

Orders with two active filters: "Status ist Offen oder In Arbeit" and "Betrag ab 500 €". The list is declared once with `defineListQuery`, in a module the server and the island both import. `FilterBar` shows the filters as statements above the `StatusRow`, and `ListOrder` shows the sort and the grouping in its `filters`. Switch the state: no order matches, the rows load, or the editor of the status filter is open.

<Example recipe="filtered-table" height="520" default="Filtered" />

## Cloud shows, the app filters

`@k2b/ui` gives the frontend and the types: the declaration, the bar, the editors and the address. It filters nothing and stores nothing.

- **The server filters.** It reads the address with `query.parse(searchParams)`, queries its own data with its own access checks, and renders the first picture from that state. It also resolves the names of lookup codes.
- **The island keeps one signal** that mirrors the address. It starts with the state the server parsed and is set in `onChange`, where the app loads its rows again. Its second argument says where the change came from: `{ source: "user" }` for the bar (a paged list starts at its first page again), `{ source: "history" }` for back and forward (the list keeps the page the address names). While the rows load, give the list's `Pane busy`: the rows shown stay, quieter, under a thin moving line, and nothing moves; no state per statement. Never parse search parameters yourself, keep filter values the address does not hold, or build filter chips by hand.
- **Views live where the app decides.** Pass zero, one or more `ViewStore`s to `FilterBar views`: `device` as a cookie the server reads, `person` and `app` in the app's own table. Without stores there is no saving. Load the views on the server and give them to the head's `Tabs`; `viewIcon(scope)` gives a saved view's tab its symbol.
- **Verbs in the address.** The first declared verb keeps the plain name (`title=Vitrine`) and always compares with a value, so a form's empty field never means "is empty"; every other one is `key.verb` (`status.not=online,sold`, `due.empty=`). One statement per field.
- **The query names its own parameters.** `params: { search, sort, group, view }` renames what the query writes besides its fields (`ordnung=price.desc`), so a page keeps `sort` or `q` for itself (`pageParams`); `query.names` gives the names in use. A name is taken only for a part the declaration has.
- **What the app deleted stays harmless.** An option, preset, sort or group an app removed while old links and saved views still name it is left out by `parse`, `serialize` and `set`, never thrown; a state the app built itself with such a value shows it in the bar as its code with a warning, and the next change leaves it out. A new value given to `set` must still be declared.
- **The address has a limit.** A value or a sort that would make the query longer than 2,000 characters is offered locked, with one hint under the list. A value the address cannot hold is refused at its field, and nothing is written.

## What the person sees

- **Statements.** Each filter is a sentence in the app's tint: "Status ist Eingeliefert oder Fotografiert", "und", "Preis ab 500 €". More than three values read "A, B oder 2 weitere". Pressing the words opens the field's editor; the small × removes the filter, and the focus moves to the next statement.
- **"+ Filter"** lists the fields, the common ones first, then each `category` under its heading, then "Weitere". From more than ten fields on it is a search over them, the `search` of `Menu` ([Actions and menus](/en/ui/v2/actions-and-menus)): the focus in the search, the arrows through the fields, accents do not matter; the phone sheet searches the same way and keeps its height while it does. A field without a value is a dashed statement that applies once it has one. **"Zurücksetzen"** returns to the current view in one step.
- **Verbs.** A field with `verbs` lets the person choose how it compares, in a "Vergleich" select under the editor's head: "Titel enthält Vitrine", "Status ist weder Online noch Verkauft", "Preis über 500 €", "Fällig vor 15.12.2026", "Epoche ist nicht leer". Each verb brings what it compares with: the field's own values (`is`, `not`, the text verbs, `between`), one number, one day or one minute (`before`, `after`, and `is` of a range), or nothing (`empty`, `notEmpty`, which apply as they are chosen). Another verb keeps the value when it compares with the same kind; else the filter waits for a new one. Comparisons a field's own dialog owns (exclusive bounds, "last N days" with a free N, several statements per field, patterns) stay with the app.
- **Sort and group** stand in words in the status row: "⇅ Fällig · Älteste zuerst" and "Nach Status". The sort's menu has two choices, "Sortieren nach" (the fields) and "Reihenfolge" in words, never arrows: a sort option's `kind` gives them (`date` "Neueste zuerst", `number` "Höchster zuerst", `text` "A–Z"), or its own `labels` where those do not fit; without either the order reads only "Aufsteigend" and "Absteigend". Another field starts with the first of its declared `directions` (`["desc", "asc"]`: newest or highest first); a field without them keeps the order shown.
- **One choice, one tick at the end.** Where one value is chosen (a preset, yes or no, the sort, a lookup with `multiple: false`), its tick stands at the end of the row, as in a menu and a `Select`. Several values have their box first.
- **On the phone** the bar is one line that scrolls sideways. Every tap opens the filter sheet: every field with its value, sort and group, and "Zurücksetzen" and "9 Aufträge zeigen" at the foot. A step deeper (a field, a bound's calendar) goes back from the sheet's head, "‹ Preis", never from a line of its own.
- **A period of its own.** A `dateRange` or `timeRange` editor lists its presets, then "Von …" and "Bis …" with their values. Each opens a `DatePicker` beside the editor, like a submenu (ArrowRight opens it, Escape closes only it; to the left where the right has no room). A picked day applies at once; a point in time adds hour and minute and applies with "Übernehmen". A day that does not fit ("Von" after "Bis", an hour the clocks skip) says why under the calendar, which stays open. On the phone the calendar is the sheet's next step.
- **A number range** is built like a period: its presets as a list, then "Ab …" and "Bis …", each opening a small number entry beside the editor (on the phone the sheet's next step). The entry reads and shows the locale's numbers ("1.500" is one thousand five hundred in German), shows the unit, has no spinner, and applies with Enter or "Anwenden".
- **Values that load.** A `lookup` field opens `Lookup`: a search that keeps the focus while the arrows move the highlight, waits 200 ms, aborts an older search, shows placeholder rows while it loads, and says "Erneut versuchen" when it fails, in the app's words for what its server answered when the field gives `failure`. Escape first empties the search, then closes. In a form, use `LookupSelect`.

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

The one declaration of fields, search, sorts and groups, shared by the server (`parse`) and the island; labels are the app's final strings, keys and values are stable codes in the address. A field takes `verbs` (the default first; `filterVerbs` lists what each kind allows) and `category`; the declaration may rename its parameters with `params` and may be built at runtime from hundreds of columns.

### FilterBar

The active filters as statements, in `Pane status` above the `StatusRow`; it writes the address and calls `onChange`. Placed in a toolbar, as the `start` or `end` of a v2 `Bar` (a calendar's head), it has no line and no side edge of its own (the bar gives both) and keeps one line that scrolls sideways, so the head never grows as filters come. Build such a head as a `Bar`.

<Props of="FilterBar" />

### ListOrder

The sort and the grouping in words, in `StatusRow filters`.

<Props of="ListOrder" />

### Lookup

Values that load while the person types, the panel the bar opens: one choice (`multiple={false}`) or several, `failure` for the reason a load failed. In a form, `LookupSelect` (see [Forms and input](/en/ui/v2/forms-and-input)).

<Props of="Lookup" />

## Not in v2 yet

Filters inside a column head and a free query builder (and, or, brackets, several statements per field). Until they ship, use the `FilterBar` with its fields and write `// k2b-ui gap: …` at that place.

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
