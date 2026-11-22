# Browser Modules

```ts
import { images, files, cookies, clipboard, notifications, kvStore, theme } from "@k2b/stdlib/browser";
```

All exports require a browser environment (DOM, `navigator`, `document`).

## images

Chainable image processing pipeline. Each transform creates a new canvas -- the original is never mutated.

```ts
import { img } from "@k2b/stdlib/browser";

// Chainable pipeline
const blob = await img
  .create(file)                              // File, Blob, URL, HTMLImageElement, or Canvas
  .then(img.resize(800, 600, "cover"))       // "cover" | "contain" | "fill"
  .then(img.filter(img.filters.vintage))     // CSS filter string
  .then(img.toBlob("webp"));                 // "webp" | "jpeg" | "png"

// Other transforms
img.crop(x, y, w, h)
img.rotate(90)                               // 90 | 180 | 270
img.flip(true, false)                        // horizontal, vertical
img.apply((ctx, canvas) => {                 // custom drawing
  ctx.font = "24px sans-serif";
  ctx.fillText("Watermark", 10, canvas.height - 30);
})

// Output formats
img.toBlob("webp", 0.9)
img.toBase64("jpeg")
img.toFile("photo.webp")
img.toCanvas

// Built-in presets
const avatar = await img.presets.avatar(file, 512);         // center-crop, base64
const thumb = await img.presets.thumbnail(file, 300);       // contain with letterbox

// Filter presets
img.filters.vintage     // "sepia(0.3) contrast(1.1) brightness(1.1) saturate(1.3)"
img.filters.grayscale   // "grayscale(1) contrast(1.1)"
img.filters.dramatic
img.filters.soft
img.filters.blur(5)     // generator functions
img.filters.brightness(1.2)

// Batch processing
const blobs = await img.batch(
  fileList,
  (data) => data.then(img.resize(300, 300, "cover")).then(img.toBlob("webp")),
  { onProgress: ({ percent }) => console.log(`${Math.round(percent * 100)}%`) },
);
```

## files

File downloads, ZIP creation, native file dialogs, path building, MIME utilities, and OPFS access.

### Downloads

```ts
import { files } from "@k2b/stdlib/browser";

files.downloadFileFromContent("hello world", "greeting.txt");
files.downloadFileFromContent(pngBytes, "photo.png", "image/png");

const link = files.createDownloadLink(content, "file.txt");  // <a> element
```

### ZIP

Uses native CompressionStream/DecompressionStream (no external dependencies).

```ts
const zipData = await files.createZip([
  { filename: "hello.txt", source: "Hello World" },
  { filename: "data.json", source: JSON.stringify({ foo: "bar" }) },
]);

// Create and download in one call
await files.downloadAsZip(zipFiles, "archive.zip");

// Extract files from a ZIP archive
const extracted = await files.extractZip(zipData, {
  onProgress: ({ percent }) => console.log(`${Math.round(percent * 100)}%`),
});
```

### Compression

```ts
// GZIP compress a Uint8Array
const compressed = await files.compress(data);

// GZIP decompress a Uint8Array
const decompressed = await files.decompress(compressed);
```

### File dialogs

```ts
const file = await files.showFileDialog({ accept: ".pdf" });
const images = await files.showFileDialog({ accept: ".jpg,.png", multiple: true });
const folder = await files.showFolderDialog("image/*");
```

### Path builder

```ts
const p = files.path`uploads/${userName}/${fileName}.txt`;
// "uploads/john-doe-a3f2b1/my-file-c8d4e9.txt"
```

Each interpolated segment is sanitized, lowercased, truncated, and hashed to prevent collisions.

### MIME utilities

Built-in MIME type mapping, no external dependencies.

