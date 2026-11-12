# Template: generate a file and pass it to an app

Create a CSV report, then pass its FileRef to a destination Action. Generation
is a read operation; the destination's Action controls storage, permissions,
confirmation and idempotency. Replace the fictional `imports.import` with an
Action from `code_sdk` that declares a write stream and a `file` input.
Read the `core` SDK declarations for the generation helpers.

Owner: personal Code. The receiving app must allow the Action to run unattended.
The current Files and Mail actions keep their own policies and inputs; this
example does not make them accept files or bypass their confirmation.

<!-- check: personal -->
```ts
import { app, sheet, imports } from "@sdk";

app.schedule({ cron: "0 8 * * 1", timeZone: "Europe/Berlin", name: "weekly-file", title: "Weekly file" }, async c => {
  const file = await sheet.toCsv({
    name: "weekly.csv",
    rows: [{ item: "Example", amount: 12.5 }],
    delimiter: ";",
  });
  await imports.import({ file, idempotencyKey: `weekly-file:${c.scheduledAt ?? c.runId}` });
});
export default app;
```

Use `pdf.render({ name, html })`, `sheet.toOds({ name, sheets })`,
`finance.datev({ name, batch })`, `finance.sepa({ name, batch })` or
`chart.render({ name, chart })` in the same position. Each returns a FileRef,
never bytes. Finance batches use stdlib's exact decimal strings, explicit IDs
and dates; serialization neither submits a payment nor sends the file.

A run can generate at most 64 files, each up to 50 MiB, within a combined
250 MiB budget. In-progress and failed generation also reserve budget.
Each input fits the 256 KiB capability request budget. Temporary output expires
after ten minutes; the FileRef also expires with the run. After an uncertain
write, inspect the destination before repeating it with the same business key.
