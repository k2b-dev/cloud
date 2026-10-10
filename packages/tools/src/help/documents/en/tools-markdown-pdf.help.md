---
id: tools-markdown-pdf
title: Convert Markdown to PDF
icon: ti ti-file-type-pdf
description: Turn Markdown into an A4 PDF with a print template or custom CSS, and know the limits and private in-memory processing.
order: 116
---

Use **Markdown to PDF** to turn Markdown into a downloadable A4 PDF. You must be signed in.

:::steps
1. Enter or paste Markdown.
2. Choose a print template under **Template**.
3. Choose **Generate PDF**.
4. Review the resulting pages before you download them.
:::

## Choose a template {icon="template"}

- **Document** uses neutral typography and balanced spacing for general documents.
- **Report** emphasizes headings and tables for more formal output.
- **Compact** uses tighter type and spacing for technical notes and runbooks.
- **Custom** shows a complete minimal stylesheet directly below the Markdown editor.

Custom CSS replaces a preset rather than overriding one. It can be up to 32 KiB. It can change print margins with `@page`, typography, colors, tables, and spacing. It cannot import stylesheets, fonts, images, or other external resources.

## Know the current boundaries {icon="shield-lock"}

Markdown can be up to 256 KiB. The tool displays raw HTML as text and does not execute it. Markdown images appear as links in the generated document, and the renderer does not visit them.

The tool sends Markdown and CSS to this Cloud server. The server processes them and the generated PDF in memory. This utility does not persist the input or PDF. Responses use a private no-store cache policy.

When you cancel, the browser request stops and the tool ignores a late result. The bounded Gotenberg render can still finish on the server. If you change Markdown, the template, or CSS after you generate the PDF, the tool marks the visible preview as out of date.

:::info Web and API utility
Markdown to PDF has no dedicated `cld tools` command. Authenticated integrations can call the Tools endpoint `/tools/api/markdown/pdf`, which OpenAPI documents. It accepts Markdown and CSS directly. It does not fetch URLs and does not resolve resources that another app owns.

API callers can add CSS overrides on top of Document, Report, or Compact. When a call sends no preset, the custom CSS is the complete stylesheet.
:::
