---
title: Scaling and shutdown
navTitle: Scaling and shutdown
section: Operations
order: 1150
description: Run multiple application instances and shut them down without losing work.
tags: [scaling, lifecycle, shutdown]
updated: 2026-10-20
---

# Scaling and shutdown

Cloud can run multiple replicas behind one stable service address.

The orchestrator distributes traffic between replicas. Cloud registers one
logical entry per application ID and routes to that service address.

The nightly [scale acceptance](/en/docs/contributing/testing#scale-acceptance)
runs Core, Mail, Chat, and Notebooks with two replicas each in a disposable
stack. It checks live updates, draft leases, and delivery after one replica is
killed.

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

Every reader uses one logical application entry and one capability manifest per
application ID. Use the same stable `baseUrl` for every replica.

Each process also keeps a small liveness key for its instance. A running
replica renews its keys every 60 seconds. All keys have the same 180-second TTL.

A clean stop removes only its own liveness key. It removes the shared entries
only when no other live instance remains. Stopping one replica keeps the app
registered; the last replica's clean stop removes it at once. A crashed
instance stops renewing its liveness key, which ages out after 180 seconds.
Until then, the crashed instance counts as live. If the last running replica
stops cleanly in that time, the shared entries stay until their own 180-second
TTL ends, and the gateway answers the app's routes with 502 upstream errors.
Shared entries also expire after 180 seconds if no replica renews them.

During a rollout, the most recently started instance's entry wins. Starting
writes the entry; refresh only renews it. Repair writes it only when it is
missing.

The gateway rebuilds its route table when registry entries change. It renews
its own operations snapshot every five seconds, including when the registry is
idle, so its 30-second presence lease and request counters stay current.

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

Sync tracks each accepted worker handler and owns its drain and cancellation.
Call the domain operation directly from the handler; a second task tracker can
reject an already accepted delivery during shutdown and let it be acknowledged
without running.

Use `createRuntimeTaskTracker()` only for work outside Sync handlers, such as
recovery scans and publishers. `stopRuntimeJobs()` stops
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
