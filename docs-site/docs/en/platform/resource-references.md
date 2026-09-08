---
title: Copy and paste Cloud resources
navTitle: Resource copy and paste
section: Platform services
order: 562
description: Preserve stable Cloud resource identity across application clipboard interactions.
tags: [capabilities, resources, clipboard, browser]
updated: 2026-08-18
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

`cloudUrl` is the canonical public origin derived on the server from the Core
setting `app.url`, for example with `publicCloudOrigin(await
coreSettings.get<string>("app.url"))`, and passed into the island. Never derive
it from `window.location`: gateway aliases and another Cloud installation may
serve the same application route.

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
