---
title: App capabilities
navTitle: Types, Queries, Actions & Commands
section: Platform services
order: 555
description: Publish a small, versioned RPC surface for cross-app calls, agents, CLI, and MCP.
tags: [capabilities, rpc, agents, mcp]
updated: 2026-09-08
---

# App capabilities

Capabilities are an application's small, versioned machine interface. An app
publishes addressable resource **Types**, read-only **Queries**, and mutating
**Actions**, and interactive **Commands** from one `defineCapabilities()` declaration.

The declaration exists so a separately deployed provider can describe a stable
operation once while Cloud projects it into cross-app calls, AI tools, the
authenticated Cloud MCP server, HTTP, and CLI. Consumers discover the current
live contract; they do not import the provider's source code or private DTOs.

Use capabilities only for stable operations that should work through several
of those consumers. Keep complete administrative APIs, bulk transfers,
specialized transport behavior, and unstable internal operations in REST and
app-specific CLI modules.

> A capability is discoverable, not authorized. The owning application must
> authenticate the request and check current resource access for every call.

## Choose what to publish

Publish an operation when it is:

- stable enough to name and version;
- bounded in input, output, and work;
- useful to more than one machine client;
- clear from its title, description, and field descriptions;
- safe after the owning app performs its normal authorization.

Do not mirror every REST endpoint. Capabilities are a curated semantic surface,
not a second complete application API.

| Surface | Use it for |
| --- | --- |
| Capabilities | Stable cross-app reads and mutations, agent tools, generic RPC |
| REST API | Complete application behavior and specialized HTTP contracts |
| App CLI module | Full application-specific terminal workflows |
| Generic capability CLI | Discovering and invoking the curated capability surface |

## Declare the surface

Keep capability definitions in `src/capabilities.ts`, next to modules such as
`src/notifications.ts`. This example publishes one resource Type, one Query,
and one Action. The sample store keeps the example complete; a real application
performs these reads and mutations in its service layer.

**`src/capabilities.ts`**

```ts
import { defineCapabilities } from "@k2b/cloud";
import type { AccessSubject } from "@k2b/cloud/contracts";
import { ok } from "@k2b/stdlib";
import { z } from "zod";

type Item = {
  id: string;
  ownerId: string;
  name: string;
  quantity: number;
};

const items = new Map<string, Item>([
  [
    "k3P9xQ",
    {
      id: "k3P9xQ",
      ownerId: "user-42",
      name: "USB-C adapter",
      quantity: 4,
    },
  ],
]);

const visibleItem = (id: string, subject: AccessSubject): Item | null => {
  const item = items.get(id);
  return item && subject.type === "user" && subject.userId === item.ownerId
    ? item
    : null;
};

export const inventoryCapabilities = defineCapabilities({
  protocolVersion: 2,
  types: {
    item: {
      title: "Inventory item",
      description: "One item in the inventory catalog.",
      icon: "ti ti-package",
      reader: "item.read",
    },
  },
  queries: {
    "item.read": {
      title: "Read inventory item",
      description: "Read one visible inventory item by stable ID.",
      input: z
        .object({
          id: z.string().regex(/^[A-Za-z0-9]{6}$/).describe("Stable inventory item ID."),
        })
        .strict(),
      data: z
        .object({
          id: z.string().regex(/^[A-Za-z0-9]{6}$/),
          name: z.string(),
          quantity: z.number().int(),
        })
        .strict(),
      openWorld: false,
      run: async ({ id }, context) => {
        const item = visibleItem(id, context.accessSubject);
        if (!item) {
          return {
            ok: false,
            error: {
              code: "NOT_FOUND",
              message: "Inventory item not found",
              status: 404,
            },
          } as const;
        }
        return ok({
          data: { id: item.id, name: item.name, quantity: item.quantity },
          refs: [{ type: "inventory.item", id: item.id, title: item.name, icon: "ti ti-package" }],
          links: [{ rel: "open", href: `/app/inventory/items/${item.id}` }],
        });
      },
    },
  },
  actions: {
    "item.rename": {
      title: "Rename inventory item",
      description: "Rename one inventory item the caller may edit.",
      input: z
        .object({
          itemId: z.string().regex(/^[A-Za-z0-9]{6}$/).describe("Stable inventory item ID."),
          name: z.string().trim().min(1).max(120).describe("New item name."),
        })
        .strict(),
      data: z.object({ id: z.string().regex(/^[A-Za-z0-9]{6}$/), name: z.string() }).strict(),
      destructive: true,
      openWorld: false,
      idempotency: "none",
      approval: "rememberable",
      review: async ({ itemId, name }, context) => {
        const item = visibleItem(itemId, context.accessSubject);
        if (!item) {
          return {
            ok: false,
            error: {
              code: "NOT_FOUND",
              message: "Inventory item not found",
              status: 404,
            },
          } as const;
        }
        return ok({
          message: "This inventory item will be renamed.",
          details: [
            { label: "Current name", value: item.name },
            { label: "New name", value: name },
          ],
          links: [{ rel: "open", href: `/app/inventory/items/${item.id}` }],
          approvalScope: "inventory",
        });
      },
      run: async ({ itemId, name }, context) => {
        const item = visibleItem(itemId, context.accessSubject);
        if (!item) {
          return {
            ok: false,
            error: {
              code: "NOT_FOUND",
              message: "Inventory item not found",
              status: 404,
            },
          } as const;
        }
        const renamed = { ...item, name };
        items.set(itemId, renamed);
        return ok({
          data: { id: renamed.id, name: renamed.name },
          summary: `Renamed inventory item to ${renamed.name}`,
          refs: [{ type: "inventory.item", id: renamed.id, title: renamed.name, icon: "ti ti-package" }],
          links: [
            { rel: "edit", href: `/app/inventory/items/${renamed.id}/edit` },
          ],
        });
      },
    },
  },
});
```

Import the declaration where the application starts:

**`src/config.ts`**

```ts
import { defineApp } from "@k2b/cloud";
import { Hono } from "hono";
import { inventoryCapabilities } from "./capabilities";

const app = defineApp({
  id: "inventory",
  name: "Inventory",
  description: "Track inventory items.",
  icon: "ti ti-package",
  baseUrl: "http://app-inventory:3000",
  routes: ["/app/inventory"],
});

const router = new Hono().get("/app/inventory", (c) =>
  c.html("<h1>Inventory</h1>"),
);

export default await app.start({
  capabilities: inventoryCapabilities,
  fetch: router.fetch,
});
```

`app.start()` compiles the declaration before registration. The application
service still owns durable reads and writes, permission checks, and audit
records. Retry safety is not an application concern: Cloud claims every
`idempotency: "required"` Action for you.

### Localize catalog presentation

The declaration's English titles, descriptions, search-tag copy, and Zod field
descriptions are its complete base presentation. Add locale-specific overlays
under `presentation` when the application ships another language:

