---
title: Copy and paste Cloud resources
navTitle: Resource copy and paste
section: Platform services
order: 562
description: Preserve stable Cloud resource identity across application clipboard interactions.
tags: [capabilities, resources, clipboard, browser]
updated: 2026-10-27
---

# Copy and paste Cloud resources

Cloud applications can copy one `CloudResourceRef` with a machine-readable web
custom clipboard format and a normal plain-text fallback. A receiving Cloud
application can recognize the reference without inferring identity from prose.

The reference contains only the resource's qualified capability Type and
stable app-owned public ID. It is not a snapshot, permission, access token, or
instruction. The receiving application must resolve the current canonical
reader and the owning application must authorize every read normally. Read
[App capabilities](/en/docs/platform/capabilities#types-name-resources) first.

## Write a reference

Use the browser-only resource clipboard entry point:

```ts
import { cloudResourceClipboard } from "@k2b/cloud/browser/resource-clipboard";

await cloudResourceClipboard.write({
  cloudUrl,
  ref: { type: "inventory.item", id: item.id },
  fallbackText: new URL(`/app/inventory/items/${item.id}`, cloudUrl).href,
});
```

Read `cloudUrl` with `cloudOrigin()` from
`@k2b/cloud/browser/resource-links`. `Layout` and `AdminLayout` supply the
canonical public origin from Core's `app.url` through shell data; it is omitted
when unset. `MinimalLayout` does not install shell data, so its accessor
returns `null`. Check for `null` before copying a structured reference. Never
derive it from `window.location`: gateway aliases and another Cloud
installation may serve the same application route.

Cloud writes the versioned JSON representation as
`web application/vnd.k2b.cloud-resource-ref+json` and writes `fallbackText` as
`text/plain` in the same clipboard item. When the browser does not support web
custom formats, writing falls back to `text/plain`. Clipboard permission errors
still reject the operation so the UI can present honest feedback.

The version 1 custom representation contains exactly this JSON shape:

```json
{
  "version": 1,
  "cloudUrl": "https://cloud.example",
  "ref": {
    "type": "inventory.item",
    "id": "k3P9xQ"
  }
}
```

`cloudUrl` scopes the identity to one configured Cloud installation. A reader
accepts the structured reference only when it matches its own configured
`app.url`; cross-installation paste retains the normal URL fallback. Do not add
titles, resource URLs, snapshots, permissions, or reader names to this payload.
They either become stale or duplicate the live capability manifest. The
separate `text/plain` representation owns the human-usable fallback.

Solid islands can use the generic stdlib writer for transient success and
error state without creating an application-local timer:

```tsx
import { clipboard } from "@k2b/stdlib/solid";
import { cloudResourceClipboard } from "@k2b/cloud/browser/resource-clipboard";

const resourceCopy = clipboard.createWriter({
  write: cloudResourceClipboard.write,
  copiedFor: 1800,
});

await resourceCopy.copy({
  cloudUrl,
  ref: { type: "inventory.item", id: item.id },
  fallbackText: itemUrl,
});

resourceCopy.wasCopied(); // true only after a successful write
resourceCopy.error(); // the latest Clipboard API failure, if any
```

## Read a reference

```ts
const ref = await cloudResourceClipboard.read(cloudUrl);
if (ref) await attachResource(ref);
```

`read()` uses the asynchronous Clipboard API. It returns `null` when the exact
custom format is absent or invalid. It never interprets the plain-text fallback
as identity. A paste surface may pass already-read `ClipboardItem` objects to
avoid a second read:

```ts
const ref = await cloudResourceClipboard.read(cloudUrl, items);
```

Use `parse()` and `serialize()` only when code already owns the raw custom
format payload. Parsing is strict, versioned, and bounded to 4 KiB.

## Recognize a resource during paste

Do not install a global paste interceptor. Resource-aware editors and pickers
should opt into recognition; ordinary text controls retain normal paste
behavior.

Prefer the synchronous `clipboardData` supplied by the user-initiated paste
event. Only prevent the default paste after the exact custom representation was
read and accepted for the configured Cloud URL. Normal text keeps the browser's
native cursor, selection, and undo behavior:

```ts
import { cloudResourceClipboard } from "@k2b/cloud/browser/resource-clipboard";

const onPaste = (event: ClipboardEvent) => {
  const clipboardData = event.clipboardData;
  if (!clipboardData?.types.includes(cloudResourceClipboard.webFormat)) return;
  const ref = cloudResourceClipboard.parse(
    clipboardData.getData(cloudResourceClipboard.webFormat),
    cloudUrl,
  );
  if (!ref) return;
  event.preventDefault();
  void attachResource(ref);
};
```

Browsers may omit custom representations from the paste event. Resource-aware
surfaces should therefore offer an explicit **Paste Cloud resource** action
that calls `read(cloudUrl)` from the user gesture. Do not invoke the
permission-controlled asynchronous read for every ordinary text paste.

Recognizing the payload establishes identity only. Treat it as untrusted input,
resolve the current canonical reader from the live manifest, and let the owning
application authorize the read. Never execute an Action merely because its
target appeared on the clipboard.

## Copy a Cloud ID

Give every resource with a reader a **Copy Cloud ID** entry as the last
section of its "…" menu: in its detail panel and in its row or context menu.
Agents and people copy the same identity there, and it pastes into every Cloud
surface that recognizes resources. Islands use the shared entry, which needs
no `cloudUrl` prop because the page shell carries the canonical Cloud origin:

```tsx
import { useCloudIdCopy } from "@k2b/cloud/browser/cloud-id";
import { DetailPanel } from "@k2b/ui";

const cloudId = useCloudIdCopy();

<DetailPanel.Header
  title={item.name}
  menu={[...itemActions(), ...cloudId.section({ type: "inventory.item", id: item.id })]}
  actions={closeButton}
/>;
```

The entry writes the structured reference and the resource's permalink
`/open/<type>/~<id>` as text, shows a toast, and on phones runs inside the tap
as the clipboard requires. The structured format needs code that loads once
the page is idle; a click before that copies the permalink text alone, which
every Cloud paste surface still recognizes. `section()` accepts several targets with their own
labels, such as a message and its conversation, and returns no section when
the Cloud URL is not configured. Use the ID the Type's reader accepts.

## Select a place for a panel

A page can report its current resource ref to the visible panel through
`Layout.context` or `publishPageContext()`. The shell handles per-provider
consent. A panel ref selects a resource and grants no access; the provider
reads through its own authorized server. See
[Panel page context](/en/docs/platform/panels#page-context).

## Recognize a pasted Cloud link

Use the browser helper when pasted text may be an ordinary application URL
or a resource permalink:

```ts
import { cloudOrigin, resolveCloudUrl } from "@k2b/cloud/browser/resource-links";

const origin = cloudOrigin(); // canonical public origin, or null
const resource = await resolveCloudUrl(pastedText, { signal });
if (resource) await attachResource(resource.ref);
```

`resolveCloudUrl(text, { signal? })` trims the text and accepts one URL token:
a root-relative path, or an absolute HTTP(S) URL on the canonical Cloud
origin. It rejects other text before sending a request. Application pages
must be [declared by their Type](/en/docs/platform/capabilities#declare-pages-for-pasted-links).
Permalinks use the existing `/open/<type>/~<encoded-id>` format.

The result is `{ ref, title, icon?, href }`: the current reader's matching ref
supplies its title and icon, with the Type's localized presentation as
fallback. `href` is the authorized reader's `open` link, falling back to
`edit`. Unsupported, ambiguous, missing, denied, unavailable, and invalid
results all return `null`. Cancellation also returns `null`.

Core exposes authenticated `POST /api/resources/resolve` with JSON `{ url }`
(a string of at most 8192 characters). Success returns the result above with
status 200; every resolution failure returns 404 with
`{ "error": "Resource not found" }`. This read-only POST accepts OAuth read
scope. Authentication failures retain the normal Core authentication response.
Foreign origins never invoke an application; the reader authorizes every
candidate under the caller's authority.

Server code can call `resolveCloudResourceUrl({ url, request, authority,
locale? })` from `@k2b/cloud/api` for the same result or `null`. Agents and
scripts can run `cld capabilities resolve <url>`; its text, JSON, and JSONL
output include the ref, title, and an absolute `permalink` on the selected
profile's server.
