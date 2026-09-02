---
title: Lifecycle background work
navTitle: Lifecycle work
section: Automation
order: 610
description: Start and stop simple background work with the application process.
tags: [lifecycle, background, shutdown]
updated: 2026-09-02
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
let timer: ReturnType<typeof setInterval> | null = null;
let running: Promise<void> | null = null;

await app.start({
  fetch: router.fetch,
  lifecycle: {
    start: async () => {
      timer = setInterval(() => {
        if (running) return;
        running = refreshInventory()
          .catch((error) => log.error("Refresh failed", { error }))
          .finally(() => {
            running = null;
          });
      }, 30_000);
    },
    stop: async () => {
      if (timer) clearInterval(timer);
      timer = null;
      await running;
    },
  },
});
```

Return from `start` after creating the runtime. In `stop`, prevent new work and
await the current operation.

## Prevent overlapping work

An interval can fire before its previous callback finishes. Keep an in-process
guard when overlap would be wrong.

This guard protects only one process. Use a
[mutex](/en/docs/automation/coordination-primitives#use-a-distributed-mutex) or
[scheduler](/en/docs/automation/schedulers) when several app instances must
coordinate.

## Handle shutdown

Keep handles for timers, readers, workers, and abort controllers. Close all of
them in `stop`.

The platform waits for the stop callback, but deployment shutdown still has a
deadline. Bound external requests and do not start unbounded cleanup.

See [Application lifecycle](/en/docs/build/lifecycle#stop-in-reverse-order) for
hook cleanup and [Scaling and shutdown](/en/docs/operations/scaling-and-shutdown)
for the container deadline.
