---
title: Troubleshooting
navTitle: Troubleshooting
section: Operations
order: 1180
description: Diagnose common application registration, request, data, and runtime failures.
tags: [troubleshooting, health, diagnostics]
updated: 2026-07-27
---

# Troubleshooting

Diagnose from the outside in.

Start at the gateway, then check registration, the application process,
dependencies, and finally the failing route or worker.

## Run the first checks

```bash
cld admin status
cld admin apps list
cld admin diagnose
```

In the monorepo, also run:

```bash
bun run dev:status
bun run dev:logs <app>
```

`dev:status` distinguishes a ready application from a container that is still
starting or has become unhealthy. `dev:start` and `dev:rebuild` wait for the
same direct readiness check and print the latest relevant startup error when it
fails.

Keep timestamps, application IDs, request IDs, and trace IDs from the failing
request.

## Application is missing

Check:

1. the process is running;
2. `APP_SECRET`, Postgres, Valkey and NATS JetStream are configured and available;
3. startup completed without a migration or lifecycle error;
4. the application logged a successful registration;
5. all containers use the same Compose network;
6. the registry contains the application ID.

A clean shutdown removes the registry entry. A crashed instance can remain
visible for up to the registry expiry window.

## Route returns the wrong service or 404

Inspect gateway route warnings.

Route prefixes must start with `/`. Two applications cannot own the same exact
prefix. The gateway uses the longest matching prefix.

Confirm that:

- `defineApp({ routes })` declares the public prefix;
- the application router mounts the same path;
- the typed client uses the same API base URL;
- the gateway rebuilt its route table after registration.

See [Routing](/en/docs/build/routing).

## Application cannot read settings

Check that every container uses the same `APP_SECRET`.

Then check the setting definition, stored value, environment fallback, and
validation error. A changed secret can make existing encrypted values
unreadable.

See [Runtime configuration](/en/docs/operations/runtime-configuration).

## Postgres or Valkey is unavailable

Resolve the service name from inside the application container.

Confirm `DATABASE_URL` and `REDIS_URL`, network membership, credentials, and
service health.

Valkey defaults to localhost when `REDIS_URL` is absent. That is normally wrong
inside a container.

## Authentication works but access is denied

Inspect the resolved actor and access subject. Then inspect the resource grant
and requested permission.

Do not debug authorization from display-only user group fields.

See [Authorization](/en/docs/identity/authorization).

## Background work does not progress

Check whether the worker started, whether work is queued, whether a lease is
active, and whether the latest trace is failed or stuck.

Confirm that the process calls the matching lifecycle start method.

See [Lifecycle background work](/en/docs/automation/lifecycle-background-work).

## Shutdown hangs

Find the stop hook that still accepts work or waits on an unbounded task.

Close intake first. Stop readers and schedulers. Drain tracked work. Apply
timeouts to external calls.

See [Scaling and shutdown](/en/docs/operations/scaling-and-shutdown).

## Record the result

When escalating, include:

- deployment and image version;
- application ID and instance count;
- exact route or background source;
- UTC timestamp;
- request or trace ID;
- relevant structured logs;
- the smallest reproducible action.

Remove secrets and personal data.
