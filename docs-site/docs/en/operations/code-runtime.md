---
title: Operate Code requests
navTitle: Code requests
section: Operations
order: 920
description: Size and diagnose Code route requests in the shared runner pool.
tags: [code, runner, limits]
updated: 2026-11-06
---

# Operate Code requests

Code routes run through Core and the shared runner pool. They have an
eight-second deadline including queueing, capped further by
`core.code.wall_clock_ms`. Existing `core.code.runner_slots`,
`core.code.concurrency_per_code`, `core.code.concurrency_per_owner` and
per-run capability call limits apply. Admission refuses excess work with 503;
there is no unbounded HTTP queue and no automatic request replay after failure.

The HTTP contract limits bodies to 8 KiB, public bodies to 4 KiB and responses
to 128 KiB. Public routes share 20 requests per minute per client network and
per Code across Core replicas, enforced through Valkey. A 429 response carries
`Retry-After`. Unsupported body content types return 415; oversized bodies
return 413, including streamed requests.

Use the Code page's route entrypoints and Runs to inspect outcomes, queue and
execution timestamps, and capability refusals. Request input and output are
cleared when the waiting request ends. Capability calls retain the existing
Code audit and retention contract. A client disconnect cancels admission or
fences the current lease; it does not roll back committed domain effects.
Do not blindly retry a failed POST: read the domain state first and use the
capability's idempotency contract when repeating an intended effect.

Core declares `/code` in the gateway registry and checks each path against the
active version's manifest. Sign-in is required unless that exact matched route
was reviewed as public. Public responses contain only the data that Code
returns. Keep the shared runner, NATS, Postgres and Valkey healthy; request
capacity competes with scheduled runs and authoring checks.