```ts
export const inventoryCapabilities = defineCapabilities({
  protocolVersion: 2,
  presentation: {
    baseLocale: "en",
    translations: {
      de: {
        types: {
          item: { title: "Inventarartikel", description: "Ein Artikel im Inventarkatalog." },
        },
        queries: {
          "item.read": {
            title: "Inventarartikel lesen",
            description: "Liest einen sichtbaren Inventarartikel anhand seiner stabilen ID.",
            input: { id: "Stabile Inventarartikel-ID." },
          },
        },
        actions: {
          "item.rename": {
            title: "Inventarartikel umbenennen",
            description: "Benennt einen bearbeitbaren Inventarartikel um.",
            input: { itemId: "Stabile Inventarartikel-ID.", name: "Neuer Artikelname." },
          },
        },
      },
    },
  },
  // types, queries, and actions...
});
```

Translation maps use stable local IDs, stable search-tag tokens, and dotted
schema field paths such as `filters.tags[]`. Startup rejects unknown IDs and
paths. A locale may override only the human presentation it owns; operation
IDs, tag tokens and aliases, schemas, schema hashes, safety flags, and result
data remain unchanged. Catalog requests resolve exact locale, ancestor, and
base fallback (`de-CH` → `de` → `en`) and return final localized strings, so
consumers never import another application's message keys.

Action reviews and provider-authored summaries or errors are runtime output,
not registry metadata. Resolve those inside the handler from
`context.locale`; preserve their stable codes and structured values.

## Understand Types, Queries, and Actions

### Types name resources

A Type gives an addressable resource a stable identity such as `item`. Cloud
qualifies local IDs with the application ID:

```text
item        -> inventory.item
item.read   -> inventory.item.read
item.rename -> inventory.item.rename
```

Applications declare only the local part. Cloud derives the qualified ID from
the registered application ID and uses it as the stable operation identity for
Skills, Assistant discovery, loaded-tool state, CLI, and transport metadata.
Provider-safe function names are generated later and are not capability IDs.

An application that publishes Capabilities uses a lowercase kebab-case ID
matching `[a-z][a-z0-9-]*` (maximum 80 characters). This keeps qualified IDs,
CLI commands, and MCP tool names aligned.

Types connect operation targets, result references, Universal Search results,
and client presentation. Declaring a Type does not create CRUD operations.

A Type may name one canonical reader Query:

```ts
types: {
  item: {
    title: "Inventory item",
    description: "One item in the inventory catalog.",
    reader: "item.read",
  },
}
```

`reader` is the Query's local ID inside the same app. Its presence tells a
consumer that a `CloudResourceRef` of this Type can be read programmatically.
The referenced Query is the only read implementation; do not publish a second
`item.get` or a Project-specific reader for the same operation. Omit `reader`
when the resource has no useful bounded machine representation.

When an application lets a user copy or paste this identity, use Cloud's
versioned resource clipboard format instead of embedding an ID in app-specific
JSON or inferring it from text. See
[Copy and paste Cloud resources](/en/docs/platform/resource-references).

### Queries read data

Queries do not mutate application state. Use them for bounded read, list,
filter, or search operations. Filtering, sorting, pagination, and authorization
stay in the application service.

Declare `openWorld` on every Query. Use `true` when it may interact with an
open world of external entities, even if it remains read-only. A web search is
open-world; a lookup limited to the app's own permission-scoped database is
closed-world.

Queries may opt into [Universal Search](/en/docs/platform/search). An app may
publish multiple focused search Queries when it owns distinct resource kinds.
Cloud caps merged results per app, so registering more focused Queries does
not give an app a larger share of the global result set.

A canonical reader is an ordinary Query named by its Type. Its input has one
required resource field named `id`. It may add optional fields for bounded
pagination or content windows, but no other required field. Every
provider-owned `CloudResourceRef` for that Type must use an `id` the reader can
resolve directly. The reader performs the same current authorization as every
other Query.

Use the resource's stable, app-owned public ID for `CloudResourceRef.id`, not
an internal database primary key. The app's canonical reader accepts that value
unchanged and resolves it at the application boundary. See
[Public resource identifiers](/en/docs/data/public-resource-identifiers) when
choosing between an existing domain identifier and a compact generated ID.

Consumers resolve a reader from the current live manifest: find the owning app
from the qualified `ref.type`, find the matching Type, then invoke the Query in
its optional `reader` field with `{ id: ref.id }`. They do not derive a Query
name, persist one beside the reference, or fall back to semantic capability
search.

### Design operations that machines can compose

Capability metadata is part of the machine contract. A person may infer that
two bare IDs belong to different resources from the surrounding UI; a generic
client or agent must not have to guess.

- Start titles with the concrete verb and resource, such as **Search mail** or
  **Read conversation**. Give overlapping operations distinct scopes instead
  of repeating generic words such as “get” or “update.”
- Make the description state the useful boundary: one known resource, one
  mailbox, all accessible mailboxes, or an advanced structured search. When
  one operation is the normal starting point and another is specialized, say
  so directly.
- Describe every opaque input by resource type and provenance. For example,
  write “Exact mailbox ID returned by List mailboxes,” not merely “Mailbox
  ID.” Do not advertise invented sentinel values such as `default` unless the
  schema and implementation actually accept them.
- Return qualified `CloudResourceRef` values for addressable results. A client
  can pass that ref unchanged to the Type's current canonical reader. It must
  never guess a reader name or pass an ID from one resource Type to a reader
  for another Type.
- Keep identity next to each independently usable list result. Prefer
  `CloudResourceView[]` when its fixed projection is sufficient; otherwise use
  clearly typed domain fields and semantic links. Do not make callers
  correlate parallel arrays or infer resource type from a bare `id`.

A common read flow should therefore remain short and typed:

```text
discover focused search -> search -> typed resource ref -> canonical reader
```

Use Universal Search as the normal cross-application or cross-scope search
when its bounded resource-view contract fits. Publish a separate app-specific
search only for materially different semantics such as structured filters,
exhaustive traversal, or a required domain scope. Its title, description, and
input descriptions must make that distinction visible during discovery.

### Design results around the next decision

Choose fields by the task they support, not by the database row they come
from. A mailbox selector may need a name, typed reference, unread count,
and action-needed count. Connection diagnostics and creation timestamps are
useful for administration, but need not appear in every selection result.
Define what counts include and whether they depend on the current actor.

Keep selection results compact. Return enough information to choose a resource
and perform the next operation without reading every candidate separately.
Load full content or specialist details only when the task needs them. Add a
separate browse or content operation only when it provides a useful boundary;
do not create one mechanically for every Type or replace its canonical reader.
Never present a preview as complete content.

