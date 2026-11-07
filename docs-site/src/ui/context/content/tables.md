# DataTable

`DataTable` renders typed rows and columns. The server owns filtering, sorting, pagination, aggregation, and permission checks; the component owns table presentation and row interaction.

## Use DataTable

Use it for records with consistent fields, comparable values, and column headings.

Use `StructuredDataPreview` for one small metadata object. Wrap the table in
`DataTable.Panel` when it also needs a title, count, search, filters, actions,
or pagination. The standalone `DataPanel` export remains available for panels
whose content is not a table.

When a page shows a single dataset, the page heading already names it. Render
the table without a `DataTable.Header` that repeats the page title, give it an
`ariaLabel`, and put the count in the page subtitle or a statistic. Keep row
actions quiet: a ghost button or a row menu, with the danger tone reserved for
the confirmation.

## Import

```tsx
import {
  DataTable,
  type DataTableColumn,
  type DataTableFooter,
  type DataTableProps,
  type DataTableRenderCell,
  type DataTableRenderHeader,
  type DataTableSort,
  Pagination,
  type PaginationProps,
} from "@k2b/ui";
```

## Rows and columns

Each column has a stable `id`, a `header`, and usually a `value` key or function. Numeric values align right by default, with tabular figures, and the default renderer formats numbers and bigints in the inherited locale (`48.210` in German, `48,210` in English; at most three decimals). Identifiers that are numbers, such as ports, years, or Unix IDs, are no quantities: pass them as strings or render them in `renderCell` so they keep their digits unchanged. `renderCell` and `renderHeader` customize presentation without changing the underlying row model.

The default cell wrapper keeps every value on one line and truncates it.
With `cellContentClass`, values can wrap, and a column's `nowrap` decides:
set `nowrap: true` for dates, times, numbers, amounts, or short codes. Body
and footer values then stay on one line and set the column's minimum width;
headers may wrap. Without `nowrap`, the first non-empty value decides:
numbers, including bigint, and `Date` values stay on one line; strings wrap.
`nowrap: false` allows wrapping for numeric or date values too. A
`white-space` set by `cellContentClass` itself wins over `nowrap`.

Pass `getRowId` when selection or stable row identity matters. Use `selectedRowId` for a selected record, not the row index.
Selected rows take the row selection fill without changing text weight or row geometry; see [Colors and selection](/en/ui/surfaces/color).
Keyboard focus draws a ring inside the row, including while it is hovered or
selected. Links and controls inside a cell keep their own focus indicator.

The default cell renderer displays missing values as an em dash, dates with the current locale, and booleans as Yes or No.

Assistant view tables may declare a `ref` column whose cells are Cloud
references or null. The cell shows `title ?? id`; sorting and Copy data use
that visible text. References contain only `{type, id, title?}`, with no URL,
and open after a confirmation through the owning app's reader with the viewer's
access. Original row-index keys let the host recover the reference after sorting.

## Column types

Give a column a `type` when it holds one kind of value. The type decides its
alignment, wrapping, the shown text, search and sort, so a host passes raw
values instead of formatted strings:

| `type` | Shows | Align |
| --- | --- | --- |
| `text` | the string; breaks between words inside its cell | left |
| `number` | the number in the reader's language, by `format` | right |
| `amount` | money in `format.currency` | right |
| `date` | ISO text, a timestamp, or a `Date` in the reader's language and in `timeZone` when given; a day without a time stays that day | left |
| `status` | a status badge with the label and tone from `states[value]` | left |
| `bar` | the value and a short track filled to `max`, or to the column's largest value | right |

`format` is a number format by name: `style` (`number`, `percent`, or
`currency`), `currency`, `decimals`, and `compact`. A missing value, `null` or
an empty string, shows a dash, sorts last in both directions, and never counts
as zero. `renderCell` still wins; its `render` callback draws the typed value.
A column without `type` keeps the plain rendering described above.

## Search, groups, and order in the browser

For a complete set of rows that a reader searches in the browser:

- `filterRows(rows, columns, query, locale)` keeps the rows any of whose shown
  values contains the query, ignoring case and accents. A status matches by its
  label, an amount as it is formatted.
- `sortRows(rows, columns, sort, locale)` orders by one column: numbers by value,
  dates by time, a status by its label, missing values last.
- `createDataTableView({ rows, columns })` holds `query`, `sort`, and `groupBy`
  and returns the matching rows in order.
- `DataTableTools` is the search field and the group choice. Place it in the
  head of the frame that holds the table, never inside the table. Below a frame
  width of 560 px it takes its own line under the title.

