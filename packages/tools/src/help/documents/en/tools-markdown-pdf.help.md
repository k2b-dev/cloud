---
id: tools-markdown-pdf
title: Convert Markdown to PDF
icon: ti ti-file-type-pdf
description: Print templates, custom CSS, limits, and private in-memory PDF generation.
order: 116
---

Use **Markdown to PDF** to turn Markdown into a downloadable A4 PDF. Enter or paste Markdown, choose a print template, and select **Generate PDF**. Review the resulting pages before downloading them.

## Choose a template {icon="template"}

- **Document** uses neutral typography and balanced spacing for general documents.
- **Report** emphasizes headings and tables for more formal output.
- **Compact** uses tighter type and spacing for technical notes and runbooks.
- **Custom** reveals a complete minimal stylesheet directly below the Markdown editor.

Custom CSS replaces a preset rather than overriding one and is limited to 32 KiB. It may change print margins with `@page`, typography, colors, tables, and spacing. It cannot import stylesheets, fonts, images, or other external resources.

## Know the current boundaries {icon="shield-lock"}

Markdown is limited to 256 KiB. Raw HTML is displayed as text rather than executed. Markdown images appear as links in the generated document, and the renderer does not visit them.

You must be signed in. Markdown, CSS, and the generated PDF are sent to this Cloud server and processed in memory. This utility does not persist the input or PDF, and responses use a private no-store cache policy.

Cancelling stops the browser request and ignores a late result. The bounded Gotenberg render may still finish on the server. If you change Markdown, the template, or CSS after generating, the tool marks the visible preview as out of date.

:::info Web and API utility
Markdown to PDF has no dedicated `cld tools` command. Authenticated integrations can call the Tools-owned `/tools/api/markdown/pdf` endpoint documented through OpenAPI. It accepts Markdown and CSS directly; it does not fetch URLs or resolve resources owned by another application.
API callers may layer CSS overrides on Document, Report, or Compact. When no preset is sent, custom CSS is the complete stylesheet.
:::
