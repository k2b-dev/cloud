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
