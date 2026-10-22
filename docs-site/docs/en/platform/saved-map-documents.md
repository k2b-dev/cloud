---
title: Save maps in Notebooks
navTitle: Saved maps
section: Platform services
order: 561
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

For notes with maps, the PDF preview places **Print** and **Download PDF** in
the header above a white document sheet. Optional **PDF format** settings sit
below the preview and start collapsed. Notes without maps keep the existing
export dialog with format settings first.

The PDF dialog prepares complete map images in a document preview. Print and
PDF wait for all images. The browser captures the fitted saved maps through
`CloudMap`; cancellation stops pending work. Missing tiles, glyphs or map access
produce a visible failure with retry and an explicit source-list alternative.
The dialog's Print action also includes ordinary note images and waits for them
to load. Closing the dialog cancels preparation; a failed image leaves a visible
error so the reader can retry. PDF downloads continue to prepare offline images
through the authorized server export path.

Native browser printing uses the labelled source-list fallback if no image was
prepared. Headless exports also retain linked pin and route lists and report a
`not_rendered` omission of kind `map`.

The authenticated `POST /api/notebooks/:id/notes/:noteId/pdf/maps` endpoint
accepts multipart `input` (the existing PDF JSON payload), `mapSnapshots` and
binary map parts defined by the [snapshot contract](/en/docs/platform/pdf-and-templates#upload-browser-map-snapshots).
Like the existing JSON PDF endpoint, it exports the caller's current Markdown
snapshot, including unsaved changes, after authorizing read access to the note.
It derives the revision from SHA-256 of the exact UTF-8 Markdown bytes and block
IDs from their one-based source lines (`line-17`), then checks each complete
GeoDocument fingerprint and decodes the PNGs before offline PDF conversion.
Client pixels are used only in that caller's export and are never saved as
Notebook data. HTML, attachments and map images share the PDF input budget.
