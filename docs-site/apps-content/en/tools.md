---
title: Tools
navTitle: Tools
section: Everyday
order: 230
description: Small generators, converters, security helpers, media utilities, and network tests.
tags: [tools, utilities, generators, network, cli]
updated: 2026-09-07
---

# Tools

Tools collects small utilities for day-to-day work so they are discoverable in
one place. Use the workspace for quick generation, conversion, inspection, and
testing tasks that do not need their own application.

## Use Tools

- Generate mailto links, QR codes, UUIDs, placeholder text, and passwords.
- Encode or decode Base64, Hex, or Base32 and convert color formats.
- Extract readable document text as plain Markdown, then copy or download it.
- Render Markdown as a styled PDF with a print preset or custom CSS.
- Calculate hashes or encrypt and decrypt text for controlled workflows.
- Convert mixed image batches to JPEG, PNG, WebP, or Base64 HTML in the browser.
- Crop, adjust, annotate, redact, and export an image in the browser.
- Measure a connection or create a temporary endpoint to inspect webhooks.

Check where each task runs before entering sensitive data. Most generators,
converters, security helpers, and image operations are interactive page tools.
Speed tests, document extraction, and PDF rendering call the Cloud server.
Document conversion holds its input and result only in memory; webhook
endpoints and request history are stored server-side.

## Understand the Tools model

| Resource or surface | Responsibility |
| --- | --- |
| Tool definition | A named utility grouped by task and category for browsing and search |
| Browser utility | Processes its interactive input in the page and offers copy or download output |
| Document to Markdown | Converts one signed-in user's document in memory and returns plain Markdown without persisting either side |
| Markdown to PDF | Renders one signed-in user's Markdown with a bounded print template or custom CSS without persisting either side |
| Speed test | Measures ping, download, upload, and jitter against the Cloud server |
| Webhook endpoint | A user-owned receiving URL with server-side request history |

Webhook logs redact common sensitive headers such as `Authorization` and
`Cookie`, but paths and bodies can still contain private data. Use synthetic
payloads when possible.

## Convert a document to Markdown

Open **Document to Markdown**, then select or drop one PDF, Word document,
OpenDocument text, RTF, PowerPoint or OpenDocument presentation, `.xlsx` or
OpenDocument spreadsheet, CSV, or EPUB file. The signed-in browser sends the
file to the Tools server. The tool previews the result as plain text and lets
you copy it or download a `.md` file.

Documents are limited to 20 MB, filenames to 255 characters, and extracted
Markdown to 1 MB. A shortened result is labelled. The converter does not
perform OCR, so image-only scans need OCR elsewhere first. Encrypted,
password-protected, malformed, and
unsupported files return a clear error. Cancelling stops the browser request;
the current bounded native conversion may still finish on the server.

The upload and result are never stored by this utility. The authenticated,
rate-limited endpoint marks responses as private and non-cacheable. It is
documented in the Tools OpenAPI description at
`/tools/api/openapi.json`.

## Convert Markdown to PDF

Open **Markdown to PDF**, enter Markdown, then choose **Document**, **Report**,
**Compact**, or **Custom**. Choosing **Custom** reveals a complete minimal
stylesheet directly below the Markdown editor. Generate the PDF explicitly,
review the rendered pages, and download the result. Changing the Markdown,
template, or custom CSS marks the existing preview as out of date instead of
silently rendering again.

Markdown is limited to 256 KiB and custom CSS to 32 KiB. Custom CSS replaces a
preset rather than overriding one and can define print rules such as `@page`,
type, spacing, colors, and tables. Raw HTML remains inert. Markdown images
appear as links in the PDF; the server does not fetch them. External
stylesheets, fonts, and CSS resource URLs are rejected.

The authenticated and rate-limited `/tools/api/markdown/pdf` endpoint returns
the PDF directly with a private no-store policy. The Markdown, CSS, and PDF are
processed in memory and are not persisted. API callers may also combine a
preset with CSS overrides; omitting the preset makes the CSS the complete
stylesheet.

## Convert images in bulk

Open **Image Converter**, then select or drop any mixture of static images that
the browser can decode. The workspace keeps every source in the page and lets
you select, remove, or rotate individual previews before export. Nothing is
uploaded or persisted. Export settings open automatically while the batch
contains images.

Choose JPEG, PNG, or WebP, then optionally limit the maximum width and height.
The converter preserves aspect ratios, never enlarges smaller images, and
applies the limits after rotation. JPEG and WebP expose quality controls; JPEG
also lets you choose the background used for transparent pixels.

Export one image as a direct download or several images in one ZIP. The split
menu beside each export action copies complete Base64 HTML `<img>` tags instead.
With an active selection, separate actions export all images or only the
selected images. Base64 images are useful in controlled HTML, but uploaded or
hosted images are usually more reliable across email editors and recipients.

Input support follows the browser. Vector images are rasterized, animated
images become still images, and converted output does not retain source image
metadata.

## How Tools fits Cloud

Tools owns the utility catalog, browser interactions, speed-test endpoints, and
user-owned webhook records. Cloud supplies the shared application shell,
identity for stored network tools, settings, lifecycle, and the in-product Help
surface.

## Find detailed product help

Open **Help** inside Tools to choose the right utility and review data-handling
guidance. Developers can read
[Application shells](/en/docs/frontend/application-shells),
[Authentication](/en/docs/identity/authentication), and
[Build typed HTTP APIs](/en/docs/server/http) for the shared contracts used by
the workspace and its server-backed tools.

## Run Tools from the terminal

Tools provides a native CLI module. Most commands run locally and do not need
a Cloud profile:

```bash
cld tools uuid --count 3 --json
cld tools color "#2563eb" --json
```

Run `cld tools help` to see the available generators, encoders, security
helpers, and speed test. Run `cld tools <command> --help` for exact inputs and
output options.

Document to Markdown and Markdown to PDF deliberately have no dedicated `cld
tools` commands. Signed-in users can use the Tools pages; authenticated
integrations can call `/tools/api/documents/markdown` or
`/tools/api/markdown/pdf`. Neither endpoint fetches URLs or resolves resources
owned by another application.

## Deployment requirements

See [Deployment requirements](/en/docs/operations/deployment-requirements) for
this app’s startup prerequisites, optional integrations, configuration and
functional checks.
