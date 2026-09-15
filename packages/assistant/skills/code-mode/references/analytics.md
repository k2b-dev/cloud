# Analytics UI

Create an interactive analysis with the built-in UI API:

```js
export default () => {
  const rows = [{ id: "north", region: "North", revenue: 1200 }];
  const explorer = ui.chartExplorer({
    id: "revenue", label: "Revenue by region",
    data: {
      rowKey: "id", rows,
      chart: { kind: "bar", category: "region", value: "revenue" },
      context: {
        mode: "snapshot", asOf: "2026-09-13T12:00:00Z",
        sources: [{ label: "Example fixture" }], status: "fixture",
        note: "Demonstration data, not business results."
      }
    },
    columns: [
      { key: "region", label: "Region" },
      { key: "revenue", label: "Revenue", sortable: true,
        format: { type: "currency", currency: "EUR" } }
    ]
  });
  ui.grid({ children: [explorer] });
};
```

## Controls and handles

The UI uses one options object per control. Common options: `id`, `label`,
`description`, `disabled`, `loading`. IDs must be unique, at most 80 characters.

| Constructor | Required options / callbacks | Handle updates |
| --- | --- | --- |
| `ui.stat` | `label`; optional numeric/null `value` (default null), `format`, `trend: number[]` | `setValue`, `setOptions`, `setLoading` |
| `ui.text` | `value`; optional `markdown: true` | `setValue(text)` |
| `ui.button` | `label`, `onClick`; optional `variant` | `setOptions`, `setLoading`, `setDisabled` |
| `ui.filePicker` | `label`, `onChange(files)`; optional `accept`, `multiple` | `setLoading`, `setDisabled` |
| `ui.input` | `value`; optional `placeholder`, `onChange(string)` | `setValue`, `getValue`, `setOptions`, `setLoading`, `setDisabled` |
| `ui.select` | `value`, `options: [{value,label}]`, optional `onChange(string)` | same |
| `ui.multiSelect` | `value: string[]`, `options`, optional `onChange(string[])` | same |
| `ui.number` | `value: number or null`; optional `min`, `max`, `step`, `onChange` | same |
| `ui.slider` | `value`, `min`, `max`; optional `step`, `onChange(number)` | same |
| `ui.dateRange` | `value: {start,end}`; each ISO date or null; optional `onChange` | same |
| `ui.table` | `rows`, `rowKey`, `columns`; optional `onSelect(row or null)` | `setData`, `setColumns`, `select(key or null)` |
| `ui.chart` | `data: {options, marks?, formats?}`; optional `onSelect(key)` | `setData`, `setOptions`, `select`, `setLoading` |
| `ui.chartExplorer` | `data`, `columns`; optional `onSelect(row or null)`, `onViewChange("chart" or "table")` | `setData`, `setOptions`, `select`, `setLoading` |

Button variants are `primary`, `secondary` (default), `ghost`, `text`, and
`danger`. `number.onChange` receives `number | null`; `dateRange.onChange`
receives `{start: string | null, end: string | null}`. `filePicker.onChange`
always receives `File[]`, even with `multiple: false`; cancelling does not call
it. All handles have an `id`; layout handles expose only that ID.

`setOptions(patch)` updates constructor properties without replacing callbacks
or IDs. For `chartExplorer`, the allowed keys are only `label`, `description`,
`columns`, and `view`; for `chart`, use common options, `selectedKey`, and `cursor?: string`, with
`setData` for chart data. Control/stat/button patches use their respective
constructor properties. `chartExplorer` accepts initial `view: "chart" | "table"`
(default `"chart"`). Tables, charts and Explorers accept `selectedKey: string | null`
(default null); their `select(keyOrNull)` sets or clears selection. A standalone
chart's `setData` clears selection; table/Explorer updates retain valid keys.

Setters never invoke user callbacks. Handles do not have generic
`set`, `upsert`, or `remove`. Replace reviewed row arrays with `setData`.
Date ranges are calendar dates, not timestamps; choose timezone and inclusivity
explicitly when translating a range into a query.

