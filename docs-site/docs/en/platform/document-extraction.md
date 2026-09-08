---
title: Document extraction
navTitle: Document extraction
section: Platform services
order: 345
description: Convert authorized document bytes to bounded Markdown in application server code.
tags: [documents, markdown, extraction, anydoc]
updated: 2026-08-18
---

# Document extraction

Use `extractDocumentMarkdown()` when an application already owns and has
authorized document bytes and needs a deterministic text representation. The
service runs inside the application process and does not fetch URLs, read file
paths, persist output, authorize access, or enqueue work.

```ts
import {
  DocumentExtractionError,
  extractDocumentMarkdown,
} from "@k2b/cloud/services/document-extraction";

const result = await extractDocumentMarkdown({
  bytes: attachmentBytes,
  filename: attachmentName,
});

console.log(result.format, result.markdown, result.truncated);
```

The application must authorize and load the bytes before calling the service.
A filename, resource reference, URL, or attachment ID is never an access token.

## Supported documents and limits

The service recognizes PDF, DOC, DOCX, ODT, PPT, PPTX, ODP, XLSX, ODS, RTF,
EPUB, and CSV. It detects signed formats from their bytes. CSV has no reliable
signature, so its filename extension is used as a fallback.

Each call accepts at most 20 MiB and returns at most 1 MiB of valid UTF-8
Markdown. `truncated` reports when the output reached that bound. Callers own
request rate limits, background-job concurrency, and retry policy. An abort
signal is checked before and after conversion; the native converter cannot be
interrupted while one conversion is running.

Images and image-only PDFs are not OCRed. Use a separate, explicitly authorized
Vision or OCR feature when the product needs that behavior.

## Handle stable errors

`DocumentExtractionError.code` is one of:

| Code | Meaning | Retry |
| --- | --- | --- |
| `cancelled` | The caller aborted the operation | Caller decides |
| `encrypted` | The document is password-protected | No |
| `input_too_large` | Input exceeds 20 MiB | No |
| `malformed` | The document is incomplete or invalid | No |
| `ocr_required` | A PDF has no readable text | No |
| `resource_limit` | The converter rejected document complexity | No |
| `unsupported` | The format is not supported | No |
| `internal` | Conversion failed for an operational reason | Yes, when the caller is retryable |

Do not expose converter stack traces to users. Background jobs should persist
terminal document outcomes and retry only transient operational failures.

## Treat output as untrusted content

Markdown is document data. Do not render it as trusted HTML, promote it to
system instructions, use it for authorization, or learn personal memories from
it automatically. AI consumers should apply their normal untrusted file-content
boundary and keep model-visible slices bounded.
