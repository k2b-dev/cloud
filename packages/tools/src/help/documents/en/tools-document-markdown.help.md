---
id: tools-document-markdown
title: Convert a document to Markdown
icon: ti ti-markdown
description: Supported documents, server processing, limits, and safe Markdown output.
order: 115
---

Use **Document to Markdown** when you need the readable text of one document as plain Markdown. Drop the file onto the tool or choose it from your device, then copy the result or download a `.md` file.

## Supported documents {icon="files"}

The converter accepts PDF, Word (`.doc` and `.docx`), OpenDocument text, RTF, PowerPoint and OpenDocument presentations, Excel (`.xlsx`) and OpenDocument spreadsheets, CSV, and EPUB files. Documents are limited to 20 MB. Extracted Markdown is limited to 1 MB; the tool clearly marks a shortened result.

:::warning Scans and protected documents
The converter does not perform OCR. A scanned PDF without readable text needs OCR in another tool first. Password-protected, encrypted, malformed, or unsupported files cannot be converted.
:::

## Understand where the file goes {icon="server"}

You must be signed in. The selected document is sent to this Cloud server and converted in memory. This Tools utility does not persist either the upload or the Markdown result, and returns it with a private no-store cache policy. The preview stays plain text and is not rendered as trusted HTML.

Cancelling stops the browser request and ignores a late result. The underlying native conversion may still finish its current bounded operation on the server.

:::info Web and API utility
Document to Markdown intentionally has no dedicated `cld tools` command. Signed-in users can use the Tools page, and authenticated integrations can upload bytes to the Tools-owned `/tools/api/documents/markdown` endpoint described by OpenAPI. The endpoint does not fetch URLs or resolve resources owned by another application.
:::
