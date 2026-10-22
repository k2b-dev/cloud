---
title: Save maps in Notebooks
navTitle: Saved maps
section: Platform services
order: 560
description: Save Geo results and routes as portable, permission-aware Notebook map blocks.
tags: [geo, maps, notebooks, routes]
updated: 2026-10-22
---

# Save maps in Notebooks

Use `GeoDocumentSchema` and `serializeGeoDocument` from
`@k2b/cloud/geo/document` when an application saves Geo results in a Notebook.
The result is a `:::map` block. Save it with the existing Notebook capabilities;
the normal Notebook permissions, note lock and revision checks apply.

```ts
import { serializeGeoDocument } from "@k2b/cloud/geo/document";

const markdown = serializeGeoDocument({
  version: 1,
  title: "Afternoon walk",
  pins: places.map(place => ({
    id: place.id,
    label: place.name.slice(0, 300),
    point: place.point,
    provenance: place.provenance,
  })),
});
```

`places` comes from a successful `place.search` result. Preserve its coordinates
and provenance; do not infer coordinates from generated text. Obtain addresses
and routes through the [Geo Queries](/en/docs/platform/places-and-maps).

## Document format

A document is a strict object with `version: 1`, a nonempty `title` of at most
300 characters, `pins`, and an optional complete `route` from `route.calculate`
or `route.update`. Set the optional ISO `savedAt` timestamp when saving; without
it, the route summary labels the provenance date as its calculation date.
Keep all route fields, including stops, legs, options,
geometry, input hash and provenance. Reading or saving a document does not
recalculate the route. A route-only document has an empty `pins` array.

A map holds up to 20 pins, matching one place-search result. Each pin carries a
unique `id` of at most 2048 characters, matching a Geo place ID, a nonempty `label` of at most 300
characters, `point`, `provenance` and an optional `link`.

| Link type | Required fields |
| --- | --- |
| `url` | `url` using HTTP or HTTPS, and `label` |
| `note` | `noteId` and `label` |
| `heading` | `noteId`, `heading` and `label` |

Note IDs are six-character Notebook short IDs. `heading` is the exact anchor
returned by the authorized Notebook block-preview endpoint, including its
`heading-` prefix and any duplicate suffix. Links address the same Notebook;
users can open a linked note only with the normal Notebook permissions.

The serializer validates the document and escapes JSON so a label cannot end
the directive or create HTML. Keep the block at document level, outside code,
quotes and lists. Malformed blocks show a diagnostic and their source.

## Read, edit and export

Notebooks displays saved documents using public `CloudMap`. In a writable,
unlocked note, `/map` inserts a new block. Place search adds pins after link
confirmation; cancel leaves the block unchanged. Changes pass through the
existing collaborative document. A concurrent change to that block prevents
applying an outdated edit.

The server resolves Geo availability under the reader's identity for Book and
block previews. Without configuration or budget, saved pins and routes remain
as source-attributed lists. Only platform administrators receive the setup or
budget-settings link. The browser can retry failed requests and switch to a
list without changing the saved document.

PDF export includes linked pin and route lists with sources. It reports a
`not_rendered` omission of kind `map` when a static map image is unavailable.
The current public map API does not supply static map images.
