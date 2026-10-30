---
title: Object store
navTitle: Object store
section: Platform services
order: 536
description: Store application documents and public images in the installation's S3 bucket.
tags: [storage, s3, files, services]
updated: 2026-10-28
---

# Object store

Use `storage` from `@k2b/cloud` after `app.start()`. The operator
configures one S3 bucket and credential pair for the installation. The API
selects your package's area from the started app declaration; no method accepts
another package or area ID. Declare `package: "warenfluss"` alongside `id` in
`defineApp()` for related apps to share the whole area. Without `package`, the
package name is the app ID. Use lowercase names beginning with a letter, followed
by letters, digits, or hyphens, at most 80 characters.

A package name must differ from every other app ID, including built-in apps
that are not running. Startup rejects conflicting reservations and changes to
an app's existing package assignment. Choose a group name distinct from all
your app IDs. Reservations survive app shutdown; changing a package is an
operator-managed data migration. `storage` is reserved as an app ID and package name.

```ts
import { storage } from "@k2b/cloud/services";

// In an authorized application service, after app.start().
const document = storage.file("orders/42/invoice.pdf");
await document.write(pdfBytes, { type: "application/pdf" });
const metadata = await document.stat();
const copyBytes = await document.copy("orders/42/invoice-copy.pdf");

const image = storage.public.file("products/42/photo-v1.webp");
await image.write(imageBytes, { type: "image/webp" });
const permanentImageUrl = await image.url;
```

## Own your private and public data

`storage.file(key)` selects `private/<package>/<key>`;
`storage.public.file(key)` selects `public/<package>/<key>` in the same bucket.
`storage.list()` and `storage.public.list()` return separate listings.
`file.copy(destinationKey)` stays in the source's part and replaces an existing
destination. Copies pass through your server and obey the object size limit.

Private documents can stay entirely behind your application: check the
caller's resource permission, then deliver `file.stream()` from the server.
No signed URL is needed. Check permissions before every read, write, copy,
delete, and listing; the store enforces the package boundary, not your
users' access to documents.

For public images, `await storage.public.file(key).url` returns a permanent
installation URL: `https://cloud.example.org/public/storage/<package>/<key>`.
Cloud's gateway streams that public object without sign-in. There is no public
listing and no public URL for private files. HTML and SVG are downloaded with
sandbox and content-type protection headers. Anyone with a public URL can read
the object. Use versioned image keys and account for cached copies when removing
public data. The gateway uses `Cache-Control: public, max-age=300`.

Keep object keys in your application's own durable records. Delete objects
when deleting their owning records, including copies and public variants.
Database transactions and S3 operations are separate: commit a cleanup task
with the domain change when deletion must survive a process failure.

## Use literal relative keys

The API rejects invalid keys; it never cleans or normalizes them:

- No leading `/`, backslashes, empty segments (`//`), or trailing `/` on a file key.
- No `.` or `..` path segments, including inside a longer path.
- No percent signs, including single or nested percent-encoded traversal.
- Text must already be Unicode NFC, with no unpaired surrogates, control
  characters, or Unicode format characters such as bidirectional overrides
  and zero-width joiners (including joined emoji sequences).
- The full S3 key, including `private/<package>/` or `public/<package>/`, must fit
  within 1,024 UTF-8 bytes.

Use stable generated names, such as `orders/42/invoice.pdf`; store the person's
original filename as metadata in your database. Ordinary Unicode letters,
spaces, and punctuation remain literal key characters.

`list({ prefix, startAfter, maxKeys, continuationToken })` forces
the selected area prefix and returns relative `contents[].key` values.
A list prefix may be empty, a partial name such as `ord`, or a path such as `orders/`. `maxKeys` is 1–1,000 (default 1,000);
pass `nextContinuationToken` to get another page. Tokens are opaque and limited
to 8,192 characters per request. Unknown transport options never override the
area, bucket, credentials, or endpoint. Listings omit objects written outside
this API with keys that fail its validation.

## Bound objects and temporary access

The operator’s **Storage > Maximum object size (bytes)** setting defaults to **32 MiB**. This
covers documents up to 25 MB and images of 1–5 MB. `write()` checks bytes before
uploading; streamed request or response bodies are buffered within the limit,
and overflow cancels the input without replacing an existing object. Buffered
reads and `stream()` also reject data beyond this limit. Applications should
apply smaller limits for their own inputs where appropriate. If the operator
lowers the limit below existing object sizes, check `stat()` before serving
a stream to avoid a truncated response.

Use `stat()` or `await file.size` to inspect metadata without downloading data.
For the remaining `write`, `text`, `bytes`, `stream`, `exists`, and `delete`
semantics, see [Bun's S3 API](https://bun.sh/docs/api/s3).
The wrapper accepts strings, byte buffers, blobs, requests, and responses for
writes, with an optional `{ type }`. It exposes no raw S3 client, credentials,
ACL controls, or transport overrides.

Only generate `await file.presign({ method, expiresIn })` **after the resource
permission check**. A signed URL is a bearer credential until it expires;
keep it out of logs and stored HTML. The configured S3 endpoint must be
reachable by the URL recipient. Only private files support `presign()`. The default is GET for 300 seconds; the
maximum is 900 seconds. HEAD and DELETE are also supported. Uploads go through
`write()` so the byte limit remains enforced; PUT and POST signatures are
rejected. Public images use `await file.url` instead of expiring signatures.

See [Object store operations](/en/docs/operations/object-store) for configuration
and public delivery.
