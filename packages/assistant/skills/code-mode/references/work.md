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

## Scheduled Assistant tasks

Scheduled tasks can use Code Mode without an open user tab. Each turn owns a
separate server execution host; it does not borrow the foreground chat's run.
Load the scheduled-tasks Skill when creating or changing the task.

Use existing chat input paths, compute, call `ai`, use task-approved capabilities,
and export results to the chat. The host applies the task's confirmed grants and
fixed inputs automatically to capability calls. Do not call an authorization API
or supply a mandate ID in code. Personal remembered approvals do not apply.

There is no user to answer a modal, enter secrets or open a local file picker.
HTTP and RSQL are available through the normal APIs with task grants. In the
same grants list use `{kind:"http",fixedInput:{origin:"https://api.example.com",method:"GET"}}`
or `{kind:"database",fixedInput:{resourceId:"aBc234"}}`. HTTP can also fix an exact
`url`; database grants can fix `operation` and `table`. A resource-only database
grant covers connecting and subsequent reads/writes; an operation-specific grant
needs a separate `connect` grant. Empty fixedInput explicitly allows all supported
targets and operations within the user's current access. The task cannot expand
its own grants. Existing HTTP secrets remain server-side; new secret entry needs
the normal chat. Shared app storage retains its usual resource checks.
Capability binary streams remain unavailable. If an operation is outside the task grant,
explain what is missing in the result; ask the user to adjust the task in its
normal chat. Do not bypass a denied capability through another transport.

AI helpers use background accounting. Revocation, task grant changes and turn
cancellation stop further host requests. Already completed effects are not
rolled back, and host loss never replays an uncertain write automatically.

Database maintenance tools `code_database_clear` and `code_database_reset` use the same task grants (`operation: "clear"` or `"reset"`). They still require Manage access and the current generation/data revision; preapprove these destructive operations only when the user explicitly requests them.