Pass `groupBy` with a column id: each group becomes its own `<tbody>` under a
row-group header (`scope="rowgroup"`) with the group's shown value and its
count, in the order the groups first appear. Pass the search text as `query`
and a way back as `onClearQuery`: with no row left, the table says “No row
matches “…”.” and offers **Clear search** at a fixed height instead of `empty`. Clearing removes the button the
reader pressed, so move focus back to the search field in `onClearQuery`.
With `groupBy`, `createDataTableView` returns the rows in the order the groups
show them, so keyboard selection follows the screen. Below a priority's width,
the totals of hidden columns show in a line under the totals row.
A date with a time reads in the reader's zone; pass `timeZone` when the server
renders the table or the data belongs to a zone, so both show the same clock.

```tsx
const view = createDataTableView({ rows: () => campaigns, columns: () => columns });

<DashboardPanel width="full" aria-label="Campaigns">
  <header>
    <h3>Campaigns</h3>
    <DataTableTools
      label="Campaigns"
      query={view.query()}
      onQueryChange={view.setQuery}
      groups={[{ id: "status", label: "Status" }]}
      groupBy={view.groupBy()}
      onGroupByChange={view.setGroupBy}
    />
  </header>
  <DataTable
    surface="plain"
    columns={columns}
    rows={view.rows()}
    sort={view.sort()}
    onSortChange={view.setSort}
    groupBy={view.groupBy() ?? undefined}
    query={view.query()}
    onClearQuery={() => {
      view.setQuery("");
      searchField.focus();
    }}
  />
</DashboardPanel>
```

## Priority on narrow tables

`priority` says how much a narrow table needs a column: `1`, the default,
always shows; `3` hides below a table width of 560 px and `2` below 420 px. The
table measures its own width, not the window's. Once a column is hidden, each
row shows a details button at its end; it opens a line under the row with
exactly the values that are hidden at that width. The button names what it
does, exposes `aria-expanded`, and controls the details line.

## Add a header and controls

The basic `DataTable` stays valid on its own. The compound panel adds only
presentation and accessible structure; it does not own query or pagination
state.

```tsx
<DataTable.Panel>
  <DataTable.Header
    title="Orders"
    subtitle={`${rows.length} of ${total} rows`}
  >
    <Button size="sm" variant="subtle">Settings</Button>
  </DataTable.Header>

  <DataTable.Controls>
    <TextInput
      aria-label="Search orders"
      value={query()}
      onValueChange={setQuery}
    />
    <StatusFilter />
  </DataTable.Controls>

  <DataTable rows={rows} columns={columns} />

  <DataTable.Footer>
    <Pagination currentPage={page} totalPages={pages} baseUrl="?page=" />
  </DataTable.Footer>
</DataTable.Panel>
```

`DataTable.Header` accepts primitive `title` and `subtitle` props. Its children
are actions. They sit beside the title while they fit and wrap onto further
rows below it on narrow panels, such as on a phone, so no action is cut off.
`Controls` and `Footer` accept ordinary child composition, so
search, filters, settings, bulk actions, and pagination remain replaceable.

The header automatically labels the nested table region. For a standalone
table, use `ariaLabel`; use `ariaLabelledBy` when an existing visible heading
already owns the label.

`DataTableRenderCell` receives `row`, `col`, the resolved `value`, and a
`render` callback for the default presentation. `DataTableRenderHeader`
receives the column and its default `render` callback. `DataTableFooter`
provides per-column values and an optional footer-cell renderer.

## Sorting and filtering

Mark a column `sortable: true`, or provide the server's sort key as a string. Pass the current `sort` and build a URL in `sortHref`.

Sorting is link-based so it works on a cold server render and survives reload, sharing, and browser navigation. The same rule applies to filters and pagination: put user intent in the URL, query the server, then pass the returned rows to the table.

For a complete local dataset, pass `onSortChange` instead of `sortHref`: sortable
headers become buttons. The caller sorts the rows and passes the updated `sort`.
If both are supplied, `sortHref` takes precedence. A sort changes only the
header's `aria-sort` and arrow, never the button itself, so keyboard focus stays
on it and pressing it again reverses the order.

Do not filter or sort a paginated result in the browser. The client does not own the complete dataset.

## Presentation

Tables are the one surface that keeps lines, so values can be read across
and down:

- The head is grey (`--k2b-surface-muted`), with small semibold secondary text
  and a stronger line (`--k2b-border-strong`) below it.
- Every body row has a line below it (`--k2b-border`), except the last, which
  ends at the table's frame. Columns are separated by a lighter line (70 % of
  the row line). A totals footer has the head's stronger line above it.
