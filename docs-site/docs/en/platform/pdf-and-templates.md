---
title: PDF and templates
navTitle: PDF and templates
section: Platform services
order: 590
description: Render documents from application data with shared template and PDF services.
tags: [pdf, templates, gotenberg]
updated: 2026-10-22
---

# PDF and templates

Cloud can render HTML as PDF through the deployment's Gotenberg service.

The application owns the document data and HTML. Cloud owns connection
settings, authentication, timeouts, and size limits. Operators set the
Gotenberg URL in the `gotenberg.url` setting or bootstrap it with
`GOTENBERG_URL`; without it, rendering fails with the `not_configured` code.

The **Max input bytes** setting (`gotenberg.max_html_bytes`, default 1 MiB)
limits HTML, headers, footers, images and fonts together in one render request.
The request timeout (`gotenberg.timeout_ms`) is also capped by Gotenberg's own
`--api-timeout` (default 30 s).

## Render HTML

```ts
import { renderHtmlToPdf } from "@k2b/cloud/services";

const result = await renderHtmlToPdf({
  html: "<!doctype html><html><body><h1>Stock report</h1></body></html>",
  title: "Stock report",
  headerHtml: null,
  footerHtml: "<p>Inventory</p>",
});

return new Response(result.pdf, {
  headers: {
    "Content-Type": result.contentType,
    "Content-Disposition": 'attachment; filename="stock-report.pdf"',
  },
});
```

`html` is required. `headerHtml` and `footerHtml` are optional.

`title` is the document title that PDF viewers show in their tab or window,
usually the document's name. The HTML's own non-blank `<title>` takes
precedence. Pass a title whenever the HTML may lack one: without either,
viewers show the random file name the renderer gave the upload.

Cloud sends the HTML to Gotenberg with background printing and CSS page sizes
enabled. The result contains PDF bytes and the returned content type.

All render, merge, and embedding requests share two Gotenberg places across
applications and replicas. Admission does not queue; saturation or unavailable
Valkey raises `GotenbergRenderError` with code `busy` and status 503. Offer retry
when a place is available. Preserve the `busy` code and HTTP 503 through
rendering, merging, and template previews so callers can offer retry. The
existing render timeout also bounds admission; `options.signal` cancels
admission, the request, and response reading. Local application limits still
protect process memory. See
[Scaling and shutdown](/en/docs/operations/scaling-and-shutdown) for deployment
requirements and upgrade behavior.

## HTML renders offline

Cloud renders every HTML document, header, and footer offline, including
Markdown, Liquid templates, and Factur-X invoices. Before the HTML reaches
Gotenberg, Cloud removes scripts, `noscript` content, frames, embedded
objects, `base` and `meta` elements, links other than stylesheets, and the
MathML (`math`) and SVG (`foreignObject`, `desc`) elements that hold HTML. It
then adds a Content Security Policy that allows inline styles, plus named
assets and `data:` URLs for stylesheets, images, and fonts.

As a result, JavaScript does not run and remote URLs are not loaded. Pass
images, fonts, and CSS as named `assets` or embed them as `data:` URLs.
Hyperlinks stay clickable in the PDF, and inline SVG shapes and images still
render. The rendering mode stays the caller's: a leading doctype still
applies, and HTML without one renders in quirks mode.

## Render untrusted Markdown

Use `renderMarkdownToPdf()` for a deterministic Markdown document with a
code-owned print preset:

```ts
import { renderMarkdownToPdf } from "@k2b/cloud/services";

const result = await renderMarkdownToPdf({
  markdown: "# Stock report\n\n| Item | Remaining |\n| --- | ---: |\n| Cable | 4 |",
  title: "Stock report",
  templateId: "report",
  customCss: "h1 { color: #244f75; }",
});
```

