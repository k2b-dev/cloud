# Complete examples

## Headless calculation

```js
export default () => ({ answer: 42 });
```

## Inspect a supplied CSV and produce a copy

Run with `code_run({ code, inputPaths: ["/sales.csv"] })`:

```js
export default async (_input, { files }) => {
  if (!files.length) throw new Error("Supply a CSV file first.");
  const rows = await cloud.sheet.parseCsv(await files[0].file());
  await cloud.download("export.csv", await cloud.sheet.toCsv(rows));
  return { rows: rows.length, columns: Object.keys(rows[0] ?? {}) };
};
```

## Create a native view

Use `cloud.view.table`, `cloud.view.chart` or `cloud.view.explorer` to write a
validated view file from computed data. Present the returned path in the chat.
See [Views](views.md) for input shapes and examples.