- Rows are 44px (40px compact); numbers align right with tabular figures; no
  zebra striping.
- Hovering a row tints it; hovering a column turns its body cells light grey
  and its head cell one step darker than the grey head.
- A selected row is a fill only: 16 % of the app ink on the surface, never a
  line or bar in the app colour. In forced colors it takes the system highlight.

Every line is an inset shadow inside its cell, so hover and selection never
change a row's size and a sticky head lies on the same pixels as the body.
There is no prop to change the lines, and no app adds row borders or its own
selection fill. Inside a frame the table runs edge to edge; it never adds a
second frame. `data-table-lines.browser.test.ts` pins this presentation.

Pass `loading` for the initial read. With no rows, `loadingRows` renders
row-height placeholders (default 5, clamped to an integer from 1 to 50).
A refresh keeps existing rows until their replacement arrives. The region is
busy while loading and announces “Loading rows” in the inherited locale.
Without rows the table cannot infer that a column is numeric, so set
`align: "right"` on numeric columns of a loading table; otherwise their
headings move to the right when the first rows arrive.

Use `density="compact"` for dense operational tables. Headers are sticky unless `stickyHeader={false}`. `footer` accepts values and an optional cell renderer for server-computed totals.

`DataTable` owns its scroll viewport and keeps sticky headers aligned. Avoid
wrapping it in a second scrolling container.

Use `surface="paper"` for a standalone bordered table and `surface="plain"`
when a surrounding section owns the border. Inside `AppWorkspace.Main` the
table sits on Main's surface with `surface="plain"`; see
[Paper](/en/ui/surfaces/paper). Set it explicitly whenever the
table also has a custom `class`. The class sizes the outer table shell; the
component keeps scrolling on its inner viewport. Bound a scrolling table with
`height`, `max-height`, or a correctly sized `min-h-0 flex-1` region instead of
adding another scroll container.

`hasMore`, `loadingMore`, and `onLoadMore` add an infinite-load sentinel. The owning island still fetches the next server page and appends its rows. The table requests that page when its end comes near the visible area, whether the table scrolls its own viewport or grows with its rows while the page scrolls. While `loadingMore` is true, the table requests nothing more. Otherwise it requests again after rows or loading state advance, or after the end has left the visible area and returned, so a request the owner ignored is not lost. An owner that omits `loadingMore` must ignore a repeated call while its page is still loading.

## API reference

```ts
type DataTableColumn<T> = {
  id: string;
  header: JSX.Element | ((ctx: { col: DataTableColumn<T> }) => JSX.Element);
  subtitle?: JSX.Element | ((ctx: { col: DataTableColumn<T> }) => JSX.Element);
  value?: keyof T | ((row: T) => unknown); class?: string; headerClass?: string; cellClass?: string;
  align?: "left" | "center" | "right"; nowrap?: boolean; sortable?: boolean | string;
  type?: DataTableColumnType; format?: DataTableNumberFormat; states?: Record<string, DataTableStatusState>;
  max?: number; timeZone?: string; priority?: 1 | 2 | 3;
};

type DataTableColumnType = "text" | "number" | "date" | "status" | "bar" | "amount";
type DataTableNumberFormat = { style?: "number" | "percent" | "currency"; currency?: string; decimals?: number; compact?: boolean };
type DataTableStatusState = { label: string; tone: StatusTone };

type DataTableSort = { key: string; direction: "asc" | "desc" };

type DataTableRenderCell<T> = (ctx: {
  row: T; col: DataTableColumn<T>; value: unknown; render: (value: unknown) => JSX.Element;
}) => JSX.Element;

type DataTableRenderHeader<T> = (ctx: { col: DataTableColumn<T>; render: () => JSX.Element }) => JSX.Element;

type DataTableFooter<T> = {
  values?: Record<string, unknown>;
  renderCell?: (ctx: { col: DataTableColumn<T>; value: unknown; render: (value: unknown) => JSX.Element }) => JSX.Element;
};

type DataTableProps<T> = {
  rows: readonly T[]; columns: readonly DataTableColumn<T>[]; ariaLabel?: string; ariaLabelledBy?: string;
  getRowId?: (row: T) => string; sort?: DataTableSort | null; sortHref?: (next: DataTableSort) => string;
  onSortChange?: (next: DataTableSort) => void;
  selectedRowId?: string | null; rowClass?: string | ((row: T) => string | undefined); hoverRows?: boolean;
  onRowClick?: (row: T) => void; onRowDoubleClick?: (row: T) => void; renderCell?: DataTableRenderCell<T>;
  renderHeader?: DataTableRenderHeader<T>; footer?: DataTableFooter<T>; hasMore?: boolean;
  loading?: boolean; loadingRows?: number;
  loadingMore?: boolean; onLoadMore?: () => void; empty?: JSX.Element; density?: "compact" | "normal";
  stickyHeader?: boolean; highlightColumns?: boolean; verticalAlign?: "top" | "middle" | "bottom";
  cellContentClass?: string; fillHeight?: boolean; surface?: "paper" | "plain"; class?: string;
  tableClass?: string; scrollClass?: string; scrollPreserveKey?: string | false;
  groupBy?: string; query?: string; onClearQuery?: () => void;
};

type DataTablePanelProps = {
  children: JSX.Element; class?: string;
};

type DataTableHeaderProps = {
  title: string; subtitle?: string; children?: JSX.Element; as?: "h1" | "h2" | "h3"; size?: "sm" | "md";
  class?: string;
};

type DataTableControlsProps = {
  children: JSX.Element; class?: string;
};

type DataTablePanelFooterProps = {
  children: JSX.Element; class?: string;
};
```

