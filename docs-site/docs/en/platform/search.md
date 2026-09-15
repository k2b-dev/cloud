---
title: Universal search
navTitle: Universal search
section: Platform services
order: 560
description: Project focused application Queries into the shared Cloud search.
tags: [search, capabilities, authorization]
updated: 2026-09-15
---

# Universal search

Universal Search is an optional projection of ordinary capability Queries.
The application searches its own data and returns only resources the current
access subject may read. Cloud discovers live providers, fans out the query,
and merges their results.

Read [App capabilities](/en/docs/platform/capabilities) first for the shared
Type, Query, schema, result, registry, and authorization rules.

## Add static page links

For utility pages such as a QR generator, add `searchLinks` to `defineApp()`:

```ts
searchLinks: [
  {
    label: "QR code generator",
    description: "Turn links and text into QR codes.",
    href: "/tools/qr",
    icon: "ti ti-qrcode",
    keywords: ["qr", "barcode", "scan"],
  },
],
```

These links appear only in the global search dialog, below all resource
results. Cloud includes them when the app is visible in the user's navigation
catalog. The browser matches every search word against the label, description, and keywords,
ignoring case, after at least two characters. An initial application scope applies; tag searches omit static links.

Use same-origin paths and public page labels. Destination routes still enforce
their own authorization. Localize labels with
`presentation.translations.<locale>.searchLinks`, keyed by `href`, and include
alternate search terms in `keywords`.

An optional plain-text `description` appears below the result title and in its
preview. Localize it with
`presentation.translations.<locale>.searchLinkDescriptions`, also keyed by `href`.
Both labels and descriptions fall back through the requested locale to the base
declaration. Links without descriptions continue to work.

Static links create no agent capabilities or resource readers and do not appear
in `/api/search` or resource pickers. Use a search Query for dynamic application
data instead.

## Add a search Query

An app may expose multiple Queries through Universal Search. Each must use the
exact shared input and data schemas. Add the Queries to the application's
`src/capabilities.ts` module. The surrounding capability declaration still
owns the resource Type; the excerpt below shows only the search-specific part.

```ts
import { defineCapabilities } from "@k2b/cloud";
import {
  UniversalSearchDataSchema,
  UniversalSearchInputSchema,
} from "@k2b/cloud/contracts";
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

## Search in the browser

Global search and the resource picker share one search interface. Start typing
or choose **All filters** to discover tags. Typing `#` shows matching filters
inside the result area. Suggestions list each canonical tag once and match
its aliases. Enter or a click applies a filter; Tab keeps normal focus navigation.
A typed tag is committed with whitespace. An unfinished tag does not trigger an
unsupported-filter warning.

Results are grouped by application. Desktop search shows a preview beside the
input and result list. The centered dialog keeps its width and top position across search
states, growing downward until its content needs to scroll.
On small screens, **Details** opens the preview and
**Back to results** returns to the list. Escape first leaves filter discovery
or mobile details, then closes the dialog. Scroll fades indicate more content.

In global search, Cmd+Enter (macOS) or Ctrl+Enter opens the active result in a
new tab while preserving the query, filters, and selection. Modified clicks
have the same effect. Ordinary Enter and clicks navigate in the current tab.
The browser decides whether to focus the new tab.

On desktop screens at least 64rem wide with a mouse and no touch input,
drag the outer edge of Spotlight to place it beside the page. Detached search
allows background interaction without blur. Its position is stored locally in
this browser and kept within the viewport when resized or reopened. Drag near
the original centered position to snap back and restore the modal backdrop;
double-click an edge to reset directly. A subtle dashed outline marks the home
position while dragging. You can place the compact search near the bottom;
results grow upward when there is no room below, then return to the preferred
position when the search shrinks. Escape during a drag cancels that drag.
On smaller or touch screens the search stays modal. Resource pickers always
retain their modal selection behavior.


Global search opens a result on click or Enter. The picker selects it first;
**Add** confirms the choice. While a new resource search loads, earlier results
remain visible but cannot be selected for the new query.

## Let a user choose a Cloud resource

Use `openCloudResourcePicker` from
`@k2b/cloud/browser/resource-picker` when an application needs a
stable `CloudResourceRef` selected from any searchable Cloud application. The
picker groups the existing Universal Search results by their owning app,
supports tag filters, and returns the resource view after the user selects
a result and confirms with **Add**. Store the
structured `ref`; treat its title, preview, and links as presentation data.
Set `requireReader` when the consumer must resolve the selected resource later,
as AI Project references do.

```ts
import { openCloudResourcePicker } from "@k2b/cloud/browser/resource-picker";

const selected = await openCloudResourcePicker({
  title: "Add Cloud reference",
  excludeRefs: currentReferences,
  requireReader: true,
});

if (selected) await saveReference(selected.ref, selected.title);
```

The shared `/api/search` route accepts one optional `app` query parameter to
limit provider fan-out and returns the searchable app catalog with each
response, including canonical tag names, titles, descriptions, and aliases.
Tag presentation follows the request locale. The browser uses this catalog for
both search dialogs; there is no application dropdown. `initialAppId` still
starts a picker within one application, shown as a removable scope chip.
`require_reader=true` removes navigation-only resources before
result limits are applied. An empty unscoped request returns only the app
catalog without calling providers. The picker owns this platform-specific
discovery UI; `@k2b/ui` remains independent of Cloud applications and resource
contracts.
