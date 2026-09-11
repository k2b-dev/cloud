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

## Interactive list with a modal

```js
export default () => {
  const tasks = ui.list({
    id: "tasks",
    empty: { title: "No tasks yet", description: "Add your first task." },
    actions: [{
      id: "complete", label: "Complete", icon: "ti ti-check",
      onClick(item) { tasks.remove([item.id]); }
    }]
  });
  const add = ui.button("Add task", async () => {
    const title = await ui.modal.text({
      title: "Add task", label: "Task", required: true, maxLength: 200
    });
    if (title === null) return;
    tasks.upsert([{ id: ids.ulid(), title }]);
  }, { id: "add", icon: "ti ti-plus", variant: "primary" });
  ui.column({ gap: "md" }, [add, tasks]);
};
```
