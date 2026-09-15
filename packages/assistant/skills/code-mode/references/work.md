# Background work and cancellation

Normal control callbacks and startup have a 15-second watchdog. Input reads and
file pickers pause it; agent tool calls still have a bounded outer deadline
([details](debugging.md)). For folder
processing, long computations, and imports, start one background job. Ordinary
controls remain available while it runs; a second job is rejected until it ends.

```js
export default () => {
  const status = ui.text({value:"Choose a folder"});
  ui.button({label:"Start", onClick: async () => {
    const selected = await files.openFolder();
    if (!selected.length) return;
    work.run(async job => {
      for (let index = 0; index < selected.length; index++) {
        await job.checkpoint();
        // Process selected[index]; close documents in finally.
        job.progress(index + 1, selected.length, files.path(selected[index]));
        status.setValue(`Processed ${index + 1} of ${selected.length}`);
      }
      return { processed: selected.length };
    });
  }});
  ui.button({label:"Cancel", onClick: () => work.cancel()});
};
```

Do not await `job.done` in a GUI button: its callback would remain pending for the entire job. For a headless script, use
`const job = work.run(async context => { /* ... */ }); return await job.done;`.
`work.run(callback)` returns `{done: Promise<result>, cancel(): void}`;
`work.cancel()` cancels the active job. Both cancel methods return immediately;
`done` rejects on failure or cancellation. A job's returned value becomes the
run output. Do not return the job handle.

`context.signal` is aborted by cancellation. `await context.checkpoint()` yields
the worker event loop and throws if cancelled. Call it between files/batches
and inside long CPU loops. `context.progress(completed, total?, label?)` reports
bounded progress in inspection. Progress is coalesced; it is not a log per row.
Errors reach the console. Use `try/finally` to release documents. Cancellation
cannot undo completed database writes or Cloud actions; summarize partial work
and use stable import keys to make a deliberate retry safe. Cancellation is
cooperative: an in-flight capability or database request may finish before the
next checkpoint. Use Stop to terminate a blocked run; inspect effects before
retrying.

The worker sends a heartbeat while its event loop responds. A worker that stops
responding for 15 seconds is terminated. This watchdog is not a total job limit.
The user's Stop action and `code_stop` can also terminate a stuck worker.

`code_run` and `code_interact` may return while background work is running.
Check the inspection result’s `work.status` (not a worker-global property): `running`, `completed`, `cancelled`, or `error`. Use
`code_inspect({runId, waitMs: 30000})` to wait for completion and obtain current
progress, output, and errors. It returns after at most 30 seconds; a remaining
`running` status is not success. Modal/approval waits return promptly. Do not
restart the job just because it takes time. CLI `--steps-file` can use the same
inspection step. Keep the execution host open until the job finishes.

Update compact status while processing. Populate result tables in pages or at
batch boundaries; do not rebuild thousands of table rows for every progress
increment. UI updates are coalesced to 100 ms, and each table remains bounded.
