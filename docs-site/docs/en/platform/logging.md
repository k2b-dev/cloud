---
title: Structured logging
navTitle: Logging
section: Platform services
order: 520
description: Write structured application logs with safe metadata.
tags: [logging, observability, operations]
updated: 2026-07-26
---

# Structured logging

Logs explain what happened. Add the IDs needed to investigate it.

Cloud writes each event to the process console. It also stores a structured
copy for the operations interface.

## Create a logger

```ts
import { logger } from "@k2b/cloud/services";

const log = logger("inventory:stock");

log.info("Stock adjusted", {
  itemId,
  warehouseId,
  delta,
});
```

A logger exposes `debug`, `info`, `warn`, and `error`. Pass a short message
first. Pass structured metadata second.

Name sources as `app` or `app:area`. A stable source lets operators filter
events without parsing messages:

```ts
const importLog = logger("inventory:import");
const stockLog = logger("inventory:stock");
```

## Choose a level

| Level | Use it when |
| --- | --- |
| `debug` | The detail is useful during diagnosis but noisy during normal operation |
| `info` | A meaningful operation completed or changed state |
| `warn` | Work continued, but an expected dependency or invariant degraded |
| `error` | The operation failed and needs investigation or recovery |

Do not log the same failure at every layer. Log it where you can add useful
context.

## Add safe metadata

Prefer IDs, counts, durations, state names, and bounded error messages:

```ts
try {
  await reserveStock(itemId, quantity);
} catch (error) {
  log.error("Stock reservation failed", {
    itemId,
    quantity,
    error: error instanceof Error ? error.message : "Unknown failure",
  });
  throw error;
}
```

Cloud redacts metadata keys containing terms such as `password`,
`secret`, `token`, `cookie`, `authorization`, `apiKey`, `privateKey`, or
`session`.

Do not log request bodies, credentials, or personal records. Redaction is only
a safety net.

Metadata must be JSON-serializable. Do not pass circular objects, `BigInt`
values, request objects, or full error objects.

## Log delivery

Logging is fire-and-forget:

- the console receives the event immediately;
- the database insert runs asynchronously;
- a persistence failure is reported to the process console;
- the application operation is not failed because log storage is unavailable.

Logs are not a business record. Store important domain events in the domain
database or a durable workflow.

The broader `logging` service exported from `/services` supports Cloud's admin
and operations surfaces. Application code should normally depend only on
`logger()`.

To log failed HTTP requests, add `middleware.logger()`. See
[Request middleware](/en/docs/server/middleware#log-policy-and-server-responses).

Use [Tracing](/en/docs/platform/tracing) when several events belong to one
operation. Use [Audit events](/en/docs/platform/audit-events) when a record must
show who performed a security-relevant action.