The available A4 presets are `document`, `report`, and `compact`. Optional
`customCss` is applied after a selected preset and can override it. Omit
`templateId` to use custom CSS as the complete stylesheet; omit both fields to
use `document`. CSS is limited to 32 KiB. Raw HTML stays inert. Markdown image
references become safe links, so the renderer never fetches them. CSS imports,
URLs, and other external resources are rejected. The document then goes
through the same bounded, offline HTML renderer as any other HTML, so a
Markdown PDF fetches nothing. Markdown has no `<title>`, so pass `title`, such
as the note or file name, for PDF viewers to show.

### Render your own Markdown dialect

`renderMarkdownToPdf()` knows GitHub-flavored Markdown and the shared
[info blocks](/en/ui/content/markdown#info-blocks) (`:::note`, `:::warning`,
and the other types). They print with a type icon and a light tint. The icon
and title use the tone colour; body text keeps the preset's text colour. When
the application's documents use their own blocks, render them with the
application's renderer and wrap the resulting HTML with
`buildPresetPdfHtml()`:

```ts
import { buildPresetPdfHtml, renderHtmlToPdf } from "@k2b/cloud/services";

const html = buildPresetPdfHtml({
  html: renderNoteHtml(note),
  templateId: "document",
  css: ".callout { border-left: 4px solid #2563eb; }",
  customCss: input.customCss,
});
const result = await renderHtmlToPdf({ html, title: note.title });
```

It applies the same presets and `customCss` rules as `renderMarkdownToPdf()`.
`html` becomes the document body as given, except for `<wbr>` break
opportunities in long table-cell runs, so text that the application replaces
afterwards must not rely on staying contiguous inside table cells.
Sanitize it in the application renderer. `css` styles the application's own
elements. It comes after the preset and before `customCss`, so a person's
custom CSS can still override it.
With `customCss` but no `templateId`, `css` still applies while the preset is
left out. The print styles for info blocks come with every document, before
`css`, so an application renderer that emits info blocks through
`renderMarkdownInfoBlock()` from `@k2b/ui` prints them like Markdown PDFs.

In every document (each preset, no template, or custom CSS only), table cells
keep words whole so short values such as `Nr.` stay on one line; custom CSS
can override the cell rule. Words of up to 20 characters stay whole; a longer
run without a space, such as a long URL or code, gets a break opportunity every
10 characters so the table fits the page. Because words stay whole, a table
with many columns of long words can still be wider than the page; split it or
let custom CSS break cells anywhere.

The result renders offline like any other HTML: the offline policy replaces
the Content Security Policy that `buildPresetPdfHtml()` writes. `html` and
`css` can therefore embed images and fonts as `data:` URLs or reference files
passed as `assets` to `renderHtmlToPdf()`. Remote URLs still do not load, and
`customCss` still cannot load any resource.

The service owns conversion only. Callers still own authentication,
authorization, request limits, filenames, response headers, and persistence.

`MarkdownPdfError.code` is `bad_input`, `invalid_css`, or
`external_asset_unsupported`. These errors are safe to translate into a
bounded caller-owned API response. Gotenberg failures continue to use
`GotenbergRenderError`.

## Render a Liquid template

Use `renderLiquidTemplate()` from `@k2b/cloud/shared` to render text or HTML
in the server or browser. Its `LiquidTemplateOptions` separate time and size
budgets:

| Option | Default | Budget |
| --- | --- | --- |
| `renderTimeoutMs` | `1_000` | Milliseconds per render |
| `renderMaxBytes` | `300_000` | UTF-8 bytes of final output; captures use the larger of this cap and 300,000 bytes |
| `memoryLimit` | `2_000_000` | LiquidJS allocation units for ranges and filters, plus expanded text added by array-building filters |
| `templateMaxBytes` | `200_000` | UTF-8 bytes of template source |

Time and output limits are enforced during rendering; output exactly at the
byte limit is allowed. Rendering is synchronous and blocks the application's
event loop. Time checks run on each template, loop iteration (including
empty bodies), filter call, and operator. Custom filters must finish promptly:
a synchronous filter cannot be interrupted, and its elapsed time is checked
when it returns.

