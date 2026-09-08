---
title: PDF and templates
navTitle: PDF and templates
section: Platform services
order: 590
description: Render documents from application data with shared template and PDF services.
tags: [pdf, templates, gotenberg]
updated: 2026-08-22
---

# PDF and templates

Cloud can render HTML as PDF through the deployment's Gotenberg service.

The application owns the document data and HTML. Cloud owns connection
settings, authentication, timeouts, and size limits.

## Render HTML

```ts
import { renderHtmlToPdf } from "@k2b/cloud/services";

const result = await renderHtmlToPdf({
  html: "<!doctype html><html><body><h1>Stock report</h1></body></html>",
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

Cloud sends the HTML to Gotenberg with background printing and CSS page sizes
enabled. The result contains PDF bytes and the returned content type.

## Render untrusted Markdown

Use `renderMarkdownToPdf()` for a deterministic Markdown document with a
code-owned print preset:

```ts
import { renderMarkdownToPdf } from "@k2b/cloud/services";

const result = await renderMarkdownToPdf({
  markdown: "# Stock report\n\n| Item | Remaining |\n| --- | ---: |\n| Cable | 4 |",
  templateId: "report",
  customCss: "h1 { color: #244f75; }",
});
```

The available A4 presets are `document`, `report`, and `compact`. Optional
`customCss` is applied after a selected preset and can override it. Omit
`templateId` to use custom CSS as the complete stylesheet; omit both fields to
use `document`. CSS is limited to 32 KiB. Raw HTML stays inert. Markdown image
references become safe links, so the renderer never fetches them. CSS imports,
URLs, and other external resources are rejected. The generated HTML also
carries a restrictive Content Security Policy before it is sent through the
same bounded Gotenberg HTML renderer.

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

The input may include header, footer, and page CSS templates. It also accepts
custom Liquid filters.

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

Authorize access to the document data before rendering. Avoid remote assets
whose availability or credentials are outside the document request.
