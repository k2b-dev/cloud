---
title: App events
section: Platform services
order: 557
description: Declare versioned application facts and consume service events with retryable handlers.
tags: [events, capabilities, subscriptions, automation]
updated: 2026-10-27
---

# App events

Declare an app event when another application needs to react to a fact that
has already happened. The publisher owns its event schema; each subscriber
owns its handler and effects. Use a [Query or Action](/en/docs/platform/capabilities)
when a caller needs an immediate answer or asks another application to do work.

Cloud currently delivers **service events**, whose declarations have no `place`. Resource
event subscriptions are refused with
`resource_events_unsupported`; declaring a resource event does not enable its
delivery. `automation` metadata does not grant authority or install a Routine.

Deployed applications are trusted parts of the installation and share the
platform database and NATS credentials. Deploying an application is approval
for its declared subscriptions. Core accepts an event only when its source
application declared that event type and version.

## Declare events and subscriptions

Add `events` and `subscribes` to the same `defineCapabilities()` declaration
that owns the application's Types. Event keys are local IDs; subscription keys
are the publisher's full event type.

```ts
import { defineCapabilities } from "@k2b/cloud";
import { z } from "zod";

const userCreated = z.object({
  userId: z.uuid(),
  provider: z.enum(["local", "ipa"]),
}).strict();

export const publisherCapabilities = defineCapabilities({
  protocolVersion: 2,
  types: {
    user: {
      title: "User",
      description: "An account in this Cloud installation.",
    },
  },
  events: {
    "user.created": {
      version: 1,
      title: "User created",
      description: "A new account was created.",
      subject: "user",
      schema: userCreated,
    },
  },
});

export const subscriberCapabilities = defineCapabilities({
  protocolVersion: 2,
  subscribes: {
    "core.user.created": {
      version: 1,
      schema: userCreated,
      async run(envelope, context) {
        console.info("User event received", {
          eventId: context.eventId,
          userId: envelope.data.userId,
        });
      },
    },
  },
});
```

The publisher example belongs to an app registered as `core`; its local
`user.created` becomes `core.user.created`. The real `core.user.created` data
contains only `userId` (UUID) and `provider` (`local` or `ipa`). Read current
domain state through the owning service when a handler needs more information.

An event declaration has:

| Field | Contract |
| --- | --- |
| `version` | Positive integer describing the data contract |
| `title`, `description` | Human-readable meaning of the fact |
| `subject` | Local Type key identifying what the event concerns |
| `place` | Optional local Type key with a declared reader |
| `schema` | Zod schema for the event's data |
| `automation` | Optional `false` to exclude the event from automation discovery; the catalog defaults to `true` |

Producer data schemas must have a closed object root and closed nested objects
(for example, `z.strictObject`). Strings need `maxLength` through `.max(n)`;
UUID strings have an implicit 36-character bound. Arrays need `maxItems`
through `.max(n)`. Finite enums and literals are supported; schema references,
recursive schemas and open records are rejected. Schemas must preserve their
JSON shape. The complete envelope
must fit in **4096 bytes**, measured as PostgreSQL `jsonb::text`, including
separator spaces. Startup rejects unbounded declarations and required minimum
data that cannot fit with a UUID-reference envelope. A schema may still allow
individual values that exceed the remaining envelope budget; publishing checks
the exact complete envelope inside the transaction and rejects those values.
Store large content in the owning application's durable
storage and publish only the small fact needed to react.

A subscription declares the exact `version`, its Zod `schema`, and
`run(envelope, context)`. The framework parses data with that subscriber's
schema before invoking the handler; `envelope.data` is inferred as
`z.output<typeof schema>`. Its stable identity is
`<subscriber-app>:<full-event-type>@<version>`, for example
`filesv2:core.user.created@1`. Inspect the current catalog and subscription
status rather than assuming that a declaration is deliverable.

`cld capabilities catalog --json` and `--jsonl` include event and subscription
manifests unchanged. Each app also has an `events` catalog with full event,
subject and place type IDs, version, title, description, automation flag, data
JSON Schema and matching subscribers. Subscriber states and `firstSeenAt` come
from Core's persisted subscription records. Subscriber discovery uses the same app
access filter, including subscribers outside the current publisher page. Use
`cld events ls` for the administrative event catalog.
Event-specific MCP discovery is not yet available; the capability MCP currently
projects tools and resources.

## Read the envelope

Every delivery carries this shape:

```json
{
  "id": "11111111-1111-4111-8111-111111111111",
  "type": "core.user.created",
  "version": 1,
  "source": "core",
  "time": "2026-01-01T00:00:00.000Z",
  "subject": { "type": "core.user", "id": "22222222-2222-4222-8222-222222222222" },
  "cause": { "requestId": "fixture-request" },
  "data": { "userId": "22222222-2222-4222-8222-222222222222", "provider": "local" }
}
```

`id` is a UUID, `time` is an ISO timestamp, and `source` is the publishing app
ID. `subject.type` and optional `place.type` are full Type IDs. `place` has
`{ type, id }`; `cause`, when present, has only `requestId`. A request ID is
correlation metadata, not a user's authority.

