---
title: Object store
navTitle: Object store
section: Platform services
order: 536
description: Store application documents and public images in the installation's S3 buckets.
tags: [storage, s3, files, services]
updated: 2026-11-10
---

# Object store

Use `storage` from `@k2b/cloud` after `app.start()`. The operator
configures the installation's default S3 bucket and can connect
[further buckets](#use-further-buckets). The API
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

## Use further buckets

Besides the default bucket, an administrator can connect further buckets in
**Administration > Storage**, for example an archive on cheaper storage, large
media, or a customer's own bucket. Every app may use every bucket. In each
bucket your app sees only its own `private/<package>/` and `public/<package>/`
area, exactly as in the default bucket.

Each bucket has a stable ID. The administrator can rename a bucket and change
its endpoint, bucket name or keys at any time; the ID stays the same. Store
only the ID, never the name. The default bucket's ID is `"default"`
(`DEFAULT_STORAGE_BUCKET_ID`); every further bucket has a UUID.

Let the administrator choose the bucket with a `storage_bucket` setting instead
of asking for an ID:

```ts
import { defineApp, storage } from "@k2b/cloud";

export const app = defineApp({
  id: "warenfluss",
  // ...
  settings: {
    "warenfluss.archive_bucket": {
      kind: "storage_bucket",
      label: "Archive bucket",
      description: "Where invoices are kept for ten years.",
    },
  },
});

// In an authorized application service, after app.start().
const archive = storage.bucket(await app.settings.get("warenfluss.archive_bucket"));
await archive.file("2026/invoice-42.pdf").write(pdfBytes, { type: "application/pdf" });
const { contents } = await archive.list({ prefix: "2026/" });
```

`storage.bucket(id)` returns the same `file`, `list` and `public` methods as
`storage`. It is synchronous and does no I/O. `storage.bucket("default")` is the
default bucket: the same objects and URLs as `storage.file()`. The parameter is
the branded `StorageBucketId` type. A `storage_bucket` setting already has that
type; for an ID you stored elsewhere, use `parseStorageBucketId(value)`, which
returns `null` for anything that is not a bucket ID. All three are exported
from `@k2b/cloud`.

`await storage.buckets()` lists every bucket as
`{ id, name, isDefault, connected }`, the default first. It never returns an
endpoint, a bucket name in the S3 service, or keys. Removed buckets stay in the
list with `connected: false`, so a stored ID keeps a name.

The first operation resolves the bucket. Failures throw
`ObjectStoreConfigurationError` with a `code`:

| Code | Meaning |
| --- | --- |
| `storage_bucket_unknown` | No bucket has this ID |
| `storage_bucket_disconnected` | An administrator removed the bucket; its objects still exist, and restoring it makes them reachable again |
| `storage_not_configured` | The connection is incomplete, or this process cannot read the bucket table (see the operator grants) |
| `storage_unreadable` | Stored keys cannot be decrypted with this process's `APP_SECRET` |

A malformed ID passed to `storage.bucket()` throws a `TypeError` with
`code: "storage_bucket_invalid"` at once.

Public files in a further bucket get the URL
`https://cloud.example.org/public/storage/~<bucket-id>/<package>/<key>`.
Default-bucket URLs keep their form. Because the URL holds the ID, it keeps
working after the administrator renames the bucket; after a change of endpoint
or bucket it serves the new target's object.

`file.copy()` stays within one bucket and area. To copy between buckets, write
the bytes yourself: `await target.file(key).write(await source.file(key).bytes())`.
One object size limit applies to all buckets.

### Show the choice in your administration

Render a `storage_bucket` setting with `StorageBucketSelect` from
`@k2b/cloud/browser/storage-bucket-select`. Pass the setting's value and
`entry.storageBuckets`, which every setting entry of this kind carries. The
select saves the ID and shows the bucket's current name. A stored ID of a
removed or unknown bucket stays selected with a hint, instead of quietly
switching to another bucket:

```tsx
import { StorageBucketSelect } from "@k2b/cloud/browser/storage-bucket-select";

<StorageBucketSelect
  aria-label={entry.label}
  value={draft.archiveBucket}
  buckets={entry.storageBuckets ?? []}
  onValueChange={(id) => setDraft({ ...draft, archiveBucket: id })}
/>;
```

Outside a settings form, pass the result of `storage.buckets()` from your
server-rendered page instead.

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

The operator’s **Storage > Maximum object size (bytes)** setting defaults to **32 MiB** and applies to every bucket. This
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