The four panel types correspond to `DataTable.Panel`, `.Header`, `.Controls`, and `.Footer`. All row callbacks receive the original row. Footer values are keyed by **column id**. `getRowId` returns a stable string. `onLoadMore` returns `void`; expose request state through `loadingMore` and append rows after success.

Defaults: `density="normal"`, `stickyHeader=true`, `verticalAlign="middle"`. Use `onRowClick`/`onRowDoubleClick` only for real row actions; selection remains controlled through `selectedRowId`. `scrollPreserveKey={false}` disables restoration for the table. `fillHeight` makes the table fill a bounded parent's height. `hoverRows` defaults to whether a row callback exists; `highlightColumns` defaults on when row hover is enabled. Omitted `surface` is paper without a custom class and plain with one, so set it explicitly when styling. `rowClass` styles rows, `tableClass` the table, `scrollClass` the scroll container, and `class` its outer shell. Pass `scrollClass="k2b-detail-trail"` to keep column widths beside a [workspace detail](/en/ui/layout/workspace#detail-and-panel). The scroller narrows and scrolls the table at its width without the panel; closing returns the full width without extra space. Under an open waiting drawer the scroller gets the drawer's width as space at its end instead.

## Accessibility

Sortable headers expose `aria-sort`. Interactive rows receive keyboard focus and activate with Enter or Space.

Do not make an entire row interactive when it contains unrelated controls. Give action columns an accessible heading, including a visually hidden one when the design does not show text.

## Runtime

Rows, headers, sort links, selection, empty state, and footer render on the server. Row callbacks, column hover, and infinite loading require browser code.

Prefer normal links for navigation. Use callbacks only when the interaction cannot be represented by a URL.

## Pagination

`Pagination` is the matching URL-owned page control. `PaginationProps`
contains `currentPage`, `totalPages`, `baseUrl`, and optional `onNavigate`.
The component appends each page number to `baseUrl` and renders native previous,
next, and bounded page links. Invalid page values are clamped to the available
range, and the control reacts when the total changes after mount.

```tsx
<Pagination
  currentPage={4}
  totalPages={12}
  baseUrl="?page="
/>
```

## Example

```tsx
type RouteRow = {
  id: string;
  path: string;
  requests: number;
};

const columns: DataTableColumn<RouteRow>[] = [
  { id: "path", header: "Route", value: "path", sortable: true },
  {
    id: "requests",
    header: "Requests",
    value: "requests",
    sortable: "requestCount",
  },
];

<DataTable
  rows={rows}
  columns={columns}
  getRowId={(row) => row.id}
  sort={{ key: "requestCount", direction: "desc" }}
  sortHref={(next) =>
    `/admin/routes?sort=${next.key}&direction=${next.direction}`
  }
/>
```

For multi-selection, supply `selection={createCollectionSelection({ ids })}`
and `getRowId`. The controller may also be shared with `FileGrid` to retain the
same selection between presentations. Rows expose `aria-selected` and roving
keyboard focus. Shift selects a range, Ctrl/Cmd toggles individual rows, Space
toggles the focused row, and Ctrl/Cmd-A selects the supplied IDs. Enter invokes
`onRowDoubleClick` in this mode. Existing single-row callbacks remain unchanged
when `selection` is omitted. `onRowContextMenu` lets the host align selection with
its context menu. See [File browser](/en/ui/content/files) for the shared model.
