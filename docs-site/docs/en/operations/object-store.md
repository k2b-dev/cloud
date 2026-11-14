---
title: Object store operations
navTitle: Object store
section: Operations
order: 1143
description: Configure the default S3 bucket, further buckets and public image delivery.
tags: [operations, storage, s3, configuration]
updated: 2026-11-10
---

# Object store operations

Applications can use the platform object store after an administrator saves a
Garage connection in **Administration > Storage**. Storage is an
optional runtime dependency: applications that do not use it need no S3
configuration. Existing Grids, Notebooks, and Spaces storage does not move.

## Configure Garage

Cloud targets **Garage 2.3.0**. It uses Put/Get/Head/Delete, ListObjectsV2,
multipart uploads and SigV4 presigned URLs; copies are bounded read/write
operations through the application. See Garage's
[S3 compatibility status](https://garagehq.deuxfleurs.fr/documentation/reference-manual/s3-compatibility/).
Cloud exposes no ACL, bucket policy, object tagging, versioning or server-side
encryption options. Garage's compatibility table lists SSE-C, but Cloud does
not use it.

Create **one private bucket** and a key with read/write access to it. Keep
Garage website mode disabled and do not expose the bucket anonymously.
Save these settings in the Storage area:

| Setting | Set to |
| --- | --- |
| Garage S3 endpoint | Operator-controlled HTTP(S) origin without a path, query or URL credentials |
| Signing region | Garage's configured S3 region; default `garage` |
| Bucket | Existing private bucket name |
| Access key ID / Secret access key | Installation-wide Garage key with read/write access to the bucket |
| Maximum object size (bytes) | Default 33,554,432 (32 MiB), maximum 5 GiB |

Gateways now need the installation's `DATABASE_URL`, `APP_SECRET` and
`REDIS_URL` as well as access to Garage. The production Compose template supplies
them. Apply these dependencies to custom deployments before enabling public
delivery. The gateway decrypts the storage settings with the installation
`APP_SECRET`. Request budgets are shared in Valkey using the
existing **Requests Per Second** value with a separate public-storage budget,
keyed by the gateway-resolved client address (IPv6 /64). People behind one IPv4
NAT share that budget; image-heavy pages may need a CDN or a higher limit.
An exceeded budget returns 429 with Retry-After; unavailable
Valkey returns 503 before touching Garage.

The gateway is a trusted platform service: its shared database role and
encryption secret make a gateway compromise an installation compromise, as
with Core. Its public-delivery path reads only storage configuration and the
rate-limit setting; that is not credential isolation.

The credentials use Core's encrypted secret fields. They are not environment
variables. Require TLS outside a trusted internal network. Do not let
application users choose the endpoint. Save changes, then use **Test connection**:
Cloud writes, reads and deletes one small `cloud-connection-test/<random-id>`
object. A failed check leaves a visible error and can be retried after correcting
the saved settings. If cleanup fails, remove leftover test objects after repair.

Every operation reads the saved connection in one settings snapshot. Changes,
including credential rotation and limits, apply to the next operation without a
restart. A missing, invalid or unreadable connection produces a configuration
error. Existing streams finish against the connection with which they started.
Changing the bucket does not migrate objects.

## Connect further buckets

**Administration > Storage** lists the default bucket first, then further
buckets. The old address `/admin/settings?tab=storage` leads there. Use
**Add bucket** for an archive on cheaper storage, large media, or a customer's
own bucket. Apps choose a bucket through their own settings; every app may use
every bucket and sees only its own area in it.

Cloud speaks only the S3 subset listed above, so any S3-compatible service may
work. Only Garage is tested and supported. Create the bucket and its key in
the S3 service first; Cloud never creates or deletes buckets.

For each bucket, choose the access:

- **Like Default** uses the default bucket's endpoint, region and keys with a
  bucket of its own. A rotated default key applies to it at once.
- **Own server or keys** stores its own endpoint, region and key pair.

Keys are encrypted in the database with the installation `APP_SECRET`, like AI
provider keys, and are never shown again. There is no environment variable.
Saving always saves; Cloud then tests the connection at once and shows the
result, also on the bucket's list row. A test result counts only for the
configuration it tested: after any change of endpoint, region, bucket or keys,
including the default's for **Like Default**, the bucket shows **Not tested**
until the next test. Cloud does not poll.

Each bucket has a stable ID that apps store in their settings. You can rename a
bucket and change its endpoint, bucket or keys at any time without breaking
those settings. A change applies to the next operation in every process.
Objects never move: after a change of target, apps and public links read the
new target. To move data, copy the objects in the S3 service first.

**Usage** reads the package names with objects under `private/` and `public/`
directly from the bucket, so it also shows stopped apps. It reads one listing
page of each prefix and says when there are more.

**Remove** only disconnects the bucket: Cloud deletes its stored keys and keeps
its last target and ID. Objects stay in the S3 service. Apps then get
`storage_bucket_disconnected`, and public URLs answer 404. Removing is not an
instant block: running downloads finish, signed links stay valid for up to 15
minutes, and public answers stay in caches for up to 5 minutes. **Restore**
connects the same target again; enter the keys again for **Own server or
keys**. The default bucket cannot be removed.

Back up every bucket separately. A database backup holds the bucket
configuration, not objects. The gateway serves public files of every bucket
itself, so it must reach every bucket's endpoint.

### Database grants for further buckets

Core creates `platform.storage_buckets` and `platform.storage_bucket_checks`
and is their only writer. With separate database roles, grant every
application role and the gateway role read access after Core has started
(replace `application_role`):

```sql
GRANT USAGE ON SCHEMA platform TO application_role;
GRANT SELECT ON platform.storage_buckets TO application_role;
```

Without the grant, the default bucket keeps working; further buckets fail with
`storage_not_configured`, and `storage.buckets()` lists only the default.

The stable object layout is:

- `private/<package>/<key>` for private documents;
- `public/<package>/<key>` for publicly readable files.

Apps declare an optional `package` in `defineApp()`; omitted means their app ID.
All apps declaring the same package share the complete area. The wrapper
confines API calls to those paths. Applications share credentials, so this is
an API boundary for trusted application code, like shared Postgres schemas.
It is not credential isolation for hostile deployed applications.

## Application registration prerequisite

This runtime adds durable application-ID and package reservations for **every
app**, including apps that do not use S3. `defineApp()` now validates app IDs as
`^[a-z][a-z0-9-]{0,79}$`. Upgrade declarations that do not fit before deploying.

All apps in an installation must use the **same Postgres database** for
`platform.application_packages`. Separate per-app databases do not share these
reservations and are unsupported for this runtime. Separate database roles in
that shared database remain supported. The first starting app creates the schema
and table; its role needs database `CREATE`. Start Core first, then grant each
other runtime role access to the metadata (replace `application_role`):

```sql
GRANT USAGE, CREATE ON SCHEMA platform TO application_role;
GRANT SELECT, INSERT ON platform.application_packages TO application_role;
```

Schema `CREATE` is needed because startup runs idempotent table DDL. These grants
do not include access to Core's identity tables. Provision the grants before
starting the other apps; their absence makes startup fail.

`storage` is reserved as an app ID and package name. Built-in app IDs are always
reserved; other app IDs remain reserved after
shutdown. An app cannot change its registered package by restarting. Choose a
group name distinct from all app IDs before the first startup.

To correct a first-start typo with **no stored objects**, stop the affected app,
delete only its incorrect reservation, correct its declaration, and restart it:

```sql
DELETE FROM platform.application_packages
WHERE app_id = 'warenfluss-orders' AND package_name = 'incorrect-package';
```

If objects already exist, stop every app in both affected packages. Back up
the objects and registration rows, copy objects from both
`private/<old-package>/` and `public/<old-package>/` to the corresponding
new package prefixes without overwriting
unrelated objects, and update only the affected rows to the new package name.
Confirm that the new name is not another app ID. Restart those apps with matching
`package` declarations and verify private documents and public URLs before
removing old objects. Update stored public URLs and CDN caches as needed.
Changing the declaration or metadata alone does not move data.

## Object size and durability

The default byte limit covers 25 MB documents and 1–5 MB images. Writes buffer
up to the configured limit before sending data to S3; copies also pass through
the application process. Allow memory for simultaneous reads, writes, and
copies, including buffer overhead. Increase the limit only with a matching
application memory and concurrency budget. Clean up incomplete multipart uploads with Garage’s supported administration
tools, and back up bucket data with the application's
Postgres records. A database backup alone cannot restore documents.

## Public delivery and caching

Cloud's stateless gateway handles anonymous **GET/HEAD** at
`/public/storage/<package>/<key>` for the default bucket and
`/public/storage/~<bucket-id>/<package>/<key>` for further buckets. A package
name can never start with `~`, so the two forms cannot collide. An unknown or
removed bucket answers 404. It always reads `public/<package>/<key>`;
private objects, listings and mutations are unavailable at this route. No
Garage website mode or separate public base URL is needed. Public URLs use the
installation's existing **Public URL** (`app.url`) setting.

Responses stream with Content-Type, ETag, Last-Modified and
`Cache-Control: public, max-age=300`. The gateway adds
`X-Content-Type-Options: nosniff` and a restrictive CSP sandbox. HTML/SVG are
attachments. Invalid keys received by the handler, including encoded separators and nested
encodings, return 404. Bun's HTTP server resolves literal/encoded dot segments
and backslashes before exposing the request URL. Those transport spellings
cannot always be rejected with 404 in application code: they may select another
**public** key. The route always constructs a new `public/`-prefixed S3 key, so
normalization cannot select private objects. A front proxy that requires strict
404 responses for these spellings must reject them before URL normalization. Range requests currently receive the complete object with status 200.
Conditional requests can return 304. Objects larger than the current byte limit
are not served; raise the limit or replace them with smaller files.

Operators may later place their own read-only proxy or CDN in front of the
stable `public/` prefix. Keep private objects, bucket listings and all writes
inaccessible. Validate the path that the upstream actually receives, rejecting
dot segments, encoded separators and nested encodings. Retain the gateway's
content-type, sandbox and attachment protections, or serve uploads on a separate
origin without Cloud or parent-domain cookies.

Use versioned image keys. Removing an object does not evict a cached response;
invalidate caches according to their policy. Keep the installation URL stable
for links stored in website HTML. See the [application guide](/en/docs/platform/object-store).
