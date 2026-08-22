# DataTable

`DataTable` renders typed rows and columns. The server owns filtering, sorting, pagination, aggregation, and permission checks; the component owns table presentation and row interaction.

## Use DataTable

Use it for records with consistent fields, comparable values, and column headings.

Use `StructuredDataPreview` for one small metadata object. Wrap the table in
`DataTable.Panel` when it also needs a title, count, search, filters, actions,
or pagination. The standalone `DataPanel` export remains available for panels
whose content is not a table.

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

Each column has a stable `id`, a `header`, and usually a `value` key or function. Numeric values align right by default. `renderCell` and `renderHeader` customize presentation without changing the underlying row model.

Pass `getRowId` when selection or stable row identity matters. Use `selectedRowId` for a selected record, not the row index.

The default cell renderer displays missing values as an em dash, dates with the current locale, and booleans as Yes or No.

## Professional composition

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
are actions. `Controls` and `Footer` accept ordinary child composition, so
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

Do not filter or sort a paginated result in the browser. The client does not own the complete dataset.

## Presentation

Use `density="compact"` for dense operational tables. Headers are sticky unless `stickyHeader={false}`. `footer` accepts values and an optional cell renderer for server-computed totals.

`DataTable` owns its scroll viewport. Its vertical and horizontal scrollbar
thumbs overlay the table on hover-capable fine pointers, so a scrollbar never
reduces the sticky header width. The thumbs appear while the table is hovered,
contains keyboard focus, or is actively scrolling. Wheel and keyboard scrolling
remain native; touch, coarse-pointer, and forced-color environments retain
their native scrollbar treatment. Server-rendered tables also keep native
scrollbars until hydration has installed the overlay behavior.

Use `surface="paper"` for a standalone bordered table and `surface="plain"`
when a surrounding section owns the border. Set it explicitly whenever the
table also has a custom `class`. The class sizes the outer table shell; the
component keeps scrolling on its inner viewport. Bound a scrolling table with
`height`, `max-height`, or a correctly sized `min-h-0 flex-1` region instead of
adding another scroll container.

`hasMore`, `loadingMore`, and `onLoadMore` add an infinite-load sentinel. The owning island still fetches the next server page and appends its rows. The table keeps one request in flight until rows or loading state advance.

## Accessibility

Sortable headers expose `aria-sort`. Interactive rows receive keyboard focus and activate with Enter or Space.

Do not make an entire row interactive when it contains unrelated controls. Give action columns an accessible heading, including a visually hidden one when the design does not show text.

## Runtime

Rows, headers, sort links, selection, empty state, and footer render on the server. Row callbacks, column hover, and infinite loading require hydration.

Prefer normal links for navigation. Use callbacks only when the interaction cannot be represented by a URL.

## Pagination

`Pagination` is the matching URL-owned page control. `PaginationProps`
contains `currentPage`, `totalPages`, `baseUrl`, and optional `onNavigate`.
The component appends each page number to `baseUrl` and renders native previous,
next, and bounded page links. Invalid page values are clamped to the available
range, and the control reacts when the total changes after hydration.

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
