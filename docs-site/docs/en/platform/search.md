---
title: Universal search
navTitle: Universal search
section: Platform services
order: 560
description: Project focused application Queries into the shared Cloud search.
tags: [search, capabilities, authorization]
updated: 2026-08-13
---

# Universal search

Universal Search is an optional projection of ordinary capability Queries.
The application searches its own data and returns only resources the current
access subject may read. Cloud discovers live providers, fans out the query,
and merges their results.

Read [App capabilities](/en/docs/platform/capabilities) first for the shared
Type, Query, schema, result, registry, and authorization rules.

## Add a search Query

An app may expose multiple Queries through Universal Search. Each must use the
exact shared input and data schemas. Add the Queries to the application's
`src/capabilities.ts` module. The surrounding capability declaration still
owns the resource Type; the excerpt below shows only the search-specific part.

```ts
import { defineCapabilities } from "@valentinkolb/cloud";
import {
  UniversalSearchDataSchema,
  UniversalSearchInputSchema,
} from "@valentinkolb/cloud/contracts";
import { ok } from "@k2b/stdlib";

export const inventoryCapabilities = defineCapabilities({
  protocolVersion: 1,
  types: {
    item: {
      title: "Inventory item",
      description: "One item in the inventory catalog.",
    },
  },
  queries: {
    search: {
      title: "Search inventory",
      description: "Find visible inventory items by name.",
      input: UniversalSearchInputSchema,
      data: UniversalSearchDataSchema,
      openWorld: false,
      universalSearch: {
        tags: [
          {
            tag: "inventory",
            title: "Inventory",
            description: "Search inventory items.",
            aliases: ["stock", "sku"],
          },
        ],
      },
      run: async ({ query, limit }, context) => {
        const items = await inventory.search({
          query,
          limit,
          accessSubject: context.accessSubject,
        });

        return ok({
          data: items.map((item) => ({
            ref: { type: "inventory.item", id: item.id },
            title: item.name,
            preview: `${item.quantity} in stock`,
            icon: "ti ti-package",
            priority: 7,
            metadata: [{ label: "Type", value: "Inventory item" }],
            links: [
              { rel: "open", href: `/app/inventory/items/${item.id}` },
            ],
          })),
        });
      },
    },
  },
});
```

Add a canonical reader separately when clients must also load a known item by
its ref. Pass the declaration to `app.start({ capabilities, fetch })` as
described in [App capabilities](/en/docs/platform/capabilities).

## Follow the search contract

`UniversalSearchInputSchema` provides:

| Field | Meaning |
| --- | --- |
| `query` | User-entered text; may be empty when a facet narrows the search |
| `tags` | Canonical facets supported by this Query |
| `limit` | Maximum results this provider may return |

Each returned resource must:

- use a Type declared by the app;
- have a stable [public resource ID](/en/docs/data/public-resource-identifiers);
- include at least one root-relative `open` link;
- contain only information the current access subject may read;
- stay within the requested limit.

Cloud preserves each structured `CloudResourceRef` in the merged result. If
the referenced Type advertises a canonical reader, the search result's
`ref.id` must work unchanged as that reader's required `id`. A consumer can
therefore keep the ref and resolve the current reader later without storing a
Capability name.

Searchability does not require a reader. A Type without one may still return a
navigable search result with an `open` link, but consumers must not present it
as programmatically readable. Search and read remain separate Queries: search
finds bounded resource views; the Type's reader loads one known resource.

Use `preview`, `icon`, `priority`, and `metadata` only when they help identify
the resource. A `preview` semantic link lets Cloud load a separate preview
surface.

Tags and aliases help users and agents discover providers. They are not
permissions. Use stable, lower-case values without `#`, and keep each meaning
unique within the app.

Prefer one focused provider per stable resource kind when that removes
app-local routing or result-merging code. Keep one provider when tags are only
facets or aliases of the same search. Cloud discovers every opted-in Query
directly from the live capability manifest; apps do not register a separate
search wrapper. Merged results are capped per app, so multiple focused Queries
do not give one app a larger share of the global result set.

## Authorize every result

The shared `/api/search` route requires a user-backed actor. The provider still
authorizes every resource with `context.accessSubject`; never return a result
and rely on its destination page to hide it later.

The same Query can also be invoked through the generic capability HTTP, CLI,
or MCP surface. Those calls follow normal capability authentication and may
use a service-account access subject. The application must handle the subject
types it supports explicitly.

Resolving a reader is not authorization. Consumers use the current live
manifest, and the owning app checks the current `AccessSubject` again when the
reader runs.

See [Resource authorization](/en/docs/identity/authorization).

## Keep app-specific search separate

Universal Search is a projection, not the only search operation an app may
publish. Add other Queries for app-specific list, filter, lookup, or exhaustive
traversal semantics when they have a stable cross-client use.

Cloud ranks results by app-provided priority and title after merging providers.
One provider failure does not fail the complete search: successful providers
still return partial results with HTTP 200. A shared registry or invocation
signer failure returns HTTP 503, not a successful empty result. Log provider failures
with [structured logging](/en/docs/platform/logging); the application's domain
database remains the source of truth.

## Let a user choose a Cloud resource

Use `openCloudResourcePicker` from
`@valentinkolb/cloud/browser/resource-picker` when an application needs a
stable `CloudResourceRef` selected from any searchable Cloud application. The
picker groups the existing Universal Search results by their owning app,
supports an app filter, and returns the selected resource view. Store the
structured `ref`; treat its title, preview, and links as presentation data.
Set `requireReader` when the consumer must resolve the selected resource later,
as AI Project references do.

```ts
import { openCloudResourcePicker } from "@valentinkolb/cloud/browser/resource-picker";

const selected = await openCloudResourcePicker({
  title: "Add Cloud reference",
  excludeRefs: currentReferences,
  requireReader: true,
});

if (selected) await saveReference(selected.ref, selected.title);
```

The shared `/api/search` route accepts one optional `app` query parameter to
limit provider fan-out and returns the searchable app catalog with each
response. `require_reader=true` removes navigation-only resources before
result limits are applied. An empty unscoped request returns only the app
catalog without calling providers. The picker owns this platform-specific
discovery UI; `@k2b/ui` remains independent of Cloud applications and resource
contracts.