`LiquidTemplateError.reason` identifies budget failures as `render_timeout`,
`render_too_large`, or `render_memory_limit`. Other syntax, variable, and
filter errors remain ordinary rendering errors. Applications may pass their
existing output budgets through `renderMaxBytes` without changing the time
budget. Array-building filters (`push`, `concat`, `unshift`, and `map`) also
charge `memoryLimit` for the expanded text they add.

Use `renderTemplatePdfPreview()` when an operator edits a Liquid template and
needs one structured result for both template and PDF errors:

```ts
const preview = await renderTemplatePdfPreview({
  htmlTemplate: "<h1>{{ item.name }}</h1>",
  pageCssTemplate: "@page { size: A4; margin: 20mm; }",
  data: { item },
});

if (!preview.ok) {
  return c.json(preview.error, preview.error.status);
}

return new Response(preview.pdf.pdf, {
  headers: { "Content-Type": preview.pdf.contentType },
});
```

The input may include header, footer, and page CSS templates, and a `title`
that names the PDF when the rendered HTML has no `<title>`. It also accepts
custom Liquid filters. The rendered body, header, footer, and page CSS render
offline like any other HTML.

The result separates the `template` phase from the `pdf` phase. Template
budget failures include `code: "render_timeout"`, `"render_too_large"`, or
`"render_memory_limit"`, matching `LiquidTemplateError.reason`. Do not expose
template stack traces to end users.

## Merge PDFs

`mergePdfs()` accepts one or more `Uint8Array` PDF files and returns one PDF.
Cloud preserves input order.

An empty file list fails with `bad_input`.

## Handle renderer errors

`GotenbergRenderError.code` is one of:

| Code | Meaning |
| --- | --- |
| `busy` | Both shared renderer places are occupied, or admission is unavailable; retry later (503) |
| `bad_input` | A PDF merge request has no files |
| `not_configured` | The renderer URL or limits are invalid |
| `html_too_large` | HTML exceeds the deployment limit |
| `pdf_too_large` | Output exceeds the deployment limit |
| `request_failed` | The renderer could not be reached |
| `bad_response` | The renderer returned an unsuccessful response |
| `timeout` | The request exceeded its timeout |

Treat configuration and availability failures as operational errors. See
[Runtime configuration](/en/docs/operations/runtime-configuration) and
[Troubleshooting](/en/docs/operations/troubleshooting).

Authorize access to the document data before rendering.


## Assets, paper options and file attachments

`renderHtmlToPdf` also accepts `assets: Array<{ name, data: Blob }>`, `tagged`,
and `page: { format, landscape, margin: { top, right, bottom, left } }`.
Supported formats are A4, A3, A5, Letter and Legal. When `page` is supplied,
omitted values use A4 portrait and 15 mm margins; dimensions are sent explicitly
instead of preferring CSS page size. Existing callers without `page` retain CSS
page sizing. Avoid conflicting `@page` rules. Asset names are plain filenames,
unique without case distinctions, and cannot replace the reserved HTML or
`factur-x.xml` files. HTML, headers, footers and assets share `maxHtmlBytes`.

```ts
import { attachPdfFiles } from "@k2b/cloud/services";

const result = await attachPdfFiles({
  document: existingPdfBlob,
  attachments: [{
    name: "details.xml",
    data: new Blob([xml], { type: "application/xml" }),
    relationship: "Data",
  }],
}, { signal: request.signal });
```

`relationship` defaults to `Unspecified`; other values are `Source`, `Data`,
`Alternative`, and `Supplement`. MIME type comes from the Blob, falling back to
`application/octet-stream`. The source PDF and attachment bytes together must
fit `maxPdfBytes`. Attachment names in one request must be unique.

