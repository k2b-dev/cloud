# Complete examples

## Headless calculation

```js
export default () => ({ answer: 42 });
```

## Inspect a supplied CSV and produce a copy

```js
export default async () => {
  const inputs = await files.list();
  if (!inputs.length) throw new Error("Supply a CSV file first.");
  const rows = await sheet.fromCsv(await files.read(inputs[0].name));
  await files.save(sheet.toCsv(rows), "export.csv");
  return { rows: rows.length, columns: Object.keys(rows[0] ?? {}) };
};
```

## Interactive table with a modal

```js
export default () => {
  let rows = [];
  let selected = null;
  const tasks = ui.table({
    id:"tasks", rows, rowKey:"id", columns:[{key:"title",label:"Task"}],
    onSelect(row) { selected = row?.id ?? null; }
  });
  const add = ui.button({label:"Add task", id:"add", variant:"primary", async onClick() {
    const title = await ui.modal.text({title:"Add task", label:"Task", required:true, maxLength:200});
    if (title === null) return;
    rows = [...rows, {id:ids.ulid(), title}];
    tasks.setData(rows);
  }});
  const complete = ui.button({label:"Complete selected", onClick() {
    rows = rows.filter(row => row.id !== selected);
    selected = null;
    tasks.setData(rows);
  }});
  ui.column({children:[add, tasks, complete]});
};
```

## CSV dashboard with a KPI, date range, region filter, Explorer and reset

Save `sales.csv` and `main.ts` in one `code_write` batch. These three rows are
**fixture data**, not a business result. For real data, copy the validated chat
file with `fromFile`, inspect its schema, and record the actual snapshot time.
The date range below includes months by their first day, inclusively.

`sales.csv`:

```csv
month,region,revenue
2026-01,North,100
2026-01,South,200
2026-02,North,300
```

`main.ts`:

```js
import csv from "./sales.csv";
export default async () => {
  const rows = (await sheet.fromCsv(csv)).map(row => ({
    month: String(row.month), region: String(row.region), revenue: Number(row.revenue)
  }));
  if (rows.some(row => !/^\d{4}-\d{2}$/.test(row.month) || !Number.isFinite(row.revenue)))
    throw new Error("Expected month, region, and numeric revenue columns.");
  const initial = { start: "2026-01-01", end: "2026-02-28" };
  const currency = { type: "currency", currency: "EUR", maximumFractionDigits: 2 };
  const regions = ui.multiSelect({ id: "regions", label: "Regions", value: [],
    options: [...new Set(rows.map(row => row.region))].map(value => ({value,label:value})),
    onChange: () => update() });
  const dates = ui.dateRange({ id: "dates", label: "Months", value: initial, onChange: () => update() });
  const revenue = ui.stat({ id: "revenue", label: "Revenue", value: 0, format: currency });
  const chart = ui.chartExplorer({ id: "monthly", label: "Monthly revenue",
    data: {rowKey:"id",rows:[],chart:{kind:"bar",category:"id",value:"revenue"}},
    columns: [{key:"id",label:"Month"},{key:"revenue",label:"Revenue",format:currency}] });
  function update() {
    const selected = regions.getValue(), range = dates.getValue();
    const visible = rows.filter(row => (!selected.length || selected.includes(row.region)) &&
      (!range.start || row.month + "-01" >= range.start) && (!range.end || row.month + "-01" <= range.end));
    const totals = new Map();
    for (const row of visible) totals.set(row.month, (totals.get(row.month) ?? 0) + row.revenue);
    revenue.setValue(visible.reduce((sum,row) => sum + row.revenue,0));
    chart.setData({rowKey:"id",rows:[...totals].sort().map(([id,revenue])=>({id,revenue})),
      chart:{kind:"bar",category:"id",value:"revenue"},
      context:{mode:"snapshot",asOf:"2026-01-01T00:00:00Z",status:"fixture",
        note:"Three illustrative rows; replace with validated source data.",sources:[{label:"sales.csv fixture"}]}});
  }
  const reset = ui.button({id:"reset",label:"Reset",onClick:()=>{
    regions.setValue([]);dates.setValue(initial);update();
  }});
  ui.column({children:[ui.row({children:[regions,dates,reset]}),revenue,chart]});
  update();
};
```

Run the saved resource. Initial revenue is 600. Test
`code_interact({runId,steps:[{id:"regions",event:{type:"change",value:["North"]}},{id:"dates",event:{type:"change",value:{start:"2026-02-01",end:"2026-02-28"}}}]})`:
revenue must be 300. Then `{runId,id:"reset"}` restores 600. Finally switch
`{runId,id:"monthly",event:{type:"view",value:"table"}}` and inspect both months.
The `runId` always identifies the saved revision being tested.

## Reusable procedures beyond a GUI

- **Stateless converter:** publish a `convert` action taking explicit CSV text,
  save a JSON output with `files.save`, then let the agent export it. No database
  is needed. A one-time conversion remains a chat-scoped script.
- **Agent-only importer:** publish an `importItems` action with stable business
  keys. Initialize schema with Manage before sharing; Use-level callers reuse
  the same App data across chats. Unique keys prevent silent duplicate records.
- **Display-only dashboard:** the GUI reads results; separate published actions
  maintain them. Do not add configuration controls just to let the agent work.
- **Invoice matcher:** inspect a spreadsheet and selected invoice pages, ask for
  ambiguous matches, copy exactly the chosen file through [File transfers](files.md),
  then call a published linking action. A linked Skill can describe this workflow;
  its access remains separate from the App's.

Read [App actions](app-actions.md) for the complete publication/call contract.
The canonical Assistant documentation links runnable source bundles for these
four flows. Do not infer additional database methods from these use cases.
