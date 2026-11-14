---
title: File previews
navTitle: File previews
section: Platform services
order: 594
description: Generate reusable file previews after your application checks access.
tags: [files, previews, storage]
updated: 2026-11-11
---

# File previews

Use `previews` from `@k2b/cloud/services` to generate images, first-page PDF
thumbnails, Office conversions and text excerpts. The application checks file
access before each read or retry. The platform never grants access to a source.

## Register a source reader

Register one reader during lifecycle startup. It receives the application's
opaque locator and reads the current bytes as the application service. Return
a `Response` or `ReadableStream<Uint8Array>` and honor the supplied abort signal.
Throw `PreviewSourceChanged` when the object is gone or its revision changed;
the platform drops that job without remembering a failure.

```ts
import { previews, PreviewSourceChanged } from "@k2b/cloud/services";

previews.reader(async ({ key, revision, locator }, signal) => {
  const file = await files.current(locator, signal);
  if (!file || file.key !== key || file.revision !== revision) {
    throw new PreviewSourceChanged();
  }
  return file.response;
});
```

`files` above is the application's own reader. Apps do not call another app's
private file routes to use previews. Files is the first built-in consumer.

Describe each authorized source with `PreviewSource`:

| Field | Meaning |
| --- | --- |
| `key` | Stable application-chosen object ID, at most 512 UTF-8 bytes |
| `revision` | Opaque version tag, at most 256 UTF-8 bytes; change it whenever bytes change |
| `name` | File name used for extension detection |
| `mediaType?` | Optional type hint when the extension is unrecognized |
| `size` | Current source size in bytes |
| `locator` | Application-defined reader locator, at most 2 KiB of UTF-8 |

## Read and retry a preview

After checking the caller's access, call
`await previews.read(source, variant, { signal })`. `PreviewVariant` is
`"small" | "large" | "pdf" | "text"`.

| State | Result and next step |
| --- | --- |
| `ready` | `body` is a stream or Blob; `type` and `bytes` describe it |
| `pending` | Retry after `retryAfter` seconds; the queue or inline pool may be full |
| `failed` | Failure is remembered for this revision for 30 days; offer an explicit retry |
| `too_large` | Source bytes or decoding exceed the relevant limit |
| `unsupported` | Source format, requested variant, or text encoding is unsupported |

A missing stored preview submits high-priority work and returns `pending`.
One generation produces both image sizes. High-priority work has a dedicated
consumer, so it can proceed while upload previews wait in the low-priority lane.
Each lane accepts at most 64 jobs; a full lane leaves the request pending for a
later attempt. At most two generators run per process, with a three-minute
generation deadline. Accepted jobs expire after four hours if unprocessed.

Call `await previews.enqueue(source)` after publishing a file or revision for
low-priority warmup. Ready and failed revisions are not regenerated. Call
`await previews.retry(source)` after checking read access to clear a remembered
failure and request high-priority work. Call `await previews.discard(key)` after
a permanent deletion to remove all revisions. If that key is currently being
generated, discard rejects and can be retried.

## Choose a variant

Browser code imports `previewSourceKind(name, mediaType?)` and the
`PreviewVariant` type from `@k2b/cloud/shared`; they have no server dependency.
The helper returns `"image"`, `"pdf"`, `"office"`, `"text"`, or `null`.

| Source | Limit | Variants |
| --- | --- | --- |
| JPEG, PNG, WebP, GIF, AVIF, TIFF | 32 MiB input plus the image worker's pixel and memory limits | `small`, `large` |
| PDF | 50 MB input, first page only | `small`, `large` |
| DOCX, DOC, ODT, XLSX, XLS, ODS, PPTX, PPT, ODP, RTF | 20 MB input, Gotenberg output limit also applies | `small`, `large`, converted `pdf` |
| Text and Markdown | Reads only the first 2 KiB | `text` |

Image variants are JPEG quality 80, fit within 320 × 320 and 1280 × 1280,
and never enlarge an image. Transparent pixels become white. Animated inputs
use their first frame. PDFs use the isolated PDF renderer; image decoding uses
the isolated image worker. See [PDF and templates](/en/docs/platform/pdf-and-templates)
for its pixel and memory limits.

Text includes `txt`, `md`, `markdown`, `csv`, `json`, `log`, `js`, `jsx`, `ts`,
`tsx`, `css`, `html`, `xml`, `yaml`, `yml`, `toml`, `py`, `sh`, `sql`, `rs`,
`go`, `java`, `c`, `h`, and `cpp`. Excerpts are UTF-8 plain text. A truncated
excerpt ends at its last newline when present; a single long line keeps its
valid prefix. Invalid UTF-8 returns `unsupported`. HTML is shown as text.
Text has no `small` or `large` variant; only Office has a `pdf` variant.

## Configure storage and Office conversion

With the platform object store configured, previews are private objects in the
application package's default bucket area. Cloud records their metadata in
`platform._cloud_previews` without application migrations. Successful views
update recency at most once per day per preview revision.

Operators set `previews.max_bytes` in **Administration → Storage**, beside the
default bucket's size setting. Its default is 2 GiB across applications sharing
the platform database. Every ten minutes each running application's runtime
removes a bounded batch of its own previews, using installation-wide recency
and byte totals. The oldest previews are removed first and regenerate on view.
The same run removes remembered `failed`, `too_large` and `unsupported`
revisions after 30 days, so they hold no budget but still cannot grow without
end. Inactive applications must run their runtime again to clean their objects.
Only applications that register a reader start preview queues and workers; each
application owns its own queues, so no application processes another's jobs.

Without an object store (`storage_not_configured`), `read` generates inline in
the same bounded pool and returns the requested bytes without saving them.
A full pool returns `pending`. `enqueue` does nothing. Failure states are still
remembered in Postgres; explicit retry clears `failed`.

Office conversion requires the full Gotenberg 8.36.0 image with LibreOffice.
The `-chromium` image variant lacks LibreOffice, so Office previews end in
`failed`. Cloud reuses `gotenberg.url`, credentials, timeout, output budget and
concurrency settings. `convertOfficeToPdf({ data: Blob, name: string },
{ signal? })`, also exported from `@k2b/cloud/services/pdf`, returns
`{ pdf: Uint8Array, contentType: string }` and accepts the same 20 MB input cap.
See [Deployment requirements](/en/docs/operations/deployment-requirements#file-previews).
