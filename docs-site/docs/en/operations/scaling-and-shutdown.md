---
title: Scaling and shutdown
navTitle: Scaling and shutdown
section: Operations
order: 1150
description: Run multiple application instances and shut them down without losing work.
tags: [scaling, lifecycle, shutdown]
updated: 2026-07-27
---

# Scaling and shutdown

Cloud can run multiple replicas behind one stable service address.

The orchestrator distributes traffic between replicas. Cloud registers one
logical entry per application ID and routes to that service address.

## Scale stateless request handling

Application processes may keep caches and clients in memory. Domain state must
remain in shared services such as Postgres, Valkey, or Filegate.

Do not use process memory for:

- sessions;
- durable jobs;
- cross-request locks;
- application records;
- authoritative presence.

Use [Data](/en/docs/data) and
[Automation](/en/docs/automation) for shared state.

## Application registration

The registry does not track individual replicas.

Every replica writes the same application entry. Use the same stable `baseUrl`
for every replica so the entry stays identical.

A running replica refreshes the entry every 60 seconds.

Registry entries expire after 180 seconds if refresh stops. A clean shutdown
removes the entry immediately.

The gateway rebuilds its route table when registry entries change. It renews
its own operations snapshot every five seconds, including when the registry is
idle, so its 30-second presence lease and request counters stay current.

When one of several replicas shuts down cleanly, it can briefly remove the
shared entry. Another replica repairs it on its next refresh. Account for this
window during rolling deployment.

Use the orchestrator, not the Cloud registry, to measure replica health and
count.

During a rolling deployment, old and new instances may both receive traffic.
Keep database changes backward-compatible until the rollout completes.

## Use lifecycle hooks

```ts
await app.start({
  fetch: router.fetch,
  lifecycle: {
    setup: async () => {
      await migrateInventory();
    },
    start: async () => {
      await workers.start();
    },
    stop: async () => {
      await workers.stop();
    },
  },
});
```

`setup` runs before background work. Use it for idempotent migrations.

`start` begins workers and subscriptions.

`stop` releases them. Cloud calls it on `SIGTERM` and `SIGINT`, then stops
notification registration, the runtime watcher, and the registry heartbeat.

## Drain background work

Stop accepting new work before waiting for in-flight work.

`createRuntimeTaskTracker()` tracks accepted promises. `stopRuntimeJobs()` stops
new pulls, then drains workers and tracked tasks concurrently. Both have a
30-second deadline by default; pass `{ timeoutMs }` as the third argument to
match the application's shutdown budget. Starting the worker drain immediately
allows Sync to abort unfinished handlers at that deadline. Cleanup reports an
error when tracked work exceeds the deadline, including work that ignores its
abort signal. `stopRuntimeResources()` attempts every cleanup function and
combines failures.

Background frameworks may also provide leases and retry. Follow their shutdown
contract. See [Lifecycle background work](/en/docs/automation/lifecycle-background-work).

## Set the termination window

The process exits after lifecycle shutdown finishes. Give the container enough
termination time for:

- request draining at the ingress;
- current database transactions;
- worker lease release;
- tracked tasks;
- registry removal.

Make stop hooks idempotent. A startup failure can require cleanup before the
service fully starts.

Test shutdown with real `SIGTERM`, not only a local process kill.
