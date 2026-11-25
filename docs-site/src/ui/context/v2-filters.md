# Filter, sort and group a v2 list

A list that people filter, sort or group has one way to do it in
`@k2b/ui/v2`: declare the query with `defineListQuery`, show it with
`FilterBar` and `ListOrder`, and load values with `Lookup` where a field has
too many to list. The address holds the whole state, so reload, back and a
shared link show the same list.

The island keeps one signal that mirrors the address: it starts with the
state the server parsed and is set in `onChange`. Do not parse search
parameters yourself, keep filter values the address does not hold, or build a
row of filter chips by hand. The declaration is the one source for the server
and the browser.

## What the person sees

- **Statements.** Each active filter is a readable sentence in the app's
  tint: "Status ist Eingeliefert oder Fotografiert", "und", "Preis ab 500 €".
  More than three values read "A, B oder 2 weitere". Pressing the words opens
  the field's editor in a popover; the small × removes the filter.
- **"+ Filter"** lists the fields, the common ones first, each with its
  current value. A field without a value becomes a dashed statement
  ("Einlieferer ist …") that applies once it has one.
- **"Zurücksetzen"** appears after the last statement while the state differs
  from the current view, and returns to it in one step.
- **"Ansicht ▾"** stands at the end of the bar only when the app passes view
  stores. It saves the state as a new view, updates or renames the current
  saved view, deletes it, and copies a link to this state.
- **Sort and group** stand in words in the status row (`ListOrder` in
  `StatusRow filters`): "⇅ Preis ↓" and "Nach Lagerort", each a menu with one
  choice. A fixed order is quiet text.

From 768 px the statements flow and wrap between whole statements; nothing is
cut, and no container clips a focus ring. Each further line adds 34 px, only
when the person adds a statement. On the phone the bar is one line that
scrolls sideways: "Filter 3", the statements without ×, sort and group. Every
tap opens the filter sheet: every field with its value, "Darstellung" with
sort and group, and "Zurücksetzen" and "9 Artikel zeigen" at the foot.

## Build it

```tsx
import { FilterBar, ListOrder, Pane, StatusRow, Table } from "@k2b/ui/v2";
import { articleQuery } from "./article-query"; // defineListQuery, shared with the server

const [state, setState] = createSignal(props.state); // what the server parsed

<Pane
  label="Artikel"
  status={
    <>
      <FilterBar
        query={articleQuery}
        state={state()}
        onChange={(next) => {
          setState(next);
          reloadRows(next); // the app loads the list on its server
        }}
        icons={{ status: "circle-dashed", price: "currency-euro", consignor: "user" }}
        counts={props.counts} // per value, for fields declared with `counts`
        names={{ consignor: props.consignorNames }} // per field: lookup names the server resolved
        timeZone={props.timeZone} // the person's zone, the same on the server; "UTC" by default
        views={{ stores: props.stores, current: props.view }} // current: { key, label, query, scope? }; leave out: no saving
        results={`${props.total} Artikel`}
      />
      <StatusRow lead={`${props.total} Artikel`} filters={<ListOrder query={articleQuery} state={state()} onChange={setState} />} />
    </>
  }
>
  <Table … />
</Pane>;
```

- `FilterBar` stands in the pane's `status` place above the `StatusRow`.
- The bar writes the address itself and then calls `onChange`. An open
  editor adds one entry to the history, every other change one; back and
  forward call `onChange` with the parsed state.
- The bar never writes what `parse` would drop: a number the field cannot
  read or the address cannot hold shows an error at the field, a value or
  sort that would make the query longer than 2,000 characters is offered
  locked, and the list stays as it is.
- Points in time (`timeRange`) are shown and entered in `timeZone`, "UTC" by
  default. Pass the person's zone from the same setting on the server and in
  the island, so the first picture and the island show the same minutes.
  Around a change of the clocks, a bound that was not changed keeps its
  instant; a typed time that occurs twice means its first occurrence, and a
  typed time that does not exist (the hour skipped in spring) is refused at
  its field.
- Values that would make the address longer than 2,000 characters are
  offered locked, with one hint under the list (linked to them through
  `aria-describedby`): remove a filter or shorten the search.
- A lookup code nobody can name (deleted) is asked for once and stays a code
  with a warning; opening its editor asks again.
- Field and value labels come from the app's catalog through the
  declaration. The grammar ("ist", "oder", "und", "ab", "bis") comes from the
  `@k2b/ui` catalog in the page's locale.

## Values that load

A `lookup` field opens `Lookup`: a search over a list that can choose
several. Typing waits 200 ms, then calls `load(query, { signal, limit })`.
A newer search and closing abort the running one through `signal`. After
150 ms of loading, three placeholder rows show; empty and failed keep the same
height. "Gewählt" stays on top in every state, and a failed load says so with
"Erneut versuchen". The search field and the listbox follow the ui-sdk
listbox: Arrow down moves into the list, Space ticks, Arrow up from the first
entry returns to the search.

`Lookup` also works in a form: pass `value`, `onChange`, `load` and
`resolve`.

## Saved views

The app decides where views live. Pass zero, one or more `ViewStore`s. An
update or a delete that fails says so in a toast with "Erneut versuchen"; a
rename keeps the query the view holds (`views.current.query`).

| Store `scope` | Typical place | Who writes |
| --- | --- | --- |
| `device` | a cookie per list, read by the server | the person |
| `person` | the app's table, one row per person | the person |
| `app` | the same table without a person | whoever may manage the app; the server checks |

With one writable store the save dialog asks no scope. A store with
`writable: false` is named in the dialog but locked, with its reason. Load the
views on the server and pass them to the tabs, so the first picture already
shows them; `viewIcon(scope)` gives a saved view's tab its symbol.

## Accessibility

- The bar is a group named "Filter". Each statement has two buttons: "Filter
  Status ist Eingeliefert oder Fotografiert bearbeiten" and "Filter Status
  entfernen". After removing, the focus moves to the next statement, else to
  "+ Filter".
- An editor takes the focus in its first value; Escape closes it and returns
  the focus to its statement.
- Fixed values are a listbox with `aria-multiselectable`; a lookup's list is
  `aria-busy` while it loads, and its result count is announced.