Before changing a published result, inspect real consumers, including other
applications, workflows, CLI clients, and Assistant skills. A field that seems
irrelevant to an agent may still support a user-facing feature. Follow
[additive evolution](#evolve-published-local-ids-additively): do not remove
guaranteed fields from an existing operation to make its output smaller.

### Check complete task paths

Start with representative user tasks and trace the operations needed to finish
them. Check both discovery and direct access to a known resource. For example:

- An unknown mailbox needs selection before reading its conversations; a known
  mailbox ID should not require listing all mailboxes again.
- A reply needs the relevant conversation, a draft, and the applicable send
  approval. Return the identifiers needed for that handoff directly.
- Editing a note needs the intended content and a consistent revision, not a
  read of every note in its notebook.

Avoid redundant lookups, but retain resource authorization, necessary
current-state reads, and approval gates. Keep domain rules in the owning
service so HTTP, capability, and UI callers retain the same behavior.

Assistant skills should explain these short task paths and route to specialist
references only when needed. Do not copy the complete operation inventory or
schemas into a second manual. Keep capability descriptions, skill instructions,
and tested workflows consistent.

### Preserve completeness within bounded results

Pagination and content windows must distinguish a complete result from a
bounded part of one:

- Budget the serialized JSON envelope, including metadata, refs, and links,
  against the [contract limits](#write-valid-contracts). Account for UTF-8 and
  JSON escaping, not just character count or the size of `data`.
- Follow `page.hasMore` and `page.nextCursor`, not the number of returned items.
  A byte-limited page can be short; a filtered source page can even be empty
  while more source data remains. Document whether pagination advances through
  source records or emitted results. Never skip records omitted only because
  the output budget was reached.
- Keep cursors scoped to the query and require forward progress. Consumers
  should detect repeated cursors or cycles, not assume a fixed page count.
  If a traversal stops at a work budget, report it as incomplete rather than
  claiming all results were read. A failed read is not an empty result.
- Bound internal scans and fan-out independently of the returned item count.
  Permission filtering or recurrence expansion can require much more work than
  the visible page suggests.
- Mark partial content explicitly. A whole-document replacement needs complete
  source content from one consistent revision or hash. Do not assemble windows
  from different revisions or overwrite from a preview. For partial updates,
  preserve omitted fields server-side and define what explicit `null` and empty
  collections mean. Reject revision conflicts rather than overwriting blindly.

### Review the provider and its consumers together

Before publishing or changing an operation, verify:

- Every retained field supports selection, interpretation, the next action,
  or an existing consumer contract.
- A representative result can feed the next operation's actual input schema,
  without guessing IDs, resource types, or hidden defaults.
- Real consumer projections still accept the result and preserve user-facing
  behavior; use the [manifest evolution check](#evolve-published-local-ids-additively)
  for published contracts as well.
- Focused tests cover the affected permission boundary, pagination progress,
  result limits including refs and escaped multibyte content, and partial-read
  or revision-conflict behavior where applicable.

### Actions change state

Actions declare the mutation's objective behavior:

| Field | Meaning |
| --- | --- |
| `destructive` | `true` when the effect is irreversible or externally visible; `false` for reversible in-Cloud state changes |
| `openWorld` | `true` when the Action may interact with an open world of external entities; `false` when its interaction domain is closed |
| `idempotency` | Retry contract: `none` or `required` |
| `approval` | Optional Cloud client policy: omitted asks each time; `"rememberable"` offers scoped approval; `"none"` allows autonomous closed-world, non-destructive execution |
| `review` | Optional read-only description of the concrete effect for human review |

Query and Action kinds project to the MCP `readOnlyHint`; `destructive` and
`openWorld` project to the matching MCP hints. `openWorld` is independent of
mutation: a read-only web search is still open-world.

**`destructive` means irreversible or externally visible.** Deleting a record,
sending a message, publishing, sharing outside Cloud, and overwriting content
without an undo path are destructive. A reversible state change the same user
can set back — marking read, marking a favorite, editing tags, changing a status,
or reassigning an owner — is **not** destructive. Choose the label from the
consequence for the user, not from the SQL statement.

Cloud enforces the mechanical part of that rule when it compiles a manifest, so
a violating app fails to start rather than shipping a misleading catalog:

- every `destructive: true` Action must declare `review()` and
  `idempotency: "required"`;
- every `openWorld: true` Action must declare `review()` and
  `idempotency: "required"`, and must not use `approval: "rememberable"`;
- `approval: "rememberable"` must not be combined with `destructive: true`.

An Action that creates a record should also require idempotency. That one is
guidance rather than a compile check, because Cloud cannot tell a create from
an update.

Queries are always retry-safe. An Action with `idempotency: "required"` is
retry-safe because Cloud enforces it (see
[Retry an Action safely](#retry-an-action-safely)); `none` means callers must
not send a key and must not retry after an ambiguous transport failure.

Do not rely on MCP's conservative defaults. Declare these fields explicitly so
the live Cloud catalog remains deterministic. MCP defines annotations as
untrusted hints and does not prescribe an approval policy. Cloud clients may
use trusted app metadata for confirmation, warning, retry, or untrusted-content
treatment, but that behavior belongs to the client. See the official
[MCP ToolAnnotations schema](https://modelcontextprotocol.io/specification/2025-11-25/schema#toolannotations)
and [AI tools and approvals](/en/docs/ai/tools-and-approvals).

`approval` is deliberately optional. Without it, AI Core
asks for every Action call. `approval: "rememberable"` lets a supporting client
offer an explicit **Always approve** choice after showing the Action review.
That review must return an opaque, app-owned `approvalScope`. A remembered
choice matches the current actor, qualified Action, and exact scope; for
example, Mail uses one scope per mailbox. Choose the smallest stable domain in
which repeated calls have the same understandable consequence.
Cloud rejects this policy on `openWorld` Actions, on `destructive` Actions, and
on Actions without a `review`. It does not weaken app-side authorization, input validation, audit,
or concurrency checks, all of which still run for every invocation.

Use remembered approval only for bounded, repeatable changes where future
calls of the same Action are an understandable extension of the user's choice,
such as editing a draft, marking a conversation, or updating a task. Do not use
it for deletion, external communication, permission changes, financial or
legal commitments, or other effects whose target and consequence should be
confirmed every time.

None of the metadata replaces application-side authorization. The owning app
must authorize both an optional review and the eventual Action against current
state.

Record security-sensitive mutations with [Audit events](/en/docs/platform/audit-events).

### Retry an Action safely

Idempotency is a platform mechanism. Applications write no claim code, no
receipt table, and no replay branch: they implement the Action once and Cloud
guarantees that one `Idempotency-Key` produces at most one effect.

The caller sends a stable `Idempotency-Key` header with every
`idempotency: "required"` Action, and reuses the exact same key and input to
retry it. Before forwarding, the dispatcher claims
(app, capability, acting principal, key) together with a hash of the canonical
input, and resolves that claim once the outcome is known:

| Situation | Result |
| --- | --- |
| First call | Forwarded once; a definitive success is stored |
| Retry of a stored success | The stored status and body are replayed without forwarding |
| Same key, different input | `409 IDEMPOTENCY_CONFLICT` |
| A concurrent attempt is still running | `409 IDEMPOTENCY_IN_PROGRESS` |
| An earlier attempt lost its answer | `409 IDEMPOTENCY_UNCERTAIN` |

A failure that proves nothing happened — a `4xx` from the app, or a dispatcher
rejection before forwarding — releases the key, so a corrected retry runs
normally. A timeout, transport failure, or unusable response freezes the key as
uncertain; the outcome is genuinely unknown, so Cloud never re-forwards it and
the caller must read the current state with a Query before deciding.

Stored responses larger than 256 KiB are not retained; replaying one returns
`IDEMPOTENCY_UNCERTAIN` with a "result not retained" message. Claims expire 24
hours after they are created, pruned by the same maintenance that prunes
execution history. Reuse a key only to retry the same call.

### Describe an Action before it runs

Use one test: if a client chooses to ask before execution, can a person identify
the target, change, and consequence from the parsed Action arguments alone? If
not, add `review`.

A review is normally useful when:

- opaque IDs need current names, labels, or values;
- an update needs a before-and-after comparison;
- external communication, publication, permission changes, or destructive
  work needs a concrete consequence;
- a bulk Action needs a bounded count and representative targets;
- large or encoded input such as a document, attachment, or calendar payload
  needs a readable summary.

Cloud's built-in providers add a review to every `destructive` or `openWorld`
Action so a client can present concrete targets and consequences before asking
for approval. Third-party apps may opt into reviews independently, but should
follow the same rule when their Actions need human approval. Do not add reviews
to closed-world, exclusively additive Actions merely to repeat the title or
serialize the same arguments differently; that creates confirmation fatigue
without adding useful context.

An Action can explicitly declare `approval: "none"` for autonomous execution.
The compiler accepts this only for non-destructive, closed-world Actions. AI
execution then skips review and confirmation; normal authorization, validation,
idempotency, and delegated mandate restrictions still apply. Omitting `approval`
keeps the default confirmation behavior. Use `rememberable` when users should
choose whether to approve future operations in the same scope.

Every review returns the same fixed Cloud type:

```ts
type CapabilityActionReview = {
  message: string;
  details?: Array<{
    label: string;
    value: string;
    display?: "inline" | "block";
    format?: "date" | "date-time";
  }>;
  links?: CapabilitySemanticLink[];
  approvalScope?: string;
};
```

`message` states the consequence. `details` lists the concrete values a person
should check. Omit `display`, or use `inline`, for concise fields. Use `block`
for bounded long-form plain text such as a proposed message body. `links`
reuses the existing root-relative, same-origin semantic links so the person can
inspect or edit the resource in its owning app.

`approvalScope` is omitted for one-time approvals and required when the Action
declares `approval: "rememberable"`. It is an opaque identifier interpreted by
the owning app, not a permission grant or a replacement for current access
checks in `review` and `run`.

The owning app chooses date semantics without pre-formatting for one locale:
use `format: "date"` with an exact `YYYY-MM-DD` calendar date or an RFC 3339
instant whose time should be hidden. Use `format: "date-time"` when both date
and time matter. Clients render those values in the viewer's locale and convert
instants to the viewer's timezone. Omit `format` for ordinary text, including
relative descriptions such as an undo window.

The shape is intentionally fixed. Reviews have no app-defined schema, title,
icon, severity, arbitrary JSON, HTML, Markdown, refs, pagination, or executable
controls. `display` is only a layout hint, and `format` only selects a fixed
plain-text date presentation; neither changes the value's trust. Clients derive
the title and app presentation from the live manifest and registry, and derive
warning treatment from `openWorld` and `destructive`. Render every review value
as escaped, untrusted plain text and keep semantic links as links rather than
flattening them into text.

Cloud bounds a review to a 1,000-character message, 20 details with a
120-character label and 10,000-character value, and 10 semantic links. For
larger content, return a useful bounded description and an `open` or `edit`
link to the complete resource.

The callback receives the Action's parsed input and normal
`CapabilityExecutionContext`. It must only read, validate, and authorize; it
must not mutate state, perform an external effect, manufacture approval, or
change the Action input. Return normal capability errors when the target is no
longer available or reviewable.

A successful review is presentation, not permission or proof of user intent.
The Action still revalidates its input, authorization, version or revision,
and domain invariants in `run`. If reviewed state changes before execution,
fail the Action rather than applying a different effect.

## Write valid contracts

Cloud validates the declaration at startup:

- `protocolVersion` is currently `2`;
- local IDs start with a lower-case letter and may contain `.`, `_`, or `-`;
- one local ID may occur only once across Types, Queries, Actions, and Commands;
- inputs are closed `z.object(...).strict()` schemas;
- every meaningful input field has a concise `.describe(...)` string;
- input and data schemas must project to JSON Schema;
- every Query and Action declares `openWorld`, and every Action also declares
  `destructive` and `idempotency`;
- every Type `reader` names an existing Query in the same declaration;
- a reader Query has a required string `id` field and no other required input
  fields, and is assigned to at most one Type;
- `idempotencyKey` is reserved for transports and cannot be an Action field;
- Action reviews use the fixed platform schema and are advertised as
  `review: true` only when the callback exists;
- `approval: "rememberable"` appears only on non-destructive, closed-world
  Actions with a review;
- every `destructive` or `openWorld` Action declares `review()` and
  `idempotency: "required"`;
- every provider-owned Type used by `refs` or Universal Search is declared;
- an app may declare at most 200 Types, 200 Queries, and 200 Actions;
- the deterministic live manifest may not exceed 256 KiB.

Every invocation transport caps the complete JSON request and result at 256
KiB. The paginated discovery catalog has a separate 2 MiB page limit because
one valid manifest may itself approach 256 KiB. Provider endpoints validate and
serialize invocation results within the 256 KiB bound before returning them.
Keep individual field limits comfortably below that envelope; large files,
exports, and document bodies belong in app-owned upload or download APIs
referenced by a capability.

Each operation publishes input and data JSON Schema plus a stable schema hash.
The result envelope is one fixed Core contract and is not repeated in every
manifest entry. Refresh the live catalog after `SCHEMA_MISMATCH`.

### Keep contracts at the owning boundary

The provider owns the canonical Zod input and data schemas in its
`src/capabilities.ts` declaration. Core stores their projected JSON Schemas in
the live registry and validates both the caller input and every successful app
response before returning it. Core does not compile built-in app DTOs into a
central schema package.

A consuming app calls the public capability client and keeps only the small
DTO projection its own UI or service needs. Do not import another app's
`capability-contracts`, service files, or private source paths. This applies to
built-in and third-party apps equally: installation and registration make a
provider discoverable, while the live manifest supplies the runtime contract.
Additive consumer projections should accept unknown extra fields so a provider
can extend a result without breaking older consumers.

This boundary keeps deployment independent:

```text
provider Zod declaration -> live manifest JSON Schema -> Core dispatcher
                                                    -> public consumer client
```

The provider still parses and authorizes inside `run`. Core's validation is an
additional transport invariant, not a replacement for app-side checks.

### Evolve published local IDs additively

Treat an app ID plus local operation ID as a stable public contract. The same
ID may add new Types, operations, optional input object fields, result object
fields, Universal Search tags, a Type reader, or an Action review. It must not
change kind, remove fields or operations, add required input, weaken a
previously guaranteed result field, change safety or idempotency semantics, or
remove or replace an advertised reader, review, or search token. Publish a new
local ID for those changes and migrate callers deliberately.

Keep a previous manifest fixture and check it in provider tests:

```ts
import {
  assertCapabilityManifestEvolution,
  compileCapabilityManifest,
} from "@k2b/cloud/capabilities/testing";

const current = compileCapabilityManifest("inventory", inventoryCapabilities);
assertCapabilityManifestEvolution(previousManifestFixture, current);
```

Titles and descriptions may improve without changing the local ID. Consumers
should still project only the fields they need with permissive runtime schemas
so additive result fields remain compatible.

## Return structured results

### Optional table previews

`CapabilityResult<T>` accepts optional `presentation` metadata:

```ts
type TablePresentation = {
  kind: "table";
  rowsPath: string[];
  columns: Array<{ path: string[]; label: string; format?: "text" | "number" | "date" | "datetime" }>;
  rowLinksPath?: string[];
};
```

Metadata describes existing data, not a second result. `rowsPath` selects an array
relative to `data`; `[]` selects `data` itself. Column paths and `rowLinksPath` are
relative to each row. Segments are literal own JSON property names, not dotted
expressions, templates or executable code. Missing cells display as absent.
Row links use the existing semantic-link contract.

Assistant opens capability navigation links in a new browser tab so users keep
their conversation. This is client behavior, not a provider `target` setting.

```ts
return ok({
  data: [{ name: "Cable", stock: "42.0000" }],
  presentation: {
    kind: "table", rowsPath: [],
    columns: [{ path: ["name"], label: "Item" }, { path: ["stock"], label: "Stock", format: "number" }],
  },
});
```

For Grids-shaped data, use `rowsPath: ["rows"]`, column paths such as
`["values", column.key]`, and `rowLinksPath: ["links"]`. Derive columns from the
authorized result; never reread hidden fields to improve a preview. Exact decimal
strings stay intact; format hints do not authorize lossy numeric conversion.

Metadata is bounded to 100 columns, 16 path segments, and 500 characters per segment
or label. It counts toward the existing result byte budget. Providers validate the
supported shape. Generic clients can ignore presentation entirely; the typed
client ignores unknown or invalid presentation while still validating canonical
data. An unknown future kind is not a data failure.

Assistant renders up to 100 returned rows with scrolling and a notice when the
preview is capped. The full result remains in tool details. Existing `page`
metadata indicates additional server pages; do not duplicate pagination or invent
totals in presentation. No endpoint, widget, HTML, callback or mutation authority
is added.

### Result envelope

Every successful operation returns `data`. Add only the navigation and identity
metadata the caller can use:

```ts
type CapabilityResult<T> = {
  data: T;
  presentation?: TablePresentation;
  summary?: string;
  refs?: Array<{
    type: string;
    id: string;
    title?: string;
    preview?: string;
    icon?: string;
  }>;
  page?:
    | { hasMore: true; nextCursor: string }
    | { hasMore: false };
  links?: Array<{
    rel: "open" | "edit" | "status" | "preview" | "download";
    href: string;
    title?: string;
  }>;
};
```

Every result reference contains the stable identity fields `type` and `id`.
When the provider already knows a useful current label, it may add `title`, a
short plain-text `preview`, and an `icon`. These presentation fields are an
optional snapshot for generic clients; they do not participate in identity,
authorization, deduplication, or canonical-reader resolution. A bare
`{ type, id }` reference remains valid.

Prefer the name a person sees in the owning app: a mailbox name, note title,
contact name, or mail subject. Use `preview` only for concise secondary context
that helps distinguish similar resources. Use the Type's declared icon unless
the individual resource has a more specific stable icon. Do not copy IDs into
presentation fields, infer labels from unstructured content, or return stale
cached presentation when current authorized state is already available.

Use the optional `summary` for one concise, provider-authored description of a
successful result. Describe the outcome the user cares about, the readable
target, and any important resulting state. Prefer names and public labels from
the validated result or authorized domain state; do not expose internal IDs or
implementation steps.

For an Action, be specific about one changed field, and group several changes
into one readable result. For a successful single-resource Query, name what was
read, the resource kind, and its current readable name or label. Add current
state only when it changes how the user understands the result. Write the
complete result line, such as `Read message “Quarterly report”.`, rather than
returning only `Quarterly report`.

Do not promote a domain object's content summary into the top-level `summary`;
the top-level text describes the operation result. For list and search Queries,
omit `summary` when the structured results already communicate what matters.
Use it only when a bounded count or scope is itself the useful result.

Good summaries:

- `Added #customer to Reiner Schmiedt.`
- `Completed “Launch plan”.`
- `Read message “Quarterly report”.`
- `Read mailbox “Support” with 3 unread conversations.`

Bad summaries:

- `Updated tags successfully.` — it hides the affected person and actual tag.
- `Contact mutation completed.` — it describes an implementation step instead
  of the user's outcome.
- `Loaded item.` — it does not identify the resource.
- `Read message abc123.` — it exposes an internal identifier instead of a
  readable target.

The summary is trimmed, limited to 500 characters, persisted with the result,
and rendered as escaped plain text. Derive it from the operation's validated
result instead of asking an agent to describe what supposedly happened. Omit
it when the operation title and structured data already say everything useful.

Provider-owned `refs` use qualified declared Types. Foreign qualified refs are
opaque cross-app identities and need not be redeclared by the provider. An app
may enrich a foreign ref only when it has an authoritative user-facing label;
otherwise it returns the bare identity. Links are root-relative same-origin
Cloud paths. They are hints: a caller may open one, but an operation does not
require UI merely because it returns a link.
When `hasMore` is true, `nextCursor` is required; on the final page it must be
absent. Treat cursors as opaque values.

When a provider-owned Type advertises a reader, every returned `ref.id` for
that Type must be accepted by that reader. For a foreign ref, the foreign
Type's owning app defines whether and how it can be read. A ref never carries
or caches a reader name; consumers resolve it from the current owning app
manifest.

Keep result metadata non-overlapping. For one primary resource, return one
optionally presented top-level ref and its navigation in top-level `links`.
Do not repeat the same identity in a second resource array. For several
independently navigable presentation results, use `CloudResourceView[]` as
`data` so each title, ref, and link stays together. A rich domain list that must
retain app-specific fields may instead add optional semantic `links` directly
to each item. This keeps navigation next to the item without replacing the
domain result or making clients correlate parallel top-level arrays.

All result links are optional hints. Omit `links` when there is no stable,
useful Cloud destination, and omit the field instead of returning an empty
array. Clients must not require links for an operation to succeed. Do not invent
a generic app link for a resource that has no directly addressable UI, and do
not add another result field that duplicates both identity and navigation.
Domain-only operations may return `data` without links.

Failures use the normal structured service-error shape:

```json
{
  "code": "FORBIDDEN",
  "message": "Write access is required",
  "details": {}
}
```

For `VALIDATION_FAILED`, Core includes bounded `details.issues` entries with a
field path and message. Generic AI clients surface those entries so an agent
can correct one argument instead of repeating the unchanged call. Issue
details never include the rejected input value. Capability authors should
still make semantic requirements and ID provenance clear in field
descriptions; validation feedback is recovery, not primary documentation.

Framework errors include `VALIDATION_FAILED`, `SCHEMA_MISMATCH`,
`IDEMPOTENCY_KEY_REQUIRED`, `IDEMPOTENCY_KEY_NOT_ALLOWED`,
`IDEMPOTENCY_CONFLICT`, `IDEMPOTENCY_IN_PROGRESS`, `IDEMPOTENCY_UNCERTAIN`,
`APP_UNAVAILABLE`, `CAPABILITY_NOT_FOUND`,
`DEADLINE_EXCEEDED`, `ACTION_OUTCOME_UNKNOWN`, `REQUEST_CANCELLED`,
`INVALID_APP_RESPONSE`, and `RESPONSE_TOO_LARGE`. Applications may return their
own domain error codes. Provider failures accept the explicit HTTP statuses
`400`, `401`, `403`, `404`, `409`, `429`, `499`, `500`, `502`, `503`, and
`504`; other statuses fail closed as an invalid provider response.
Cloud resolves the human `message` of framework-owned failures from the
caller's request locale without changing the code, status, details, or retry
semantics. Provider-owned failures remain the application's responsibility and
must already contain their final localized message. Follow
[Product language and tone](/en/docs/build/product-language-and-tone) for
specific, recoverable error wording.
`DEADLINE_EXCEEDED` is retry-safe for Queries and required-idempotency Actions.
`ACTION_OUTCOME_UNKNOWN` means a non-idempotent
Action may already have taken effect and must not be retried automatically.
`INVALID_APP_RESPONSE` means the provider returned data outside its registered
contract; callers must not retry the same request unchanged. The provider logs
the validation path while the public error omits returned values. Once a
non-idempotent Action has been dispatched, a lost, unreadable, oversized, or
schema-invalid response is reported as `ACTION_OUTCOME_UNKNOWN`; clients must
not offer an automatic retry.

## Invoke capabilities

Core reads the live capability registry and dispatches every generic client
through the same path:

```text
GET  /api/capabilities/v1/catalog?limit=10&cursor=<appId>
POST /api/capabilities/v1/queries/<appId>/<localId>
POST /api/capabilities/v1/actions/<appId>/<localId>
POST /api/capabilities/v1/actions/<appId>/<localId>/review
```

OAuth callers need `read` or `admin` for the catalog, Queries, and Action
reviews, and `write` or `admin` for Actions. Sessions and API keys keep their
existing application authorization behavior. Scopes only cap the operation
kind; the owning app still enforces its domain permissions.

The public catalog contains only revalidated live manifests plus current app
name, icon, and description. Core derives the internal endpoint from the live
app registry; providers cannot publish a dispatch URL or trusted app metadata
inside the Capability record. Raw registry records are internal and are not a
consumer API.

The POST body contains one `input` field:

```json
{ "input": { "id": "k3P9xQ" } }
```

The optional review route accepts the same body and is available only when the
Action manifest advertises `review: true`. It performs no mutation and needs no
`Idempotency-Key`.

Send `Idempotency-Key` only when invoking an Action whose manifest requires it.
Core pins the registered schema and replaces the source credential with a
30-second invocation JWT bound to the target app, operation, mode, and schema
hash. The target verifies that token locally, reloads the current principal,
reconstructs the normal actor and access subject, validates the input, and
authorizes the resource. Cookies, API keys, and OAuth tokens never reach the
target app. Reviewing an Action never authorizes its later invocation.

A valid invocation for an outdated provider schema returns HTTP 409
`SCHEMA_MISMATCH`, not a login failure. Invalid JWTs or unavailable live authority
still return HTTP 401. Core includes `x-request-id` only when it is 1–200 visible
ASCII characters; invalid optional tracing metadata is dropped rather than
preventing a capability, search, or widget call.

Core also forwards the caller's resolved locale as invocation metadata in the
internal `x-cloud-locale` header, next to authorization and tracing. Query,
Action, and review handlers receive it as `context.locale` in their
`CapabilityExecutionContext` without declaring it in an input schema; without
a caller preference it falls back to the operator's `app.locale` default. Use
it only for human-facing formatting or optional message catalogs — stable
error codes and result data must not depend on it, and callers never need to
interpret provider message codes. See
[Locale and time](/en/docs/server/locale-and-time) for the resolution
contract and [Internationalize an application](/en/docs/build/internationalization)
for the message and error boundary.

Two more invocation-metadata fields reach every Query, Action, and review
handler on the same `CapabilityExecutionContext`:

| Field | Meaning |
| --- | --- |
| `context.requestId` | Correlation id of the originating Cloud request. The dispatcher reuses a valid incoming `x-request-id` and generates one otherwise, then forwards it unchanged to the app and stores it on the execution record |
| `context.origin` | Cloud surface that invoked the capability: `assistant`, `mcp`, `http`, or `app` |

Write `context.requestId` into the app's own audit rows. That is the join
between an app's domain trail and the platform execution record, and it works
without either side sharing payloads. Use `context.origin` for logging or
diagnostics only — never for authorization, because permission decisions belong
to the actor and access subject.

Browser and client islands use the same-origin public client:

```ts
import { invokeCapabilityWithDataSchema } from "@k2b/cloud/capabilities";
import { z } from "zod";

const itemSchema = z.object({ id: z.string().regex(/^[A-Za-z0-9]{6}$/), name: z.string() }).passthrough();
const result = await invokeCapabilityWithDataSchema(
  {
    appId: "inventory",
    capabilityId: "item.read",
    kind: "query",
    input: { id: itemId },
  },
  itemSchema,
);
if (!result.ok) throw new Error(result.error.message);
```

Only **Core-owned** code may pass verified `authority` for in-process dispatch.
It invokes Core's permission, review, idempotency, signing, and audit machinery;
this is not a credential bridge for independently deployed application hosts.
Never construct authority from JSON, tool arguments, workers, or browser state,
and never mix it with credentials, a mandate or `transport`.

Framework-owned execution hosts can supply a server-only `transport(request)`
to the capability client. It handles Queries, Actions, reviews, and binary
continuations through Core. Managed Assistant execution uses a short-lived,
Core-issued callback bound to its conversation and foreground turn. Core checks
the current account, conversation ownership and active turn on every callback.
The host refreshes this credential through Core's polling requests; it never
passes it to user code or persists it with tool arguments. Closed, cancelled or
background turns cannot use this callback. Ordinary application callers use
request credentials as shown below; background jobs use revocable mandates.

Server-side app code uses the Core-backed adapter. Pass only credentials and
trace data from the current request. The adapter sends them to Core's private
origin, where Core resolves the authority and dispatches a target-bound
invocation. Configure `CLOUD_CORE_INTERNAL_ORIGIN` to avoid a public
Gateway/ingress round trip:

```ts
import { invokeCapabilityWithDataSchema } from "@k2b/cloud/capabilities/server";

const result = await invokeCapabilityWithDataSchema(
  {
    appId: "inventory",
    capabilityId: "item.read",
    kind: "query",
    input: { id: itemId },
  },
  itemSchema,
  {
    cookie: request.headers.get("cookie"),
    authorization: request.headers.get("authorization"),
    requestId: request.headers.get("x-request-id"),
    signal: request.signal,
  },
);
```

Both clients return `{ ok: true, data }` or `{ ok: false, error }`; ordinary
network and protocol failures do not require exception handling. The untyped
`invokeCapability()` variant returns `unknown`; use a small permissive runtime
data schema at every typed consumer boundary. Use
`reviewCapabilityAction()` from the same entry point for an advertised Action
review. App tests may compile a declaration without importing Cloud internals:

```ts
import { compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
```

A durable worker uses the same server helper with an app workload credential
and its persisted mandate ID/revision. The helper sends both only to Core;
Core validates the current mandate, signs and dispatches the exact capability,
and returns the bounded result. It never returns the invocation JWT to the
worker. See
[Background authority mandates](/en/docs/identity/background-mandates) for the
complete lifecycle and example.

The generic CLI uses the same dispatcher:

```bash
cld capabilities catalog
cld capabilities read inventory.item k3P9xQ
cld capabilities query inventory item.read \
  --input '{"id":"k3P9xQ"}'
cld capabilities action inventory item.rename \
  --input '{"itemId":"k3P9xQ","name":"Dock"}'
```

The Capabilities playground at `/app/capabilities` lists the live catalog,
renders schema-driven inputs, invokes operations, and builds matching cURL
requests. It is a discovery and debugging surface, not the app's normal UI.

### Cloud MCP

The authenticated `/api/mcp/v1` endpoint projects the live catalog as MCP
tools:

```text
cloud__resource__read
inventory__query__item.read
inventory__action__item.rename
```

Queries become read-only tools. Query and Action `openWorld` values become
`openWorldHint`; Action metadata also becomes destructive and idempotent hints.
A generic client passes any returned typed ref unchanged to
`cloud__resource__read`; Cloud resolves the Type's current canonical reader
from the live manifest instead of requiring the client to discover or guess
the Query name.
A required idempotency key is a separate `idempotencyKey` tool argument. MCP
uses the same Core dispatcher and has no broader authorization or approval
contract.

> Cloud capability MCP exposes live application operations. Fibel MCP exposes
> read-only developer documentation. They are separate endpoints with separate
> purposes.

### Execution history

Every capability invocation is recorded once, by the dispatcher, in the
platform-owned `capabilities.executions` table. The assistant, MCP, the
Capabilities workspace app, and app-to-app mandate calls all produce the same
row, so operators read one history instead of one per surface. An Action review
is a read-only preview and is not an execution, so it is not recorded.

A row holds correlation and shape, never payloads: `request_id`, `origin`,
`app_id`, the qualified `capability`, `kind`, the declared `destructive` flag,
the acting principal and the access subject when they differ, `status`,
`error_code`, the input and output shape metadata, an optional
`idempotency_key`, whether the row was `replayed` from an idempotency claim,
and start, end, and duration.

| Status | Meaning |
| --- | --- |
| `succeeded` | The app returned a valid result |
| `invalid_input` | Input failed schema, idempotency, or envelope validation |
| `denied` | The caller was not authorized for this capability |
| `rejected` | A user declined the Action approval, so it never ran |
| `timed_out` | The app did not answer within the capability deadline |
| `failed` | Any other failure, including app errors and cancellation |

Origins are `assistant`, `mcp`, `http`, and `app`. Retention is bounded: Cloud
prunes execution rows older than 90 days.

Operators read this history at
[Observability](/en/docs/operations/observability). Applications never write to
this table; they record their own domain effects with
[Audit events](/en/docs/platform/audit-events) and correlate them through
`context.requestId`.

## Open an interactive flow with Commands

A **Query** reads, an **Action** changes domain state, and a **Command** opens an
application-owned interface. Declare Commands beside Queries and Actions. Their
local IDs share the same namespace, so use distinct IDs such as `task.compose`
for a form and `task.create` for a mutation.

```ts
const ComposeInput = z.object({
  spaceId: z.string().optional().describe("Optional destination Space ID."),
}).strict();

const capabilities = defineCapabilities({
  protocolVersion: 2,
  commands: {
    "task.compose": {
      title: "New task",
      description: "Create a task in Spaces.",
      icon: "ti ti-checkbox",
      keywords: ["todo"],
      input: ComposeInput,
      path: "/app/spaces",
    },
  },
});
```

The path must belong to the application's live registered routes. Resolution
validates the declared input and returns a URL based on the `app.url` setting
(`APP_URL`), never the caller's browser origin. It does not call an app handler,
create a record, or authorize a later mutation. The destination page and its
normal services still check access. Commands are not mutating AI tools.

Resolve a link from another application or an external client:

```ts
import { resolveCommand } from "@k2b/cloud/capabilities";

const result = await resolveCommand("spaces.task.compose", { spaceId: "AbCd12" }, {}, {
  baseUrl: "https://cloud.example/api",
  headers: { authorization: `Bearer ${token}` },
});
if (result.ok) console.log(result.data.href);
```

The HTTP equivalent is `POST /api/capabilities/v1/commands/:appId/:localId`
with `{ "input": {} }`, returning `{ "href": "https://…" }`. It requires an
authenticated caller with read scope. Invalid input returns 400, missing
Commands 404, and unavailable or mismatched route owners 503.

For an in-browser interaction, use `openCommand`:

```ts
import { openCommand } from "@k2b/cloud/browser/commands";

await openCommand("spaces.task.compose", {
  source: { type: "mail.conversation", id: "AbCd12" },
});
```

Register a handler in the island that owns the form. Use the same input schema
as the declaration and dispose registrations when their owner unmounts:

```ts
import { consumeCommandLink, registerCommandHandler } from "@k2b/cloud/browser/commands";
import { onCleanup, onMount } from "solid-js";

onMount(() => {
  onCleanup(registerCommandHandler("spaces.task.compose", ComposeInput,
    (input) => openTaskForm(input),
    (input) => !input.spaceId || input.spaceId === currentSpaceId(),
  ));
  void consumeCommandLink();
});
```

`openCommand` offers the request to mounted handlers synchronously. Exactly one
accepting handler owns it; with no owner Cloud resolves the link and navigates.
Overlapping owners produce an error before either runs; use `accepts` to keep ownership unambiguous.
A rejected handler surfaces an error and never triggers fallback navigation.
Document events connect independent islands without a shared Solid context.
`consumeCommandLink` consumes the URL parameters before handing control to the
form, so reload and Back do not reopen a consumed interaction. It reports
invalid or unavailable entries and clears their parameters as well, so reloading
does not repeat the error. It never silently invokes a different Command.
An unhandled handler rejection is displayed once with its message. A handler
that presents its own inline error and retry should handle that failure itself.

Keep URL input to small public references and options. Links are limited to
8 KiB; do not put message bodies, calendar files, tokens, or secrets in them.
The receiving app reads referenced resources with the current user's authority
and shows the source visibly before submission.

An optional `{ returnTo: "/app/contacts?contact=AbCd12" }` may be supplied as the
third argument. Only internal root-relative paths are accepted. The destination
app decides when returning makes sense, normally after completion or explicit
cancellation. This is a return link, not a webhook or cross-page callback.
Omit it when users should stay with their newly created content.

Localize titles, descriptions, and input field descriptions under
`presentation.translations.<locale>.commands`, keyed by local Command ID.
Follow the palette's [action wording guidance](/en/docs/platform/search#write-distinct-action-titles-and-useful-descriptions)
so users can distinguish actions by scope and understand what each one opens.

### Calendar Command entry points

Mail and Spaces expose two context-dependent Commands. Neither accepts an
empty input, so they do not crowd the global action catalog.

| Command | Input | Interface |
| --- | --- | --- |
| `mail.draft.calendar` | `{ mailboxId, draftId }` | Attach an event to this existing Mail draft |
| `spaces.event.invite` | `{ itemId, method?: "request" \| "cancel" }` | Prepare an invitation, update or cancellation for this event |

IDs are public resource IDs. Opening a Command checks access and opens the
existing form; it does not send mail. Mail keeps the same draft, recipients and
attachments and uses its existing edit lease and revision checks. Spaces owns
the event and invitation sequence; Mail owns the resulting draft and sending.
Use `returnTo` only when there is a useful originating view to return to.

The Mail composer also offers its calendar action for an unsaved draft. It
saves through the existing composer flow before opening the inline event form.
A save or lease failure leaves the user in the composer. Incoming invitation
import, RSVP draft preparation and linking a conversation to an existing
Spaces item remain local context actions with their existing selectors and
confirmation steps.

## Binary streams

A Query or Action can optionally return one `stream` alongside its ordinary
`data`, references and links. Use this for binary content that does not fit the
256 KiB JSON result budget. The same contract supports a file download, an
invoice PDF, audio or an archive import. Resource Types do not prescribe a
format, and consumers must discover the operation's input schema.

Declare `stream: { direction, maxBytes, ...handlers }` on the operation. A read
Query implements `read(descriptor, context): Promise<Response>`. A write Action
must require idempotency and implement:

- `write(descriptor, body, context)`: consume the `ReadableStream<Uint8Array>`
  completely, validate it, then publish and return a normal capability result.
- `status(descriptor, context)`: return `{state:"open"}`, `{state:"aborted"}` or
  `{state:"completed", result}` with the same result schema as the Action.
- `abort(descriptor, context)`: discard an unfinished transfer. Preserve an
  already completed result; the framework reads status after aborting.

The operation's `run` returns a descriptor with `id`, `direction`, `mediaType`,
`size` (exact byte count), `expiresAt` (ISO timestamp), and optional `name`.
The provider's ID identifies an authorized source revision or a durable upload
reservation. Core replaces it with an encrypted, caller-bound reference. The
manifest publishes direction and maximum bytes and includes them in the schema
hash. Expiry must be in the future and at most 24 hours away.

Handlers receive the original descriptor and a freshly authenticated execution
context. Check current resource permissions in **every** handler. Keep source
identity/revision and destination/conflict policy in the reservation, not in
caller-supplied transfer parameters. Serialize concurrent writes to the same
reservation and reconcile retries from its durable receipt. A write response
must not promise success before publication. Do not emit another stream from a
write receipt.

Consumers use `transferCapabilityStream(ref, "read" | "write" | "status" |
"abort")` from `@k2b/cloud/capabilities`; the server counterpart accepts the same
`CapabilityCaller` as ordinary invocation. Read returns binary bytes; the other
verbs return JSON. Writes supply `body` without encoding it as JSON or base64.
The HTTP endpoint is `POST /api/capabilities/v1/streams/{verb}` with the opaque
reference in `x-cloud-stream-id`. Never put it in a URL or log it.

Transfers preserve backpressure, propagate cancellation and enforce the exact
byte count even without `Content-Length`. Each request has a five-minute
transport deadline. No write is retried automatically: after a lost response,
inspect status before deciding whether to resume or prepare a new operation.
Expiry also limits status and abort; providers must reclaim abandoned
reservations independently. Keep receipts for their domain recovery period.

References require the same caller and credential scope, an unchanged live
operation schema and current provider access. Possessing a reference alone
cannot invoke a different operation. This initial stream contract supports
interactive and service-account authority; mandate-backed background
invocations of streaming operations fail before execution. Existing operations
without streams retain their contracts.

Assistant code mode exposes `capabilities.streams.read/write/status/abort`.
`read` returns a `File`, and `write` accepts a `Blob`, string, `ArrayBuffer` or
`Uint8Array`. It uses only references returned by that run's approved
`capabilities.run` calls. The existing runtime budget applies: 50 MiB per
payload and 250 MiB across transfers, with at most 64 references per run.
HTTP and CLI clients may use the provider's larger advertised limit.

Provider IDs are limited to 2 KiB of UTF-8; use a stored reference for long
paths. Core's sealed reference is bounded to 8 KiB. Treat provider IDs as
untrusted selectors even on an authenticated invocation and authorize them
against the actor. Replaying an idempotent Action returns its original grant
and does not extend its lifetime. After expiry, use the app's recovery API or
prepare a new Action with the current conflict policy.

Stream read/write attempts have separate execution rows linked by the original
request ID. They record direction, outcome and byte count without recording the
content or stream reference. A read completes only when its body has been
consumed; canceling it records an interrupted transfer.
