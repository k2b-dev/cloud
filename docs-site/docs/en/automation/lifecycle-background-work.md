---
title: Lifecycle background work
navTitle: Lifecycle work
section: Automation
order: 610
description: Start and stop simple background work with the application process.
tags: [lifecycle, background, shutdown]
updated: 2026-11-16
---

# Lifecycle background work

Use `lifecycle.start` and `lifecycle.stop` for work that belongs to one
application process.

Examples include a local polling loop, a topic reader, or a scheduler instance.
Use a durable job or queue when the work itself must survive a process restart.

If that durable work calls another Cloud application after the originating
session may have expired, persist a revocable
[background mandate](/en/docs/identity/background-mandates). Never persist the
session cookie or a personal API key with the job.

Read [Application lifecycle](/en/docs/build/lifecycle) for hook order, setup,
failed-start cleanup, lifecycle context, and shutdown order. This page only
covers the background-work pattern.

## Start and stop the runtime

```ts
import { startRuntimeInterval } from "@k2b/cloud/services";

let refresh: ReturnType<typeof startRuntimeInterval> | undefined;

await app.start({
  fetch: router.fetch,
  lifecycle: {
    start: async (ctx) => {
      refresh = startRuntimeInterval({
        run: (signal) => refreshInventory(signal),
        intervalMs: 30_000,
        onError: (error) => ctx.logger("inventory").error("Refresh failed", { error }),
      });
    },
    stop: async () => {
      await refresh?.stop();
      refresh = undefined;
    },
  },
});
```

Return from `start` after creating the runtime. In `stop`, prevent new work and
await the current operation. `startRuntimeInterval()` runs once at start
(`runNow: false` skips that), then every `intervalMs`. `stop()` clears the
timer, aborts `signal`, and waits for the run in flight. A run that fails
goes to `onError`, also while `stop()` waits for it; only a run that ends
with the abort of `stop()` is not reported.

## Prevent overlapping work

`startRuntimeInterval()` runs one pass at a time: a tick that arrives while the
previous pass still runs is skipped.

This guard protects only one process. Use a
[mutex](/en/docs/automation/coordination-primitives#use-a-distributed-mutex) or
[scheduler](/en/docs/automation/schedulers) when several app instances must
coordinate.

## Pause for maintenance

An operator can put the whole Cloud into maintenance stage „Ruhe“
(`cld admin maintenance on --quiesce`, see
[Maintenance mode](/en/docs/operations/maintenance-mode#quiet-background-work-stage-ruhe)).
Then every app process stops taking new background work and lets the work in
flight finish, without exiting. Requests are still answered; a request that
waits for a worker waits until resume. You get this without any code of your
own when the work runs through the platform:

| You use | While quiet | On resume |
| --- | --- | --- |
| `process()` of a job, queue, topic, scheduler or pump declared with `lazySync()` or `app.sync` | The worker stops pulling and drains (30 s, then handler signals abort). Messages wait in NATS. A handler that ignores its signal still counts as running. | A new worker starts with the same arguments once the old handlers ended. Your handle stays valid. |
| `createRuntimeTaskTracker()` | `run()` returns `null`, as when closed; accepted tasks drain. | `run()` accepts tasks again. |
| `createRuntimeLifecycle()` | A started runtime is stopped. `start()` only marks it to start later. | The runtime starts again. |
| `startRuntimeInterval()` | Ticks are skipped; the pass in flight finishes. | Missed ticks run once. |

Workers drain first, all at once. Then runtime lifecycles stop one at a time,
the last one started first. On resume, runtimes start in their original order
before workers take work again. A runtime that another runtime starts inside
its own `start` therefore stops before it and starts after it. Start runtimes
that depend on each other in that order.

A worker or runtime that fails to start again is retried five times within
about a minute; then the process restarts. A worker created inside
`superviseRuntimeTask()` retries without a limit, as the supervisor does.

Request-side resources do not belong in a runtime lifecycle: quiesce would
stop them while requests still use them. Close a connection pool that
requests use only in your `lifecycle.stop` hook, outside the runtime.

Submissions and publications continue while quiet. A job or queue whose
stream reaches its retention limit rejects further submissions with
`StoreFullError`, so size `retention` for the longest pause you expect.

A scheduler's missed ticks also run once, because schedules default to
`misfire: "latest"`. With `misfire: "all"` every missed tick runs.

Your `lifecycle.start` and `lifecycle.stop` hooks are not called for
maintenance; they still run only at process start and shutdown. Do not keep
background state that only `start` can rebuild.

For a loop that none of these fit, such as a long-lived connection to an
external service, follow the platform signal:

```ts
import { backgroundWork } from "@k2b/cloud/services";

const off = backgroundWork.onChange((paused) => {
  if (paused) void connection.close();
  else connection.open();
});
if (!backgroundWork.paused()) connection.open();
```

`backgroundWork.paused()` is true while the Cloud is quiet. Stop before you
start new work, not in the middle of an operation. The repository check
`background-work` flags, in built-in app server code (`.ts`), a raw
`setInterval()`, a function that schedules itself again with `setTimeout()`,
and `superviseRuntimeTask()`. One that must keep running while quiet, such as
the lease heartbeat of work in flight or a registry watcher, carries
`// runtime-timer: <reason>` on the line above.

## Handle shutdown

Keep handles for timers, readers, workers, and abort controllers. Close all of
them in `stop`.

The platform waits for the stop callback, but deployment shutdown still has a
deadline. Bound external requests and do not start unbounded cleanup.

See [Application lifecycle](/en/docs/build/lifecycle#stop-in-reverse-order) for
hook cleanup and [Scaling and shutdown](/en/docs/operations/scaling-and-shutdown)
for the container deadline.
