---
title: Troubleshooting
navTitle: Troubleshooting
section: Operations
order: 1180
description: Diagnose common application registration, request, data, and runtime failures.
tags: [troubleshooting, health, diagnostics]
updated: 2026-10-07
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

A process that logs `NATS or JetStream is not ready; retrying` is still
starting and waits for NATS; see
[Restart NATS and applications together](/en/docs/operations/nats-operations#restart-nats-and-applications-together).

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

## Postgres requires pg_textsearch

Core or Notebooks setup, an application that publishes new Help content, Mail,
or a `psql` query fails with
`pg_textsearch must be loaded via shared_preload_libraries` or
`could not access file "$libdir/pg_textsearch"`. The database has optional BM25
indexes, and this Postgres server does not load their library. Native search
cannot take over, because Postgres rejects every statement on those tables.

Load the library again, or remove BM25 while it is loaded; see
[Keep the library loaded while BM25 indexes exist](/en/docs/operations/deployment-requirements#keep-the-library-loaded-while-bm25-indexes-exist).

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

## AI turns end with a provider error

A chat turn, including one that runs scheduled or in the background, repeats a
model call that failed transiently before any output, at most twice. Each
retry logs the warning `AI provider call retried` under `ai:executor`.
Frequent retry warnings point to a rate-limited or unstable model provider. A
turn still fails when:

- the error persisted through both retries;
- the error was permanent, such as an invalid key;
- the call failed after it streamed output;
- the provider asked for a wait over 60 seconds;
- the wait would have ended after the turn's run time limit.

See [Transient provider failures](/en/docs/ai/chat-runtime-and-streaming#transient-provider-failures).

The chat, `cld`, and the turn's stored error show only a worded reason, such
as "The model service did not answer." To find the cause, filter `ai:executor`
for the error `AI turn failed`: it carries the conversation and turn IDs, the
reason `code`, and the provider's own message as `error`. The provider call's
message also stays on its usage record. See
[Failed turns](/en/docs/ai/chat-runtime-and-streaming#failed-turns).

If `cld assistant` stops following a turn that keeps running in Assistant, the
profile still uses an `assistant` CLI plugin from an earlier release. Run
`cld plugins update assistant` for that profile; see
[Conversation streams announce provider retries](/en/docs/reference/deprecations-and-migrations#conversation-streams-announce-provider-retries).

## Scheduled AI tasks need attention

Scheduled runs discover and load app capabilities only within their mandate
policy and task grants. A call rejected by a grant or fixed input returns a tool
error and lets the model continue. Check a task marked `needs_attention` for
unavailable or changed mandate authority, a target app denying the sponsor,
an unknown action outcome, or an operation requiring approval or a browser.
Review the task's grants in the normal chat before changing its scope. See
[Background mandates](/en/docs/identity/background-mandates#grant-capabilities-to-an-unattended-assistant-task).

## AI turns stop using tools before they finish

A turn answers without further tools in the last tenth of its run time limit,
when it repeats a pattern after a hint, or when the model profile's
`maxToolRounds` is used up. Filter `ai:executor` for `AI turn got a loop hint`
and `AI turn answers without further tools`; the `reason` is `run_time`,
`loop`, or `tool_rounds`. Frequent `run_time` reasons point to a run time limit
too short for the work, or to slow tools. Frequent `loop` reasons point to a
model that does not follow the tool hints, or to tools that are missing in
these turns. A turn that fails with `The model did not produce a final answer
without tools.` used a model or provider that still emits tool calls when the
request offers none.

See [Loops within a turn](/en/docs/ai/chat-runtime-and-streaming#loops-within-a-turn).

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
