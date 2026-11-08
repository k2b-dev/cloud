---
title: App events
navTitle: App events
section: Platform services
order: 556
description: Declare versioned application facts and consume service events with retryable handlers.
tags: [events, capabilities, subscriptions, automation]
updated: 2026-11-07
---

# App events

Declare an app event when another application needs to react to a fact that
has already happened. The publisher owns its event schema; each subscriber
owns its handler and effects. Use a [Query or Action](/en/docs/platform/capabilities)
when a caller needs an immediate answer or asks another application to do work.

## Who receives an event

- A **service event** has no `place`. Cloud delivers it to every application
  that subscribes to it; deploying the application approves its declared
  subscriptions.
- A **resource event** has a `place`. Cloud delivers it only to a subscription
  that a person stands behind with a mandate, such as an automation that runs
  on that person's behalf. Before every delivery Cloud checks, through the
  reader of the place's Type, that this person may still read the place. An
  event never carries the rights of its publisher or of whoever caused it.
- Ordinary application subscriptions receive service events only. An application subscription to a
  resource event stays `blocked` with `resource_events_unsupported`. Applications are not readers of places.

Core-owned workloads can install resource subscriptions in their activation
transaction. Each subscription binds an exact place, immutable workload
revision, and confirmed mandate. Cloud matches the place and activation cutoff
before creating a delivery and rechecks the current mandate and place Type
reader before invoking the workload. A denied read cancels delivery with
`resource_access_revoked`; an unavailable reader retries. `automation` metadata
does not grant authority or install a workload.

Deployed applications are trusted parts of the installation and share the
platform database and NATS credentials. Deploying an application is approval
for its declared subscriptions. Core accepts an event only when its source
application declared that event type and version.

## Built-in resource events

Spaces, Notebooks, Contacts, and Mail publish these version 1 events. The envelope's
`subject` and `place` carry public resource IDs accepted by the corresponding
Type readers. Notebooks and most Spaces events use a strict empty `data`
object (`{}`). `spaces.item.updated` carries only change categories; Contacts
updates carry only changed field-group names. Mail carries only the receipt
reference described below.

| Full event type | Subject Type | Place Type | When it is published |
| --- | --- | --- | --- |
| `spaces.item.created` | `spaces.item` | `spaces.space` | A task, calendar event, stored occurrence override, or split series is created. |
| `spaces.comment.created` | `spaces.comment` | `spaces.space` | A comment is created on an item or recurring occurrence; a retried comment request emits no second event. |
| `spaces.item.updated` | `spaces.item` | `spaces.space` | An existing item's assignees, deadline or status changes. Data is `{ changed: [...] }`, with one to three values from `assignees`, `due`, `status`. |
| `spaces.item.due` | `spaces.item` | `spaces.space` | An open task reaches its deadline, once per item and due value. |
| `spaces.item.completed` | `spaces.item` | `spaces.space` | An existing item changes from open to completed, including a drag, calendar cancellation, or transfer into a done column. |
| `notebooks.notebook.created` | `notebooks.notebook` | `notebooks.notebook` | A notebook is created. |
| `notebooks.notebook.updated` | `notebooks.notebook` | `notebooks.notebook` | Notebook metadata or settings change. |
| `notebooks.comment.created` | `notebooks.comment` | `notebooks.notebook` | A post is added to a note's page discussion; edits, deletions and passage annotations emit no such event. |
| `notebooks.note.created` | `notebooks.note` | `notebooks.notebook` | A note is created, including welcome notes, path creation, copies, and restored copies. |
| `notebooks.note.updated` | `notebooks.note` | `notebooks.notebook` | Persisted Markdown, title, the moved note’s parent or order, lock state, or recovery status changes, coalesced as described below. |
| `contacts.contact.created` | `contacts.contact` | `contacts.book` | A contact is created, including each committed import entry. Data is `{}`. |
| `contacts.contact.updated` | `contacts.contact` | `contacts.book` | Stored contact fields change. Data contains only the bounded `changed` group list described below. |
| `mail.message.received` | `mail.message` | `mail.mailbox` | An incoming message reaches its first eligible provider placement. |

