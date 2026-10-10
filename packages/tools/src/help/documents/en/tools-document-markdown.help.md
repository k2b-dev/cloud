---
id: tools-document-markdown
title: Convert a document to Markdown
icon: ti ti-markdown
description: Extract the readable text of one document as plain Markdown, and know the supported files, limits, and server processing.
order: 115
---

Use **Document to Markdown** when you need the readable text of one document as plain Markdown. You must be signed in.

## Convert a document {icon="files"}

The converter accepts PDF, Word (`.doc` and `.docx`), OpenDocument text, RTF, PowerPoint and OpenDocument presentations, Excel (`.xlsx`) and OpenDocument spreadsheets, CSV, and EPUB files. A document can be up to 20 MB.

:::warning Scans and protected documents
The converter does not perform OCR. A scanned PDF without readable text needs OCR in another tool first. The converter cannot convert password-protected, encrypted, malformed, or unsupported files.
:::

:::steps
1. Drop the file onto the tool, or choose it from your device.
2. Choose **Copy Markdown**, or choose **Download .md** to save a `.md` file.
:::

The extracted Markdown can be up to 1 MB. The tool clearly marks a shortened result.

## Understand where the file goes {icon="server"}

The tool sends the selected document to this Cloud server and converts it in memory. This Tools utility does not persist either the upload or the Markdown result. It returns the result with a private no-store cache policy. The preview stays plain text. The tool does not render it as trusted HTML.

When you cancel, the browser request stops and the tool ignores a late result. The native conversion on the server can still finish its current bounded operation.

:::info Web and API utility
Document to Markdown intentionally has no dedicated `cld tools` command. Signed-in users can use the Tools page. Authenticated integrations can upload bytes to the Tools endpoint `/tools/api/documents/markdown`, which OpenAPI describes. The endpoint does not fetch URLs and does not resolve resources that another app owns.
:::
