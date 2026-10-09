---
title: Offer and choose files across applications
navTitle: File providers
section: Platform services
order: 558
description: Let people add files from any Cloud application with one chooser, save copies into applications such as Files, and implement the file-provider contract so your application can offer its files.
tags: [capabilities, files, contracts, streams, upload]
updated: 2026-10-09
---

# Offer and choose files across applications

A file provider lets other applications work with the files your application
stores. A consumer browses your folders, opens a file, and, if you allow it,
saves a new file into a folder. Any application that publishes a compatible
declaration becomes a provider, with the same contract and no special
treatment. Files is one.

Most applications only consume: their upload action calls `chooseFiles()` and
people add files from this device or from any provider, and their download
action gets a **Save to Files** beside it through `saveFiles()`. Implement the
contract when your application stores files that people want to use
elsewhere.

The contract is a set of schemas exported from `@k2b/cloud/contracts`, built
from ordinary [capabilities](/en/docs/platform/capabilities) and
[binary streams](/en/docs/platform/capabilities#binary-streams). Your
application keeps its own identifiers, permissions, storage, and routes.

## Add files from providers

Call `chooseFiles()` from `@k2b/cloud/browser/files` in the click or key
handler of your upload action, and pass the result to the upload path you
already have:

```ts
import { chooseFiles } from "@k2b/cloud/browser/files";

const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;

const attach = async () => {
  const files = await chooseFiles({ multiple: true, maxBytes: MAX_ATTACHMENT_BYTES });
  if (files.length > 0) await uploadAttachments(files);
};
```

It resolves ordinary `File` objects with name, type, size, and modification
time, or `[]` when the person cancels. Your limits, progress display,
permission checks, and scans keep working on them unchanged. Mail drafts,
Spaces task media, Grids file fields, Notebooks attachments, and Assistant
chats and Projects attach files this way.

- **No providers:** it opens the device's file dialog directly, as an
  `<input type="file">` would. That dialog needs the user activation of the
  click, so do not `await` anything before calling it. A visitor whom the
  capability catalog refuses, such as someone on a public page, has no
  providers either. That answer is not kept: the next call asks the catalog
  again, so a session renewed in the meantime finds its providers.
- **With providers:** it opens one chooser. **This device** comes first, then
  every provider. Inside a provider, people browse folders page by page,
  filter by name, and choose files. See the
  [file chooser](/en/ui/cloud/file-chooser) for the presentation.
- **`accept`** (`<input accept>` syntax) and **`maxBytes`** limit what can be
  chosen. Provider files that do not match are shown disabled with the reason.
  `maxBytes` is the most you take from providers in one choice: each file and
  all chosen files together stay within it. A single file is also limited by
  the provider's read limit; Files reads up to 50 MiB. Pass your real budget,
  for example the attachment limit of a draft. Files from the device are not
  checked here, so keep your own checks.
- **`multiple`** allows several files; it defaults to `false`. **`signal`**
  closes the chooser, or stops waiting for the device's dialog, and resolves
  `[]`.
- **Reads** run through the provider's read stream, at most two at a time,
  with progress per file. **Cancel** stops them. Each read checks the file's
  current size and type again before any byte moves, and a body that differs
  from the announced size fails instead of arriving cut off. The chosen files
  stay in browser memory until your upload has read them, at most `maxBytes`
  together. Without `maxBytes`, only the provider's limit per file applies.
- **Access:** every folder page and every read is an ordinary capability
  call as the signed-in person; the provider authorizes each one, and Cloud
  records it like any other call. Showing a provider is not a grant.

A chosen file is a copy. `chooseFiles()` does not return where it came from,
and later changes in the provider do not reach your copy. Keep one upload
action: do not add a second "From Cloud" button next to it.

### Use it with the dropzone and chat composer

`FileDropzone` and `ChatComposer` open the device's file dialog by default.
Pass `chooseFiles` as their `choose` function, and their click or **Attach
files** goes through the same chooser while drops and pasted files keep their
path:

```tsx
import { chooseFiles } from "@k2b/cloud/browser/files";
import { ChatComposer, FileDropzone } from "@k2b/ui";

<FileDropzone choose={() => chooseFiles({ multiple: true })} onDrop={(files) => void uploadAttachments(files)} />;

<ChatComposer
  {...composerProps}
  fileSelection={{ choose: () => chooseFiles({ multiple: true }), onSelect: addFiles }}
/>;
```

Both call `choose` inside the click or menu activation, so the device's dialog
still opens when there are no providers. When a dialog holds the dropzone, the
chooser opens over it and returns to it when it closes.

### Take dropped files too

Wherever your upload action lives, let people drop files from their computer
on the same area. Render
[`FileDropTarget`](/en/ui/input/file-drop-target) from `@k2b/ui` in the page,
detail panel, or dialog and pass dropped files to the same upload path:

```tsx
import { FileDropTarget } from "@k2b/ui";

<FileDropTarget
  label={t().dropToAttach}
  accept={ATTACHMENT_TYPES}
  disabled={!canAttach()}
  onDrop={(files) => void uploadAttachments(files)}
/>;
```

The whole workspace main area, detail panel, or dialog around it becomes the
target, never the sidebar, and a calm overlay says what dropping does. A more
specific target inside, such as a folder row, wins under the pointer. While the
chooser is open it takes dropped files itself, like files picked from this
device, and the page behind it does not. Keep the upload button; dropping
needs a pointer.

## Save files into providers

Where your application offers a download, offer to save a copy into a
provider too. `saveFiles()` from `@k2b/cloud/browser/files` opens one dialog
in which people pick an application that stores files and one of its
folders. Pass each file's name and its bytes, or a same-origin URL that the
page can read with its session, usually your own download route:

```tsx
import { SaveFilesButton } from "@k2b/cloud/browser/files";
import { IconButtonLink } from "@k2b/ui";

const downloadHref = `/api/archive/documents/${document.id}/content`;

<>
  <SaveFilesButton
    size="sm"
    files={() => [{ name: document.filename, content: downloadHref, mediaType: document.mediaType, size: document.size }]}
  />
  <IconButtonLink size="sm" href={downloadHref} download={document.filename} label={t().download}>
    <i class="ti ti-download" aria-hidden="true" />
  </IconButtonLink>
</>;
```

`SaveFilesButton` is an `IconButton` that calls `saveFiles(files())` and
takes the props of `IconButton`. Its label and tooltip say **Save
report.pdf to Files** once the page knows that Files is the one
application that stores files, and **Save report.pdf to…** before that or
when there are several. With `all`, it says **Save all to Files**, for a list
such as the attachments of a message. In a menu or a lightbox, use
`saveFilesLabel(locale)` and `SAVE_FILES_ICON` and call `saveFiles()` from
the action:

```ts
import { SAVE_FILES_ICON, saveFiles, saveFilesLabel } from "@k2b/cloud/browser/files";

const menu = [
  { icon: "ti ti-download", label: t().download, action: download },
  { icon: SAVE_FILES_ICON, label: saveFilesLabel(locale()), action: () => void saveFiles([source]) },
];
```

Mail attachments, one or all of a message, Spaces task media, Notebooks
attachments, Grids file fields, and Assistant chat and Project files save
this way.

- **Where:** the dialog lists every provider whose `save` passes
  `fileProviderIssues`. With one, such as Files, it opens straight in that
  provider; with none, it says calmly that no application can store files and
  points to the download. Inside a provider, people browse and filter folders
  as in the chooser. Files are listed so that taken names are visible, but
  only folders open. **Save** is enabled in a folder whose page reports
  `writable`; a provider's root is never a target.
- **Content:** a `Blob` is saved as it is. A URL is read only after the
  person chose a folder and pressed **Save**. Pass `size` when you know it: a
  file above the provider's write limit is then refused before it downloads.
  Without it, a `content-length` above the limit or a body that grows past it
  stops the read. Files takes up to 50 MiB. At most two files are read and
  saved at once, so the browser holds at most two of them.
- **Names:** path separators and control characters in `name` become `_`.
  Saving never replaces a file. When the name is taken, that file asks for
  another name, prefilled as `Report (2).pdf`; the other files continue.
- **Transfer:** each file is created through the provider's `save` Action
  with an idempotency key for its name and folder, then its bytes go through
  the write stream with progress. A double click or a retry never creates a
  second file. A write whose answer was lost is checked through the stream's
  status before it fails. **Cancel**, Escape, or `signal` stops what is still
  running and aborts its stream; files saved before stay saved.
- **Failures:** each file says why it failed: too large, not readable from
  your URL, no permission to save in the folder, or offline. **Save** tries
  the failed files again.
- **Confirmation:** when the dialog closes after saving, a confirmation names
  the file or the number of files and links to the provider's `open` link,
  for example **Show in Files**. `saveFiles()` resolves the saved files as
  `{ name, app, href? }`, or `[]` when nothing was saved.
- **Access:** every call runs as the signed-in person, and the provider
  authorizes each one again. A folder that is listed or `writable` is not a
  grant.

A saved file is a copy. Later changes in your application do not reach it.

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
  the folder; `limit` is 1 to 100 and defaults to 50. `cursor` continues from
  the previous page; send it with the same `parent`, `query`, and `limit`. A
  provider may reject a cursor with other values; Files answers
  `409 cursor_invalid`.
- **Entries** are `folder` or `file`, with an opaque `id` of up to 2,048
  characters and a `name`. Files also carry `size` and may carry `mediaType`.
  Both kinds may carry `updatedAt`, a Tabler `icon` class, and up to three
  display `tags` of up to 40 characters with an optional `tone`. Tags describe
  an entry; they do not filter or grant anything.
- **`read`** takes a file `id` from `list` and returns a read stream. Report
  the file's media type in the stream descriptor.
- **`save`** takes a `parent` folder `id`, a single file `name`, a
  `mediaType`, and the exact `size`, and returns a write stream. It only
  creates files: when the name exists, fail with status `409` and the code
  `FILE_PROVIDER_NAME_CONFLICT` (`FILE_NAME_CONFLICT`), from the Action or from
  the stream's `write` or `status`. Consumers ask for another name only on
  this code. Every other failure keeps its own code, even with status `409`,
  for example when storage is full. The completed write returns
  `{ file: { id, name, size } }`; the call that opens the stream has no file
  yet. Return an `open` link with it: the confirmation of `saveFiles()` links
  there.

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
      description: "Create one new document in a writable folder; an existing name fails with FILE_NAME_CONFLICT.",
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
for a durable upload reservation. When the name exists, `reserveDocument` and
`storeDocument` throw
`{ code: FILE_PROVIDER_NAME_CONFLICT, message, status: 409 }`. Follow
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
- Fail when storage cannot be reached, for example with `503`. Never answer
  an outage with an empty or shorter page; it looks like lost files.
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
  Extra fields and narrower types are fine, and literal values must lie within
  the contract's bounds.

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

`chooseFiles()` and `saveFiles()` do this for you. The page reads every
catalog page once per load, while the browser is idle, and keeps the
applications whose `list` and `read` pass `fileProviderIssues`; saving also
needs a `save` that passes. If the list is not known yet when someone
clicks, the chooser opens at once and providers join below **This device** as
they arrive. A failed catalog read shows **Try again** instead of an empty
list.

## Roll out a provider

`fileProvider` is optional. A manifest without it keeps its earlier shape and
hash, so nothing changes for applications that do not offer files.

Files declares `fileProvider`. Update Core before Files, and update every
other reader of the capability catalog once.

Before your own application declares `fileProvider`, update every reader of
the capability catalog to a release that
[reads manifests from newer releases](/en/docs/platform/capabilities#read-manifests-from-other-cloud-releases):

- Core;
- every other application built on `@k2b/cloud`, because its global search
  reads the catalog for Commands, and so do `listCapabilityCatalog()` and
  `getCapabilityCatalogApp()`;
- the `capabilities` plugin of each `cld` profile, with
  `cld plugins update capabilities`.

A reader of cloud-v0.29.0 or earlier cannot read a manifest that carries
`fileProvider`. Core drops the application from its catalog, and the other
readers fail on the whole catalog page, so every application disappears for
them, not only the provider. See
[Deprecations and migrations](/en/docs/reference/deprecations-and-migrations#applications-can-offer-files-to-other-applications).

Readers that know `fileProvider` are tolerant in turn: a declaration with a
function they do not know is left out as a whole, and the application's other
capabilities stay available. Core logs the declaration with the entries it
left out.