```ts
files.mimeTypesToAccept("image/jpeg,image/png");   // ".jpg,.jpeg,.png,image/jpeg,image/png"
files.checkMimeType(file, "image/*");              // true for any image
files.checkMimeType(file, ".pdf,image/*");         // true for PDFs or images

// Look up MIME type from filename or extension
files.getMimeType("photo.jpg");          // "image/jpeg"
files.getMimeType(".png");               // "image/png"

// Look up extension from MIME type
files.getExtension("image/jpeg");        // ".jpg"
files.getExtension("application/pdf");   // ".pdf"
```

### OPFS

Origin Private File System -- persistent, sandboxed storage.

```ts
await files.OPFS.write("data/images/photo.bin", uint8Array);
const data = await files.OPFS.read("data/images/photo.bin");
await files.OPFS.delete("data/images/photo.bin");
const entries = await files.OPFS.ls("data/images");  // ["photo.bin", "thumbs/"]
```

## cookies

Read, write, and delete browser cookies. Supports both raw strings and JSON values.

```ts
import { cookies } from "@k2b/stdlib/browser";

// JSON cookies (auto-serialized, shallow-merged with defaults)
cookies.writeJsonCookie("prefs", { theme: "dark", lang: "en" });
const prefs = cookies.readJsonCookie("prefs", { theme: "light", lang: "en" });

// Raw string cookies
cookies.writeCookie("token", "abc123");
const token = cookies.readCookie("token");  // "abc123" | null

cookies.deleteCookie("token");
```

Defaults: `path=/`, `SameSite=Lax`, 1-year `max-age`, auto `Secure` on HTTPS.
For SolidJS apps that need reactive persistent state with cross-tab sync, see `localStore` from `@k2b/stdlib/solid`.

## clipboard

Copy text to the system clipboard. Requires a secure context (HTTPS or localhost).
For SolidJS apps, see `clipboard.create()` from `@k2b/stdlib/solid` which adds a reactive `wasCopied` signal that auto-resets after a timeout.

```ts
import { clipboard } from "@k2b/stdlib/browser";

await clipboard.copy("Hello, world!");
```

## notifications

Native browser notification permission management and display.

```ts
import { notifications } from "@k2b/stdlib/browser";

notifications.isSupported();           // true/false
notifications.getPermission();         // "granted" | "denied" | "default"
const allowed = await notifications.requestPermission();

const handle = notifications.show({
  title: "New message",
  body: "Alice: Hey, are you there?",
  icon: "/avatar.png",
  tag: "chat-42",
  autoCloseMs: 5000,
  onClick: () => window.location.assign("/chat/42"),
});

handle?.close();  // programmatic dismiss
```

## kvStore

Persistent key-value store backed by the Origin Private File System (OPFS). Like `localStorage`, but async and without the 5 MB size limit.

```ts
import { kvStore } from "@k2b/stdlib/browser";

// JSON data
await kvStore.set("user:1", { name: "Alice", age: 30 });
const user = await kvStore.get<{ name: string }>("user:1");

// Binary data
await kvStore.setBytes("files:photo.raw", largeUint8Array);
const photo = await kvStore.getBytes("files:photo.raw");

// O(1) key operations (in-memory index)
await kvStore.has("user:1");              // true
await kvStore.keys("user:");             // ["user:1"]
await kvStore.meta("user:1");            // { key, size, timestamp, type }
await kvStore.size();                     // 2

// Cleanup
await kvStore.delete("user:1");
await kvStore.clear();

// Watch for changes (same tab + cross-tab via BroadcastChannel)
const unwatch = kvStore.watch((e) => {
  console.log(`${e.type}: ${e.key}`);     // "set", "delete", or "clear"
}, "user:");
unwatch();
```

Small values (4 KB or less) are stored inline in the index file. Larger values spill into individual blob files. Writes are serialized with Web Locks; reads are lock-free.

## theme

Light/dark mode toggle with cookie persistence. Works with any CSS framework
that uses a root-level class (Tailwind, etc.). SSR-safe.

```ts
import { theme } from "@k2b/stdlib/browser";

theme.getCurrent();  // "light" | "dark"
theme.set("dark");   // applies class + persists to cookie
theme.toggle();      // switches to opposite mode
```