## Publish in the domain transaction

Create the publisher with `appEvents(capabilities)` from
`@k2b/cloud/events`, using the exact declaration object passed to
`defineApp({ capabilities })`. Cloud binds that object to the registered app
ID. Calling `publish` before binding fails.

`publish(tx, localId, input)` accepts the application's transaction, a local
event key, and `{ subject, data, requestId? }`, where `subject` is the subject
ID. For an event with a place, also pass its ID as `place`. Cloud derives both
Type IDs, the event type and version, and the source app from the declaration;
`requestId` becomes `cause.requestId` in the envelope.

```ts
import { sql } from "bun";
import { appEvents } from "@k2b/cloud/events";
import { publisherCapabilities } from "./capabilities";

const events = appEvents(publisherCapabilities);

export async function recordCreatedUser(userId: string, provider: "local" | "ipa") {
  await sql.begin(async (tx) => {
    // Perform the domain write in this same transaction.
    await events.publish(tx, "user.created", {
      subject: userId,
      data: { userId, provider },
    });
  });
  events.wake();
}
```

The committed outbox row survives a process crash. Call `wake()` only after
the transaction commits; periodic reconciliation also picks up committed
rows. Never substitute an in-memory callback for the transactional outbox.

## Make handlers safe to retry

Delivery is at least once. Use the event ID and subscription identity to make
effects idempotent in the subscriber's durable data. A crash after an effect
and before acknowledgement can cause the same event to run again. A manual
redelivery can also repeat it.

The handler context contains `subscriptionId`, `eventId`, `attempt`, and an
abort `signal`. Delivery runs as the subscribing service; it does not inherit
a publisher request's user authority. Keep domain permission and ownership
rules in the service that performs the effect. Honor cancellation and throw
when the work fails so the delivery receives a visible retry or failure state.

Subscriptions and event declarations persist while their applications are
offline. Only a live subscriber's changed manifest can remove its subscription.
An unreachable subscriber waits from 30 seconds up to one hour between checks
without spending a handler attempt; the 30-day delivery retention bound still
applies.

Core normally ingests the shared stream serially. A never-seen declaration
gets two short registration retries (after 1 and 5 seconds), then becomes a
visible rejected event with `event_not_declared`; later events can continue.
Delivery order is Core acceptance order within a subscription and subject.
A failed earlier delivery holds later deliveries for that pair. Recovered
ingestion dead letters are accepted when replayed, so they can arrive after
newer events; there is no global or event-time ordering guarantee.

For the retry schedule, retention budget, and recovery commands, see
[Operate app events](/en/docs/operations/app-events).

## Test a handler locally

Use `appEventFixture` and `deliverAppEvent` from `@k2b/cloud/events/testing`
to exercise the real declaration compiler and delivery validator without a
running application. A standalone declaration needs an explicit `appId`;
declarations already bound by `defineApp` use that binding. Fix the event ID
and time. Test schema rejection, a repeated event, and recovery after a failed
effect against the subscriber's real service boundary.

```ts
import { appEventFixture, deliverAppEvent } from "@k2b/cloud/events/testing";
import { publisherCapabilities, subscriberCapabilities } from "./capabilities";

const event = appEventFixture(
  publisherCapabilities,
  "user.created",
  {
    subject: "22222222-2222-4222-8222-222222222222",
    data: { userId: "22222222-2222-4222-8222-222222222222", provider: "local" },
  },
  {
    appId: "core",
    id: "11111111-1111-4111-8111-111111111111",
    time: "2026-01-01T00:00:00.000Z",
  },
);
await deliverAppEvent(subscriberCapabilities, "core.user.created", event, { appId: "filesv2" });
await deliverAppEvent(subscriberCapabilities, "core.user.created", event, { attempt: 2 });
```

For a terminal workflow:

```sh
cld events record core.user.created --shape-only --limit 3 --out ./user-created.jsonl
cld events replay ./user-created.jsonl --handler ./src/replay-user-created.ts#handle
```

`record` requires `--shape-only`. `--limit N` inspects the last N accepted
stored events of that type (at most 100), then returns one synthetic fixture
per distinct shape. A shape combines version, present object keys, and array
length buckets: 0, 1, 2–4, 5–16, and 17 or more. Scalar values are excluded.
Fixture IDs are deterministic and distinct across shapes. Core synthesizes
values from the stored declaration; this command does not export retained
payload values. Unsupported synthesis returns `shape_unavailable`.
`--out` creates a new file and refuses to overwrite an existing one. Without
`--out`, text and `--jsonl` emit JSONL; `--json` emits one array.

`replay` reads the current catalog and validates each fixture's envelope,
version, Type references, and data JSON Schema before calling the selected
local function. The default export is used when `#export` is omitted. It
passes the envelope and a delivery context with attempt `1` and subscription
ID `replay:<event-type>@<version>`. Fixtures are processed sequentially; a
failure stops replay and reports how many finished.

Replay sends no fixture to Cloud and does not invoke a production subscriber.
The selected local handler controls its own effects. Its output is a count:
`{ "delivered": 3 }`.