The place Types have permission-aware readers: `spaces.space.read` and
`notebooks.notebook.read`, `contacts.book.read`, plus `mail.mailbox.read` for Mail.
Subject readers are `spaces.item.read`, `spaces.comment.read`,
`notebooks.notebook.read`, `notebooks.note.read`, `notebooks.comment.read`,
`contacts.contact.read`, and
`mail.message.read`. Read content through those
readers; events contain no titles, text, names, email addresses, content counts,
parent IDs, or previous-place references. Repeating completion or reopening an
item does not publish `spaces.item.completed`. A completion or reopening does
publish `spaces.item.updated` with `status`; repeated or otherwise unchanged
updates emit nothing. Status includes moving between columns and changing
completion state. Assignee order and equivalent timestamp offsets do not count
as changes. Title, description, priority, tags, progress, and rank alone do
not emit `item.updated`. Claims that add or remove assignees do.

A Spaces transfer publishes its assignee or status changes, and any completion,
under its **new place only**.
Its source receives no resource event naming the destination. A note move
carries only the note and its current notebook refs; it omits parent and position.
Moving notes between notebooks remains unsupported; copying creates a new note
and emits `note.created` in the destination notebook.

`spaces.item.due` uses a minute sweep with at most **524 tasks** per tick across
all replicas per UTC minute. Timed deadlines use their exact instant; all-day deadlines become
eligible at midnight in the installation's `app.timezone` (UTC when the
setting is empty or invalid). Only tasks with no
completion timestamp and outside done columns are eligible; calendar events
are excluded. The event fires when the due time is reached after the installation's
first successful due sweep, which persists a start watermark. There are no events
for tasks that were already overdue at that first sweep, or due exactly at that
watermark. Restarting
keeps the watermark and catches up deadlines reached after it. The oldest eligible
deadlines go first; a burst of 500 tasks fits in the next minute tick. Larger
backlogs take further ticks. See the [burst budget](/en/docs/operations/app-events#plan-retention-and-outage-capacity).
The event contains no deadline value: read the item's current state through
`spaces.item.read` before acting.

The sweep saves a durable receipt for each item and due value atomically with
the outbox event. Moving the deadline allows one event for the new value;
returning to an already announced value or reopening the task emits no second
due event for that value. A new or changed due time after the watermark fires
once, on the next tick if it has already passed. Receipts last until the item is deleted. Tick claims
and row locks keep retries and replicas within the shared batch limit. An
outbox failure rolls back the whole batch, receipts and tick claim for retry.

Contacts update data is `{ changed: [...] }`, with one to ten values from
`profile`, `emails`, `phones`, `addresses`, `websites`, `bankAccounts`, `tags`,
`notes`, `parent`, and `book`. The list follows that order and contains no
field values, names, addresses, note text, or old book references. Equivalent
normalized values, including rebuilt collection rows, publish no update.
Profile covers the contact's scalar details; tag changes mean assignments.
Geocoding cache refreshes, personal favorites, tag metadata changes, and derived
child-parent maintenance do not fan out contact events. Deleting a tag removes
its assignments without contact events. A merge announces its
surviving target. Moving a contact announces an update in its destination book
only; its source receives no app event naming that destination.

Contact writes and events commit together. Idempotent create and note retries
produce no duplicate event. Imports keep one creation event per successfully
committed contact, even when a later entry fails, independently of the import's
single live refresh. The existing limits are **1,000 contacts per import** and
**500 contacts per bulk tag or move operation**, enforced at the service seam.
See the [bulk and shared capacity budget](/en/docs/operations/app-events#plan-retention-and-outage-capacity)
and [Contacts automation capabilities](/en/docs/reference/contacts-automation).

`notebooks.note.updated` uses trailing coalescing. A changed note records its
first pending change and latest change in the domain transaction. A minute
sweep publishes at most four notes, oldest pending first, when the latest
change is at least 30 seconds old **or** the first pending change is at least
five minutes old. These are eligibility thresholds; scheduler alignment and
backlog can add delay. Pending changes survive restarts, including a save
followed by locking the note. The sweep uses the note's current notebook and
clears its marker atomically with the outbox event. A durable tick claim and
row locks prevent replicas or retries from multiplying the batch limit.
See the [shared capacity budget](/en/docs/operations/app-events#plan-retention-and-outage-capacity).

Only the moved note is announced. Sibling position renumbering, resetting a
level to automatic order, and a parent's derived `hasChildren` change do not
mark notes. Cursor advancement, binary snapshot maintenance, rebuildable
indexes, and unchanged or rejected saves do not count as content changes.
Collaborative edits mark the note when persisted to its snapshot, including
shared-log snapshot workers and server-side edits, rather than on each Yjs
update. Existing workspace and collaborative text streams retain their own behavior.

Creates, comments, item changes and completions remain transactional discrete facts. Notebook metadata
updates also remain transactional: one update affects one notebook and does
not fan out to its notes. Their rates follow domain
writes; they have no aggregate event throttle. A completion can emit both
`item.updated` and `item.completed`. The domain helpers can
participate in a caller-owned transaction, so they rely on the platform's
one-second outbox reconciliation instead of waking before that transaction
commits. The note and due sweeps own their transactions and call `wake()` after commit.

**Applications do not receive these events.** They are resource events: an
application subscription to them stays `blocked` with
`resource_events_unsupported`, and only resource-bound workload subscriptions with a valid mandate
and current read access receive them (see [Who receives an event](#who-receives-an-event)).

### Grids record changes

Grids also publishes version 1 resource events for record creation, updates,
deletion, and finalization. See [Grids events](/en/docs/reference/grids-events)
for mutation boundaries, bulk summaries, and table/base lifecycle events.

### Mail receipts

`mail.message.received` has strict data `{ receiptId: UUID }`. The receipt ID
is the stable identity of the first eligible provider placement. Keep it as
an opaque business key; the envelope's event ID remains the delivery deduplication
key. Use the public `subject.id` with `mail.message.read` or
`mail.message.read-content` to read authorized content. The event contains no
headers, addresses, subject text, body, attachment metadata, or conversation data.
The body may still be loading when the event arrives; readers report its state.

Mail publishes the event in the same transaction as its receipt decision and
existing workflow emissions, even when no workflow is enabled. An incremental
provider import can produce one receipt per message. A Gmail copy first seen
in All Mail waits for the first copy outside All Mail. Later labels, moves,
repeat syncs, and retries do not produce another receipt. The receipt keeps
its original placement identity after a move.

Trash and Junk placements do not publish. If the first copy outside All Mail
is in Trash or Junk, it consumes the pending receipt without publication;
restoring the message later does not create a receipt. Messages from configured
sender identities also do not publish, including their delivered self-copies.
Initial history imports and reconciliation imports do not publish or arrange
later catch-up. If such an import consumes a pending receipt, a later move
does not publish it. Provider drafts remain on Mail's existing draft path.
Mailbox and message access are still checked through capabilities; the receipt
grants no read or write rights.

## Chat posted messages

`chat.message.posted` version 1 announces a newly stored text message in an
ordinary Chat conversation or channel. The subject is `chat.message` (ten-character
message ID); the place is `chat.conversation` (six-character conversation ID).
Both general and named-thread messages publish, including quoted replies.
The strict data object contains:

| Field | Meaning |
| --- | --- |
| `threadReply` | Whether the message quotes an earlier message through `replyTo`. A named thread alone does not make a message a reply. |
| `root` | The reply chain's original `{ type: "chat.message", id }` ref for a reply; otherwise `null`. Replies to replies retain the original root. |
| `author` | The stored author's principal ref: `{ type: "user" \| "service_account", id: UUID }`. |
| `mentions` | Distinct validated principal refs, in input order, at most Chat's existing 20 mentions. Ineligible mentions are omitted. |

Each new reply stores its root ref, so later replies need one indexed lookup
regardless of chain depth. Messages stored before event support have no root
metadata: quoting one anchors the new chain at that legacy message. Historical
chains are not scanned or backfilled.

No body, names, mention ranges, previews, attachments or shared refs are included.
Read the message through `chat.message.read`; authorize the place through
`chat.conversation.read`. These readers check current grants, credential scopes
and account binding. The event grants no content access.

Publication shares the message transaction; delivery is woken after commit.
An idempotent retry emits no second event; rollback removes the message and event together. Edits, deletes, reactions,
system lines and messages in system conversations do not emit this event.
System conversations can contain item discussions with separate read checks;
the owning applications publish their domain events. Chat has no public message
import operation; migrations and direct database imports do not replay events.
There is no historical backfill.

### Skip messages from your own automation

Before reading content or performing an effect, compare `data.author` with the
service-account principal used to post the handler's results. Return immediately
when both type and ID match. This stops the handler from answering its own posts.
To react only when mentioned, also require that `data.mentions` contains the
intended principal. These checks need no message text.

```ts
const ownPrincipal = { type: "service_account", id: ownServiceAccountId };
const isOwnMessage = event.data.author.type === ownPrincipal.type
  && event.data.author.id === ownPrincipal.id;
if (isOwnMessage) return;
```

The publisher forwards the request's ID as `cause.requestId` when present,
including calls through `chat.message.post`, so effects can be correlated with
the originating capability execution. Empty IDs or IDs over the envelope's
256-character bound are omitted; optional correlation never prevents posting.
Correlation does not suppress delivery:
use the author check for self-posts, and durable event-ID receipts for retries.
The platform does not infer automation ancestry or prevent two different
handlers from replying to each other. Design their predicates accordingly.

Chat uses one discrete event per new message, without coalescing or aggregate
throttling. Its existing per-principal send limits remain in force. Include
all Chat posts and mention payload sizes in the
[shared capacity budget](/en/docs/operations/app-events#plan-retention-and-outage-capacity).

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

## Discover event declarations

`cld capabilities catalog --json` and `--jsonl` include event
and subscription manifests unchanged. Each app also has an `events` catalog
with full event, subject and place type IDs, version, title, description,
automation flag, data JSON Schema and matching subscribers. Subscriber states
and `firstSeenAt` come from Core's persisted subscription records. Publisher
and subscriber discovery use the capability catalog's app access filter,
including subscribers outside the current publisher page.

Administrators can use `cld events ls` for the persisted event catalog,
including declarations of offline publishers. Its table shows the place type
(`—` for service events) and automation flag (localized yes/no). Filter by
publisher with `--app <appId>` and by metadata with `--automation true|false`;
combine them to narrow the result. `--json` and `--jsonl` retain
the full filtered `{ events: [...] }` response, including schemas and subscribers.

MCP clients use two read-only tools on the
[Cloud MCP server](/en/docs/platform/mcp):

- `cloud__events__list` accepts optional `appId`, boolean `automation`, `cursor`,
  and `limit` (1–100, default 100). It returns `{ events, nextCursor? }`.
  Each event contains `appId` (publisher), `type`, `version`, `title`,
  `description`, `subject`, `place` (full Type ID or `null`), and `automation`.
- `cloud__events__read` accepts the exact `{ type, version }` from discovery.
  It returns `{ event }` with those fields plus `dataSchema` (JSON Schema) and
  `subscribers` (app ID, subscription ID, state, reason, and optional `firstSeenAt`).

MCP discovery uses the same live, hash-checked declarations and access filter
as the capability catalog. It needs OAuth `read` or `admin` scope; scopes do
not expand app access. Hidden apps and their subscriptions are omitted. An
unknown, hidden, or stale declaration returns `EVENT_NOT_FOUND` on read. A
catalog lookup failure returns `APP_UNAVAILABLE`.
List pages also respect the MCP response byte limit and may contain fewer
entries than requested. Pass `nextCursor` unchanged with the same filters until
it is absent. A read whose schema and subscriber list exceed the result budget returns
`RESPONSE_TOO_LARGE`.

These tools discover declarations only. They do not watch events, create
subscriptions, or install Assistant Routines. A declared place and
`automation: true` remain catalog metadata; they do not install a resource subscription or grant authority.

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
import { sql } from "@k2b/cloud";
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

When importing the capability handlers would create a service dependency cycle,
use a type-only import and resolve the application's platform binding lazily:

```ts
import type { publisherCapabilities } from "./capabilities";
const events = appEvents<typeof publisherCapabilities>("inventory");
```

The app ID must match `defineApp`; `app.start({ capabilities })` installs the
binding before lifecycle startup. Publication uses that binding's real schemas,
refs, and byte validation. It rejects an unknown or unstarted app before
writing. Standalone service tests still require
`createAppEventTestHarness(appId, capabilities)`; there is no app-owned setter.

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
applies. Connection loss after sending and request timeouts spend an attempt;
eight failed attempts end the delivery. The framework answers after a 30-second
handler deadline and Core waits 45 seconds. Honor the signal even when a timeout
has already returned: work that ignores cancellation can still finish effects.

When a live publisher removes a declaration, Core retains its history but removes
it from the current catalog, blocks its subscriptions with `event_not_declared`,
and rejects new events of that type. Offline publishers retain their declarations.

Core normally ingests the shared stream serially. A never-seen declaration
gets two short registration retries (after 1 and 5 seconds), then becomes a
visible rejected event with `event_not_declared`; later events can continue.
Deterministically invalid envelopes and unusable stored schemas are also rejected
without retrying ingestion. Core strips unknown top-level envelope fields, so
additive metadata from a newer publisher does not block older Core instances.
Administrators inspect rejection counts and metadata with `cld events status`;
that response never includes payloads.
Delivery order is Core acceptance order within a subscription and subject.
A failed earlier delivery holds later deliveries for that pair. Recovered
ingestion dead letters are accepted when replayed, so they can arrive after
newer events; there is no global or event-time ordering guarantee.

For the retry schedule, retention budget, and recovery commands, see
[Operate app events](/en/docs/operations/app-events).

## Platform-owned resource consumers

The server module `@k2b/cloud/services/app-events` exposes the Core host hooks
`subscribeResourceEvent`, `cancelResourceEventSubscriptions`, `replayResourceEventDelivery`, and
`registerResourceEventConsumer`. These are platform-owned hooks, not an
application subscription API. Ordinary application authors continue to use
`subscribes` for service events.

Install a consumer once at startup and unregister it after draining the event
broker. In the workload activation transaction, call `subscribeResourceEvent`
with the subscriber `appId`, full event `type`, `version`, and a `binding`:
`consumer`, stable workload `key`, immutable `revision`, `mandateId`,
`mandateRevision`, and exact `place: { type, id }`. Registration is idempotent
for an active complete binding. Reusing a cancelled binding fails; resuming
creates a fresh registration revision. Mandate revision changes also require
cancelling and registering again. Events published before registration are excluded, including
older events still in the publisher outbox. Registration and event acceptance serialize the activation boundary. No implicit catch-up occurs.
Publication timestamps come from the transaction's PostgreSQL clock with
microsecond precision, matching subscription cutoffs regardless of the publisher process clock.

The consumer receives the binding, original reference envelope and standard
delivery context. It must recheck its current workload revision and enabled
state under its workload lock, then commit its durable receipt and admission
in one transaction before returning. If the workload has changed before
admission, return `{ cancelled: true }` to record `workload_changed` instead
of acknowledging an admission. It must honor the abort signal and make
admission idempotent by event ID. Cloud does not turn event visibility into
permission to read content or perform an effect: subsequent capability calls
still enforce the workload's policy and current grants. Keep resource event
data reference-only; read content through authorized capabilities.

Use transaction handles, never a pool, for both registration and cancellation.
Cancel subscriptions in the same transaction that disables or replaces the
workload. Cancellation fences outstanding delivery claims; an admission that
committed first is already separate workload work. Offline consumer code leaves
work retrying without spending handler attempts. Resource consumers share the
existing broker, delivery table, eight-attempt retry policy, retention and
per-subscription subject ordering; no second transport is installed.

For deliberate recovery after a workload change, the host can call
`replayResourceEventDelivery` in its authorized workload transaction. It moves
a retained delivery to the current subscription for the same consumer, key,
event version and place. This explicit operation bypasses the registration
cutoff, then repeats ordinary visibility and admission checks. It does not
repeat effects already admitted by the consumer's receipt. Recovery is limited
to 30 days after the event was received. Resource delivery records remain for
30 days to support this recovery; ordinary service delivery retention is unchanged.

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

Resource visibility checks carry a query-only, mandate-bound event proof. The
provider revalidates the active subscription and claimed delivery before its
ordinary Type reader checks the principal's current read access. The proof is
usable only while a delivery of that event for that mandate is claimed and
cannot authorize an Action or a workload run.

Code's resource-owned `app.on` registrations use these workload subscriptions,
with their checked owner, event version and execution mandate. Delivery commits
the event-to-run receipt before acknowledgment. See
[Code event deliveries](/en/docs/platform/code-runs#understand-event-deliveries).

## Resolve an occurrence for catch-up

An event with one immutable occurrence per subject can declare `catchup` as the
local ID of a permission-aware query. The query accepts `{ id: subject.id }` and
returns the canonical event envelope as its capability data. It must check the
requester's current read permission and derive receipt identity, owner and data
from the application's own state. Repeating event types must not declare this
contract. The resolver does not publish an event.

Code catch-up uses that resolver before saving its bounded snapshot, and admits
only to the selected Code version. It does not notify other subscriptions. See
[Mail automations](/en/docs/platform/mail-code-automations) for the first consumer.