`renderFacturXHtmlToPdf({ html, xml, conformanceLevel, ... })` uses the same HTML
options, embeds `factur-x.xml`, requests PDF/A-3b and supplies Factur-X metadata.
The default conformance level is EN 16931. XML shares the HTML input budget.
It takes no `title`: the PDF/A conversion drops the document title, so viewers
show the invoice's file name.
The caller owns XML generation and validation; embedding alone is not invoice
certification. These features require a Gotenberg version supporting the
corresponding embedding/Factur-X fields; the local stack uses 8.36.0.

HTML, Factur-X and attachment operations accept `{ signal }` as their second
argument and combine it with the configured timeout. Output is bounded while
reading the response. `...WithConfig` variants accept an explicit Gotenberg
configuration and optional test transport. They never choose an app's storage
location or grant access to a source file.

The server helpers accept application-owned HTML and render it offline.
Applications exposing them to untrusted input must still enforce authentication
and input budgets. Assistant Studio's worker API does not expose arbitrary
Gotenberg endpoints or connection settings. Operators must keep Gotenberg's
file access limited to its working directory, `/tmp`, and should keep
Gotenberg itself offline; see
[Deployment requirements](/en/docs/operations/deployment-requirements#keep-gotenberg-offline).

## Prepare images for print

Use `preparePdfImage()` to fit raw image bytes into pixel boxes before adding
them to a PDF. It accepts a `Uint8Array` or `Blob` and returns one variant per
box, in the same order. Images keep their aspect ratio and never scale up.

```ts
import { preparePdfImage, renderHtmlToPdf } from "@k2b/cloud/services";

const prepared = await preparePdfImage({
  data: imageBytes,
  boxes: [{ width: 1600, height: 1200 }],
  maxBytes: 2 * 1024 * 1024,
}, { signal: request.signal });
if (!prepared.ok) throw new Error(prepared.code);
const variant = prepared.variants[0];
if (!variant) throw new Error("Image exceeds the encoded byte cap.");

const result = await renderHtmlToPdf({
  html: '<!doctype html><html><body><img src="img-1.jpg"></body></html>',
  assets: [{ name: "img-1.jpg", data: variant.data }],
}, { signal: request.signal });
```

The same API and types are exported from `@k2b/cloud/services/pdf`.
Each variant has `data` (a typed `Blob`), `type`, `width`, and `height`.
A `null` entry means that box's encoding exceeded `maxBytes`; other boxes
still return their variants. The service does not reduce quality to meet the cap.

Opaque images become 8-bit sRGB JPEG at quality 85. Images with any decoded
alpha below 255 become PNG with transparency. A fully opaque alpha channel is
removed. A JPEG passes through byte for byte only when its EXIF orientation is
absent or 1, its colour space is sRGB or grayscale (not CMYK), it has no
embedded colour profile, its dimensions already fit the box, and its bytes fit
`maxBytes`. It must also pass a validation decode. A corrupt JPEG never passes
through. Other images are re-encoded.
EXIF rotation is applied before fitting. Animated GIF and WebP use the first
frame; TIFF uses the first page.

Accepted formats are JPEG, PNG, WebP, GIF, TIFF, and AVIF. HEIC/HEIF with HEVC
compression returns `unsupported_format` because the prebuilt libvips has no
HEVC decoder. SVG, PDF, and other formats are also unsupported.

Pass 1..8 boxes with integer dimensions of 1..16383 pixels each. Input is limited
to 32 MiB; `maxBytes` is an integer from 1 byte to 32 MiB per variant. Sharp's
default input limit of 268,402,689 pixels still applies, counting one page.
WebP, GIF, TIFF, and AVIF sources are limited to 16 MiP (about 16.8 MP) because
their decoders need the whole image in memory; JPEG and PNG keep sharp's default pixel limit.
The largest decoded variant is limited to 16 MiP (64 MiB as RGBA). A full A4
page at 300 dpi needs about 5.8 MP.

The service requires the Linux Cloud runtime. It runs at most two isolated
workers per application process; further calls wait in FIFO order. Each worker
has a 512 MiB data limit and receives no application credentials. The Bun runtime
itself uses about half of that limit. The input and decoded variant caps leave
room for codecs and temporary buffers. An image whose decode needs more memory
than the worker has returns `too_large`. Queuing, decoding, and encoding share a
30 s default deadline, matching PDF page decoding.
Set `{ timeoutMs }` up to 240 s, the request idle-timeout ceiling. Aborting the
signal or reaching the deadline returns `timed_out` after the child has exited.
Invalid boxes, byte caps, and timeouts throw as programming errors.

| Code | Meaning |
| --- | --- |
| `unsupported_format` | The recognized format or compression is unsupported |
| `unreadable` | The bytes cannot be identified or decoded, or the worker failed |
| `too_large` | Input bytes, source pixels, decoded pixels, or decoder memory exceed a limit |
| `timed_out` | The caller aborted or the deadline ended, including queue time |

An application image that uses this service ships sharp's libvips (about 18 MB).


## Upload browser map snapshots

Use `prepareGeoMapSnapshotAssets` from `@k2b/cloud/services/pdf` for browser
map captures destined for offline PDF. The application first authenticates the
request, authorizes the document, reads its canonical revision and enumerates
its saved map blocks. Enforce a streaming HTTP body limit before `FormData`
parsing; the helper bounds decoded input, not the HTTP parser's allocations.

The multipart field `mapSnapshots` contains JSON:

```json
{"version":1,"revision":"revision-17","images":[{"id":"block-1","fingerprint":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","width":800,"height":400}]}
```

Each entry requires one binary `image/png` part named
`geoMapSnapshotPart(id)`, exported from `@k2b/cloud/contracts/geo-snapshot`.
IDs use 1..100 ASCII letters, digits, underscores or hyphens. Filenames supplied
by the browser are ignored. `GeoMapSnapshotManifestSchema` validates the manifest.
`geoMapSnapshotFingerprint(validatedGeoDocument)` hashes the complete saved JSON,
including provenance and links, with stable object-key order. Use the same saved
value on browser and server. Input and metadata are each bounded to the geo
JSON envelope of 256 KiB. No URLs, paths, SVG or renderer HTML are accepted.

```ts
import { prepareGeoMapSnapshotAssets } from "@k2b/cloud/services/pdf";

const maps = await prepareGeoMapSnapshotAssets(form, {
  revision: savedRevision,
  maps: expectedMapIdsAndFingerprints,
  maxBytes: remainingPdfInputBudget,
}, { signal: request.signal });
// Each result: { id, name, data: Blob, type, width, height }.
// Insert the generated name as img src and pass { name, data } as PDF assets.
```

The manifest must cover exactly the expected maps. Missing, duplicate, extra or
stale images fail. Revision and fingerprints are binding application context,
not values to trust from the submitted form. Re-check the saved revision before
converting the PDF if it can change during preflight. Client pixels cannot be
verified as truthful geography; use these assets only for that caller's export,
never as another person's authoritative document or canonical map data.

Total input and output bytes each fit `maxBytes`, capped at the existing
32 MiB print image input budget. Each PNG has at most 16 MiP and dimensions
1..16383 per side. Every header is checked before any decoding starts; images
then pass sequentially through the existing isolated print-image workers.
Opaque maps become JPEG, while transparent maps remain PNG. Always use the
returned asset name and type. Budget these assets together with HTML and other
PDF images. Re-encoding can exceed a budget even when source PNGs fit.

Errors are `GeoMapSnapshotAssetError` with `code`: `invalid`, `stale`, `missing`,
`too_large`, `unreadable`, `timed_out` or `aborted`. The 30-second default deadline
covers the whole batch and worker queuing; `timeoutMs` accepts 1..240,000.
Cancellation produces no assets. Keep failure visible and offer recovery;
never silently omit a requested image. No user credentials are sent to image
workers or Gotenberg, and no additional rendering runtime is required.
