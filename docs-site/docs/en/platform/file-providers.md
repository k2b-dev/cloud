---
title: Offer files to other applications
navTitle: File providers
section: Platform services
order: 558
description: Implement the file-provider contract so other Cloud applications can browse, open, and save files in your application.
tags: [capabilities, files, contracts, streams]
updated: 2026-10-06
---

# Offer files to other applications

A file provider lets other applications work with the files your application
stores. A consumer browses your folders, opens a file, and, if you allow it,
saves a new file into a folder. Files is the built-in provider. Any application
that publishes a compatible declaration becomes a provider too, with the same
contract and no special treatment.

The contract is a set of schemas exported from `@k2b/cloud/contracts`, built
from ordinary [capabilities](/en/docs/platform/capabilities) and
[binary streams](/en/docs/platform/capabilities#binary-streams). Your
application keeps its own identifiers, permissions, storage, and routes.

## Functions

| Function | Kind | Input schema | Result schema | Stream | Files ID |
| --- | --- | --- | --- | --- | --- |
| `list` | Query | `FileProviderListInputSchema` | `FileProviderListDataSchema` | none | `provider.list` |
| `read` | Query | `FileProviderReadInputSchema` | `FileProviderReadDataSchema` | read | `content.read` |
| `save` | Action, optional | `FileProviderSaveInputSchema` | `FileProviderSaveDataSchema` | write | `provider.save` |

`fileProvider` bundles the kind, stream direction, and schemas of each
function, and `FILE_PROVIDER_FUNCTIONS` lists their names. `save` must declare
`idempotency: "required"`, as every write stream must.

- **`list`** returns one page of a folder: `writable`, up to 100 `items`, and
  `next`. Without `parent`, it returns your root. Folders may be virtual: Files
  shows a person's storage bases as root folders. `query` filters names inside
  the folder; `cursor` continues a page; `limit` is 1 to 100 and defaults to 50.
- **Entries** are `folder` or `file`, with an opaque `id` of up to 2,048
  characters and a `name`. Files also carry `size` and may carry `mediaType`.
  Both kinds may carry `updatedAt`, a Tabler `icon` class, and up to three
  display `tags` of up to 40 characters with an optional `tone`. Tags describe
  an entry; they do not filter or grant anything.
- **`read`** takes a file `id` from `list` and returns a read stream. Report
  the file's media type in the stream descriptor.
- **`save`** takes a `parent` folder `id`, a single file `name`, a
  `mediaType`, and the exact `size`, and returns a write stream. It only
  creates files: when the name exists, answer `409`, from the Action or from
  the stream's `write` or `status`. The completed write returns
  `{ file: { id, name, size } }`; the call that opens the stream has no file
  yet.

## Implement a provider

Choose your own capability IDs and declare them in `fileProvider`. Reusing the
contract schemas is the simplest compatible choice:

```ts
import { defineCapabilities } from "@k2b/cloud";
import {
  FileProviderListDataSchema,
  FileProviderListInputSchema,
  FileProviderReadInputSchema,
  FileProviderSaveDataSchema,
  FileProviderSaveInputSchema,
} from "@k2b/cloud/contracts";
import { ok } from "@k2b/stdlib";
import { z } from "zod";

const MAX_BYTES = 25 * 1024 * 1024;

export const archiveCapabilities = defineCapabilities({
  protocolVersion: 2,
  queries: {
    "folder.list": {
      title: "Browse archived documents",
      description: "List one folder of archived documents the caller can read.",
      input: FileProviderListInputSchema,
      data: FileProviderListDataSchema,
      openWorld: false,
      run: async (input, context) => ok({ data: await listReadableFolder(context.accessSubject, input) }),
    },
    "document.read": {
      title: "Read archived document",
      description: "Open one archived document as a binary stream.",
      input: FileProviderReadInputSchema,
      data: z.object({ id: z.string() }).strict(),
      openWorld: false,
      stream: {
        direction: "read",
        maxBytes: MAX_BYTES,
        read: async (stream, context) => openDocument(context.accessSubject, stream.id),
      },
      run: async ({ id }, context) => ok(await describeDocument(context.accessSubject, id)),
    },
  },
  actions: {
    "document.save": {
      title: "Archive a new document",
      description: "Create one new document in a writable folder; an existing name is a conflict.",
      input: FileProviderSaveInputSchema,
      data: FileProviderSaveDataSchema,
      destructive: false,
      openWorld: false,
      idempotency: "required",
      stream: {
        direction: "write",
        maxBytes: MAX_BYTES,
        write: async (stream, body, context) => storeDocument(context.accessSubject, stream, body),
        status: async (stream, context) => documentUploadStatus(context.accessSubject, stream),
        abort: async (stream, context) => abortDocumentUpload(context.accessSubject, stream),
      },
      run: async (input, context) => ok(await reserveDocument(context.accessSubject, input, context.idempotencyKey)),
    },
  },
  fileProvider: { list: "folder.list", read: "document.read", save: "document.save" },
});
```

The undeclared functions stand for your own permission-aware service code.
`describeDocument` returns `{ data, stream }` with the descriptor of the
document's current revision; `reserveDocument` returns `{ data: {}, stream }`
for a durable upload reservation. Follow
[Binary streams](/en/docs/platform/capabilities#binary-streams) for
descriptors, receipts, and recovery.

Omit `save` from `fileProvider` for a read-only provider. One application has
one provider; offer several roots as virtual folders instead.

Keep these rules in every call:

- Authorize each call with the caller's own access. Listing a folder is not a
  grant, and an `id` is not one either; a consumer may hold an `id` it can no
  longer use. Answer `404` or `403` as for any other resource.
- List only entries the caller can open. Report `writable` for the folder from
  the caller's current permission; `save` still checks it again.
- Keep identifiers and cursors opaque. A page may be short or empty and still
  continue while `next` is set; return `next: null` on the last page.
- Bound `maxBytes` by what you can serve. Consumers combine it with their own
  limit, and Core rejects larger transfers.
- Make `save` idempotent per key: a retry with the same key returns the same
  transfer, never a second file and never a conflict with itself.

## Understand compatibility

Your application checks the declaration when it starts. `app.start()` fails
when a named capability is missing or does not match its function, for
example a `read` Query without a read stream. Core runs the same check when it
reads your live manifest. If it fails there, Core ignores the declaration,
logs `Ignored a file provider that does not match the file-provider contract`
once per manifest, and keeps your other capabilities available.

A capability is compatible when:

- **Kind and stream.** `list` and `read` are Queries; `save` is an Action that
  requires an idempotency key. `read` declares a read stream, `save` a write
  stream, and `list` no stream. Stream sizes are not compared.
- **Input.** Your input accepts everything the contract may send, with the
  same rules as the [contact directory](/en/docs/platform/contact-directory#understand-compatibility):
  string syntax stays yours, but required fields, numeric bounds, and closed
  objects must fit the contract.
- **Result.** Every result you can return satisfies the contract data schema.
  Extra fields and narrower types are fine.

Test a declaration with the same function Cloud uses:

```ts
import { compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import { fileProviderIssues } from "@k2b/cloud/contracts";

const manifest = compileCapabilityManifest("archive", archiveCapabilities);

// An empty list means the declaration is valid.
const issues = fileProviderIssues(manifest);
```

Each issue names the `function`, the `localId` it points to, and the same
`code`, `path`, and `message` as `capabilityContractIssues`.

## Find providers

Every live application whose manifest in the capability catalog
(`GET /api/capabilities/v1/catalog`) has `fileProvider` is a provider. There is
no separate registration, route, or setting. The declaration names the local
IDs to call; invoke them through the ordinary capability client and stream
transfer.

## Roll out a provider

`fileProvider` is optional. A manifest without it keeps its earlier shape and
hash, so older Core releases keep accepting applications that do not offer
files. A Core release from before file providers rejects a manifest that
declares one, and the application's capabilities then disappear from its
catalog. Update Core before an application starts offering files; see
[Deprecations and migrations](/en/docs/reference/deprecations-and-migrations#files-offers-its-files-to-other-applications).