`ui.row`, `ui.column`, and `ui.grid` take `{children: handles[]}`.
Grid additionally accepts `minWidth` in pixels (160–1200; default 320), wrapping
to fit narrow viewports. `ui.section` adds `label` and optional `description`.
Each handle belongs to one layout. UI handles are not serializable entry output.
Use `ui.modal` for trusted dialogs.

## Data, formats, and charts

Rows contain scalar values and require unique nonempty string keys in `rowKey`.
Columns use `{key,label,sortable?,align?,format?}` for both tables and Explorers.
Sorting compares raw values; nulls sort last. Formats apply in the host locale:

- `{type:"number", maximumFractionDigits?}`
- `{type:"currency", currency:"EUR", maximumFractionDigits?}`
- `{type:"percent", input:"fraction" or "percent", maximumFractionDigits?}`
- `{type:"date", timeZone:"Europe/Berlin", style?:"short"|"medium"|"long"}`

Dates require epoch milliseconds. Numeric formats reject strings; convert source
values deliberately. Null displays as an unavailable value rather than zero.

Explorer chart mappings support `bar`, `pie`, `donut` with `category`/`value`,
and `line`, `scatter` with `x`/`y` and optional `series` fields. Each row maps to
one mark. Pie and donut values must be positive. There is no implicit aggregation.
Line X values may be finite numbers or nonempty category labels such as months;
labels keep their first-occurrence order across series. Do not mix these types.
Scatter X and all Y/value fields must be finite numbers. The worker validates
these mappings before returning a ready state, including after filter updates.
Mapped charts reserve axis space for formatted numbers. Long bar labels are
shortened on the axis; keep the full label column in tooltips and tables.

For all 14 kinds use `{options, marks, formats?}`. `options` uses the strict
[Charts](charts.md) schema. Each mark is:
`{role,index,seriesIndex?,key,rowKey,reference?,tooltip?:{title?,rows:[{label,value}]}}`.
`role` is `point`, `item`, `bin`, `box`, `outlier`, `value`, `cell`, or
`interval`; indices are zero-based. The role/index identifies the renderer datum
in the current chart input (see the role table in [Charts](charts.md)). Every
rendered mark needs one mapping; every `rowKey` must exist in the Explorer rows.
Histogram bin indices identify computed bins; boxplot boxes identify groups and
outliers identify observations. Prepare summary rows for these derived entities.
Different current/reference marks may point to one comparison row.

For standalone `ui.chart`, marks are optional; supply them to enable selection
callbacks and controlled selection. Tooltips remain inspectable without them.
`formats` maps raw datum field names (`x`, `y`, `value`, `delta`, etc.) to formats.
Axes accept increasing `domain: [min,max]` for stable comparisons. No arbitrary
SVG, HTML, JSX, or callbacks cross into host rendering.

## Shared exploration

`ui.explorer({id?,label?,snapshot,steps?,series?,comparison?,load})` owns multiple charts.
A snapshot is `{request,charts:{[name]:explorerData}}`. Requests are
`{step?,visibleKeys?,referenceStep?}`; omitted visible keys means all, `[]` means
none. Steps and series controls use `{key,label}` arrays. A reference requires a
current step. The loader must implement aggregation and comparison explicitly.

Mount each chart once with `group.chart(name,{label,columns,...})` and include
the group handle with its chart handles in a layout. The group shows filter,
refresh, and retry controls. Set `comparison: true` only when the loader implements
reference data; it enables comparison controls. Shared row keys link selection, and line
charts share their inspection cursor. Comparison controls do not calculate deltas.

`load(request,{signal})` returns a full `{request,charts}` snapshot. Return every
configured chart and the matching request. New requests cancel obsolete loads;
late results are ignored. Changes commit together, retain valid selections, and
clear unavailable selections. Failed loads retain the previous displayed data.
Callbacks execute in the worker; honor the signal when doing asynchronous work.
Aborting a loader does not undo an already issued HTTP or capability call. The
current HTTP adapter has no per-call signal option; late results are ignored,
while a pending server call retains its normal consent and deadline.

Repeated `setRequest` calls with the same filters do not reload existing data.
`refresh` and `retry` explicitly request a fresh load.

Group handle methods:

- `chart(name, {columns, label?, description?, view?, ...})` mounts a named chart
  once; its handle has only `id`, `select(keyOrNull)`, and `setOptions(patch)`.
  Update its data through the group snapshot.
