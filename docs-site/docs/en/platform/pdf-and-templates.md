---
title: PDF and templates
navTitle: PDF and templates
section: Platform services
order: 590
description: Render documents from application data with shared template and PDF services.
tags: [pdf, templates, gotenberg]
updated: 2026-09-29
---

# PDF and templates

Cloud can render HTML as PDF through the deployment's Gotenberg service.

The application owns the document data and HTML. Cloud owns connection
settings, authentication, timeouts, and size limits. Operators set the
Gotenberg URL in the `gotenberg.url` setting or bootstrap it with
`GOTENBERG_URL`; without it, rendering fails with the `not_configured` code.

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
and the other types), which print as a light-tinted notice. When the
application's documents use their own blocks, render them with the
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
`html` becomes the document body as given, so sanitize it in the application
renderer. `css` styles the application's own elements. It comes after the
preset and before `customCss`, so a person's custom CSS can still override it.
With `customCss` but no `templateId`, `css` still applies while the preset is
left out. The print styles for info blocks come with every document, before
`css`, so an application renderer that emits info blocks through
`renderMarkdownInfoBlock()` from `@k2b/ui` prints them like Markdown PDFs.

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

The result separates the `template` phase from the `pdf` phase. Do not expose
template stack traces to end users.

## Merge PDFs

`mergePdfs()` accepts one or more `Uint8Array` PDF files and returns one PDF.
Cloud preserves input order.

An empty file list fails with `bad_input`.

## Handle renderer errors

`GotenbergRenderError.code` is one of:

| Code | Meaning |
| --- | --- |
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