- `await setRequest(request)` replaces filters, rather than merging them.
- `await refresh()` or `await retry()` reloads the current desired filters.
- `await pinReference()` pins the currently displayed step; it takes no argument.
  `await clearReference()` removes it. Both may call the loader.
- `select(keyOrNull)` sets shared selection; `setData(snapshot)` synchronously
  replaces all chart data and filters, cancelling obsolete loading.
- `cancel()` cancels loading and keeps the displayed snapshot.

Load failures are retained as group error state, rather than thrown from
`setRequest`/`refresh`; inspect the resulting state. Local filtering requires no network call.
An external HTTP load still needs approval. A slider over data steps is not a
substitute for an explicit Apply button when each change has an external effect.

## Inspection, budgets, and delivery

`code_interact` uses `event` for a typed UI event:
`{type:"change",value:...}`, `{type:"select",key:"row-id"}`, or
`{type:"view",value:"table"}`. Group events are
`{type:"request",request:{step:"month"}}` and `{type:"refresh"}`.
Use `code_inspect({runId,nodeId,offset,limit})` for bounded rows and controls.

For a short known sequence, use
`code_interact({runId,steps:[{id:"region",event:{type:"change",value:"north"}},{id:"apply"}]})`.
A batch accepts up to three sequential steps and returns one final snapshot.
It stops at an error, modal, or unfinished background work; check `completedSteps`
and `nextStep` before continuing. Do not mix `steps` with top-level `id`, `event`,
or `answer`. Use separate calls when the next action depends on inspecting data.

Existing budgets still apply: 300 UI nodes, 1,000 rows/data entries per chart,
and the 16 MiB bridge budget. Group data and multiple views also count toward
transport bytes. Aggregate before rendering; the host does not fetch hidden rows.

Use `ui.stat` for KPIs so raw numbers remain inspectable and formatting follows
the host locale. Use null for unavailable ratios. Pass the full raw value to
`setValue`: for a margin, `profit / revenue`, never `Math.round(ratio * 100) / 100`.
A fraction such as 0.449550499 must remain that fraction; its percent format
controls visible digits. Validate the raw `value` from inspection against an
independent calculation, not only a rounded screenshot or formatted string.

Source context contains `mode:"snapshot"|"live"`, ISO `asOf`, `sources: [{label, href?, description?}]` with optional HTTPS links, and optional `status`/`note`. `status` is exactly `complete`, `partial`, or `fixture`; it does not accept
`validated`. Partial or fixture status requires a note. Use a full ISO timestamp
for `asOf` (including time and Z), captured once during data preparation. Never put keys or credential-bearing URLs in
provenance. This context records claims; it does not validate the underlying data.
Read the `assistant-data-analysis` skill for analytical validation and delivery.

## Local shared-filter example

```js
export default () => {
  const source = [
    { id: "north", name: "North", january: 10, february: 12 },
    { id: "south", name: "South", january: 8, february: 9 }
  ];
  const build = request => {
    const rows = source.filter(row => request.visibleKeys === undefined ||
      request.visibleKeys.includes(row.id)).map(row => ({
        id: row.id, name: row.name, value: row[request.step]
      }));
    return { request, charts: { revenue: {
      rowKey: "id", rows,
      chart: { kind: "bar", category: "name", value: "value" }
    } } };
  };
  const group = ui.explorer({
    label: "Example monthly totals",
    snapshot: build({step:"january"}),
    steps: [{key:"january",label:"January"},{key:"february",label:"February"}],
    series: source.map(row => ({key:row.id,label:row.name})),
    load: request => {
      if (request.referenceStep) throw new Error("This example does not implement comparisons.");
      return build(request);
    }
  });
  const chart = group.chart("revenue", {
    label: "Example totals", columns: [
      {key:"name",label:"Region"}, {key:"value",label:"Total",sortable:true}
    ]
  });
  ui.column({children:[group,chart]});
};
```

Comparison controls are disabled by default. The example also rejects an
unsupported reference defensively rather than displaying unchanged values as a comparison. For comparisons, return rows containing both
values and prepare distinct current/reference marks pointing to the same row key.
