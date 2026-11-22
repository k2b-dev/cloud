# @k2b/stdlib/browser

Browser utility modules. All exports require a DOM environment (`document`, `navigator`, `window`).

## Import

```ts
import {
  files,
  images,
  cookies,
  clipboard,
  notifications,
  kvStore,
  theme,
} from "@k2b/stdlib/browser";
```

The `images` namespace is also exported as `img` for brevity:

```ts
import { img } from "@k2b/stdlib/browser";
```

Individual functions and types can also be imported directly (they are re-exported at the top level):

```ts
import {
  downloadFileFromContent,
  createZip,
  showFileDialog,
  OPFS,
  copyToClipboard,
  readJsonCookie,
} from "@k2b/stdlib/browser";
```

---

## files

File downloads, ZIP archives, file/folder picker dialogs, path building, MIME type utilities, and OPFS access.

ZIP and compression operations use native CompressionStream/DecompressionStream (no external dependencies).

### files.downloadFileFromContent

Triggers a browser file download from in-memory content.

```ts
files.downloadFileFromContent(
  content: string | Uint8Array | ArrayBuffer | Blob,
  filename: string,
  mimeType?: string // default: "text/plain"
): void
```

```ts
files.downloadFileFromContent("hello world", "greeting.txt");
files.downloadFileFromContent(pngBytes, "photo.png", "image/png");
```

### files.createZip

Creates an in-memory ZIP archive from an array of file entries. Returns `Uint8Array`.

```ts
files.createZip(
  files: ZipFile[],
  compressionLevel?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 // default: 6
): Promise<Uint8Array>
```

`ZipFile` shape:

```ts
type ZipFile = {
  filename: string;
  source: string | Blob | ArrayBuffer | Uint8Array;
  mimeType?: string; // informational only, not used by ZIP format
};
```

```ts
const zipData = await files.createZip([
  { filename: "hello.txt", source: "Hello World" },
  { filename: "data.json", source: JSON.stringify({ foo: "bar" }) },
]);
```

### files.downloadAsZip

Creates a ZIP and triggers a browser download. Combines `createZip` and `downloadFileFromContent`.

```ts
files.downloadAsZip(
  files: ZipFile[],
  zipFilename?: string, // default: "download.zip"
  compressionLevel?: 0-9 // default: 6
): Promise<void>
```

```ts
await files.downloadAsZip(
  [
    { filename: "image.webp", source: imageBlob },
    { filename: "data.json", source: jsonString },
  ],
  "my-files.zip",
);
```

### files.createDownloadLink

Creates an `<a>` element with a download link without appending it to the DOM. The object URL is auto-revoked 100ms after click or after 60 seconds if never clicked.

```ts
files.createDownloadLink(
  content: BlobPart,
  filename: string,
  mimeType?: string,   // default: "text/plain"
  linkText?: string,    // default: "Download"
  className?: string    // default: "hover-text"
): HTMLAnchorElement
```

```ts
const link = files.createDownloadLink(csvString, "report.csv", "text/csv");
document.getElementById("downloads")!.appendChild(link);
```

### files.showFileDialog

Opens the native file picker. Returns a single `File` or an array of `File` objects.

```ts
// Single file
files.showFileDialog(conf: { accept?: string; multiple?: false }): Promise<File>

// Multiple files
files.showFileDialog(conf: { accept?: string; multiple: true }): Promise<File[]>
```

Throws if the user cancels or selects nothing.

```ts
const file = await files.showFileDialog({ accept: ".pdf" });
const images = await files.showFileDialog({ accept: ".jpg,.png", multiple: true });
```

### files.showFolderDialog

Opens a native folder picker. Returns all files in the selected directory recursively. Optionally filters by MIME type.

```ts
files.showFolderDialog(accept?: string): Promise<File[]>
```

```ts
const allFiles = await files.showFolderDialog();
const imageFiles = await files.showFolderDialog("image/*");
```

### files.path

Tagged template literal that builds sanitized file paths. Interpolated values are sanitized per segment (non-word characters replaced with hyphens, lowercased, truncated to 20 chars, hash suffix appended to reduce collisions). Static parts pass through unchanged.

```ts
files.path(strings: TemplateStringsArray, ...values: unknown[]): string
```

```ts
const p = files.path`uploads/${userName}/${fileName}.txt`;
// e.g. "uploads/john-doe-a3f2b1/my-file-c8d4e9.txt"
```

### files.mimeTypesToAccept

Converts comma-separated MIME types to an HTML `<input accept>` value. Resolves specific MIME types to file extensions via the `mime` package.

```ts
files.mimeTypesToAccept(mimeTypes: string): string
```

```ts
files.mimeTypesToAccept("image/*,application/pdf");
// "image/*,.pdf,application/pdf"

files.mimeTypesToAccept("image/jpeg,image/png");
// ".jpg,.jpeg,.png,image/jpeg,image/png"
```

### files.getMimeType

Looks up the MIME type for a filename or file extension. Returns `undefined` if unknown.

```ts
files.getMimeType(filenameOrExt: string): string | undefined
```

```ts
files.getMimeType("photo.jpg");      // "image/jpeg"
files.getMimeType(".png");           // "image/png"
files.getMimeType("report.pdf");     // "application/pdf"
files.getMimeType("unknown.xyz");    // undefined
```

### files.getExtension

Looks up the primary file extension for a MIME type. Returns `undefined` if unknown.

```ts
files.getExtension(mimeType: string): string | undefined
```

```ts
files.getExtension("image/jpeg");        // ".jpg"
files.getExtension("application/pdf");   // ".pdf"
files.getExtension("text/html");         // ".html"
files.getExtension("made/up");           // undefined
```

### files.checkMimeType

Checks whether a file or MIME type string matches an accept filter. Supports extension (`.pdf`), wildcard (`image/*`), and exact (`application/pdf`) formats.

```ts
files.checkMimeType(fileOrType: File | string, accept: string): boolean
```

Returns `true` if `accept` is empty.

```ts
files.checkMimeType(file, "image/*");           // true for any image
files.checkMimeType(file, ".pdf,image/*");      // true for PDFs or images
files.checkMimeType("application/pdf", ".pdf"); // true
```

### files.OPFS

Wrapper around the Origin Private File System API. Requires a secure context and a browser supporting `navigator.storage.getDirectory()`.

```ts
files.OPFS.getDirHandle(segments: string[], create?: boolean): Promise<FileSystemDirectoryHandle>
files.OPFS.write(path: string, data: Uint8Array): Promise<void>
files.OPFS.read(path: string): Promise<Uint8Array | undefined>
files.OPFS.delete(path: string): Promise<void>
files.OPFS.ls(dirPath?: string): Promise<string[]>
```

- `write` creates parent directories automatically. Overwrites existing files.
- `read` returns `undefined` (does not throw) if the file or directory does not exist.
- `delete` removes files or directories recursively.
- `ls` returns entry names sorted, with `/` suffix on directories. Returns `[]` if directory does not exist.

```ts
await files.OPFS.write("data/images/photo.bin", uint8Array);
const data = await files.OPFS.read("data/images/photo.bin");
await files.OPFS.ls("data/images"); // ["photo.bin", "thumbnails/"]
await files.OPFS.delete("data/images/photo.bin");
```

---

## images (also exported as `img`)

Functional, chainable image processing API. All operations produce new `ImgData` containers -- the original is never mutated. Transforms return functions of type `(ImgData | Promise<ImgData>) => Promise<T>`, so they compose with `Promise.then`.

### Types

```ts
type ImgData = Readonly<{
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
}>;

type Source = File | Blob | HTMLImageElement | HTMLCanvasElement | string;
type Fit = "cover" | "contain" | "fill";
type Format = "jpeg" | "webp" | "png";
```

### images.create

Loads an image from various sources and produces an `ImgData`.

```ts
images.create(source: Source): Promise<ImgData>
```

Accepted sources: `File`, `Blob`, `HTMLImageElement`, `HTMLCanvasElement`, or a URL string. Sets `crossOrigin: "anonymous"` for URL strings. Revokes object URLs automatically for Blob/File inputs.

```ts
const data = await images.create(file);
const data2 = await images.create("https://example.com/photo.jpg");
```

### images.resize

Resizes an image. If only one dimension is given, the other is calculated from the aspect ratio.

```ts
images.resize(
  width?: number,
  height?: number,
  fit?: Fit,                  // default: "fill"
  letterboxColor?: string     // default: "#000" (only used for "contain")
): Transform
```

Fit modes:
- `"fill"` -- stretches to exact dimensions, ignoring aspect ratio.
- `"cover"` -- scales and center-crops to fill the area (may clip).
- `"contain"` -- scales to fit within dimensions, fills empty space with `letterboxColor`.

```ts
const resized = await images.create(file)
  .then(images.resize(800, 600, "cover"));
```

### images.crop

Crops to a rectangle at pixel coordinates from the top-left corner.

```ts
images.crop(x: number, y: number, w: number, h: number): Transform
```

```ts
const cropped = await images.create(file)
  .then(images.crop(100, 50, 400, 300));
```

### images.filter

Applies a CSS filter string (same syntax as the CSS `filter` property).

```ts
images.filter(filterStr: string): Transform
```

```ts
const filtered = await images.create(file)
  .then(images.filter("grayscale(1) brightness(1.1)"));

// Using a preset:
const vintage = await images.create(file)
  .then(images.filter(images.filters.vintage));
```

### images.rotate

Rotates by 90, 180, or 270 degrees. Swaps dimensions for 90/270.

```ts
images.rotate(deg: 90 | 180 | 270): Transform
```

### images.flip

Flips along one or both axes.

```ts
images.flip(horizontal?: boolean, vertical?: boolean): Transform
// defaults: horizontal = true, vertical = false
```

```ts
const mirrored = await images.create(file).then(images.flip());
const flippedVertical = await images.create(file).then(images.flip(false, true));
```

### images.apply

Applies a custom drawing function to a copy of the canvas. Use for watermarks, overlays, or custom pixel manipulation.

```ts
images.apply(fn: (ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement) => void): Transform
```

```ts
const watermarked = await images.create(file)
  .then(images.apply((ctx, canvas) => {
    ctx.font = "24px sans-serif";
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    ctx.fillText("Watermark", 10, canvas.height - 30);
  }));
```

### Output converters

```ts
images.toBlob(format?: Format, quality?: number): Transform<Blob>
// defaults: format = "webp", quality = 0.9

images.toBase64(format?: Format, quality?: number): Transform<string>
// defaults: format = "webp", quality = 0.9
// Returns a data URL: "data:image/webp;base64,..."

images.toFile(name: string, format?: Format, quality?: number): Transform<File>
// defaults: format = "webp", quality = 0.9

images.toCanvas: (data: ImgData | Promise<ImgData>) => Promise<HTMLCanvasElement>
// Note: toCanvas is a direct function, not a factory
```

```ts
const blob = await images.create(file)
  .then(images.resize(800, 600, "cover"))
  .then(images.filter(images.filters.vintage))
  .then(images.toBlob("webp"));

const dataUrl = await images.create(file)
  .then(images.resize(200, 200, "cover"))
  .then(images.toBase64("jpeg", 0.8));

const outputFile = await images.create(file)
  .then(images.resize(1024))
  .then(images.toFile("processed.webp"));
```

### images.batch

Processes multiple images through the same pipeline sequentially. Reports progress via callback.

```ts
images.batch<T>(
  sources: Source[],
  transform: (data: Promise<ImgData>) => Promise<T>,
  opts?: { onProgress?: (progress: { current: number; total: number; percent: number }) => void }
): Promise<T[]>
```

Images are processed one at a time to avoid excessive memory pressure.

```ts
const blobs = await images.batch(
  fileList,
  (data) => data
    .then(images.resize(800, 600, "cover"))
    .then(images.filter(images.filters.vintage))
    .then(images.toBlob("webp")),
  { onProgress: ({ percent }) => console.log(`${Math.round(percent * 100)}%`) },
);
```

### images.filters

Predefined CSS filter presets and generator functions.

```ts
// Static presets (strings)
images.filters.vintage   // "sepia(0.3) contrast(1.1) brightness(1.1) saturate(1.3)"
images.filters.grayscale // "grayscale(1) contrast(1.1)"
images.filters.dramatic  // "contrast(1.4) brightness(0.9) saturate(1.2)"
images.filters.soft      // "brightness(1.05) saturate(0.9) blur(0.5px)"

// Generator functions
images.filters.blur(px: number): string       // e.g. "blur(5px)"
images.filters.brightness(v: number): string  // e.g. "brightness(1.2)"
images.filters.contrast(v: number): string    // e.g. "contrast(1.4)"
images.filters.saturate(v: number): string    // e.g. "saturate(1.5)"
images.filters.hue(deg: number): string       // e.g. "hue-rotate(90deg)"
```

### images.presets

Ready-to-use processing presets combining multiple transforms.

```ts
images.presets.avatar(
  src: Source,
  size?: number,          // default: 512
  quality?: number,       // default: 0.8
  format?: Format         // default: "webp"
): Promise<string>        // returns base64 data URL
// Center-crops to square, applies subtle contrast/saturation boost

images.presets.thumbnail(
  src: Source,
  maxSize?: number,       // default: 300
  letterboxColor?: string, // default: "#000"
  format?: Format         // default: "webp"
): Promise<string>        // returns base64 data URL
// Fits within square, fills empty space with letterboxColor
```

```ts
const avatarDataUrl = await images.presets.avatar(file, 256);
const thumbDataUrl = await images.presets.thumbnail(file, 150, "#fff");
```

---

## cookies

Read, write, and delete browser cookies. Supports both raw string and JSON-encoded values.

All writes default to: `path=/`, `SameSite=Lax`, 1-year max-age, auto-detect HTTPS for `Secure` flag.

### cookies.readJsonCookie

Reads and parses a JSON-encoded cookie. Returns `defaultValue` on missing/corrupt cookies. When both `defaultValue` and parsed value are plain objects (not arrays), the result is shallow-merged so newly added fields in `defaultValue` are preserved.

```ts
cookies.readJsonCookie<T>(name: string, defaultValue: T): T
```

```ts
const prefs = cookies.readJsonCookie("prefs", { theme: "light", lang: "en" });
// If cookie has { theme: "dark" }, returns { theme: "dark", lang: "en" }
```

### cookies.writeJsonCookie

Writes a value as a JSON-encoded, URI-encoded cookie.

```ts
cookies.writeJsonCookie<T>(
  name: string,
  data: T,
  maxAge?: number,    // default: 31536000 (1 year)
  secure?: boolean    // default: auto-detect HTTPS
): void
```

```ts
cookies.writeJsonCookie("prefs", { theme: "dark", lang: "en" });
cookies.writeJsonCookie("session", { token: "abc" }, 3600); // 1 hour
```

### cookies.readCookie

Reads a raw string cookie. Returns `null` if not found.

```ts
cookies.readCookie(name: string): string | null
```

```ts
const token = cookies.readCookie("auth_token");
```

### cookies.writeCookie

Writes a raw string cookie (URI-encoded).

```ts
cookies.writeCookie(
  name: string,
  value: string,
  maxAge?: number,    // default: 31536000 (1 year)
  secure?: boolean    // default: auto-detect HTTPS
): void
```

```ts
cookies.writeCookie("auth_token", "abc123");
cookies.writeCookie("temp", "value", 300); // 5 minutes
```

### cookies.deleteCookie

Deletes a cookie by setting max-age to 0.

```ts
cookies.deleteCookie(name: string): void
```

```ts
cookies.deleteCookie("auth_token");
```

---

## clipboard

Clipboard utilities. Requires a secure context (HTTPS or localhost).
For SolidJS apps, use `clipboard.create()` from `@k2b/stdlib/solid` which adds a reactive `wasCopied` signal that auto-resets after a timeout.

### clipboard.copy

Copies text to the system clipboard using the Clipboard API. The browser may prompt for permission on first use.

```ts
clipboard.copy(text: string): Promise<void>
```

```ts
await clipboard.copy("Hello, world!");
await clipboard.copy(JSON.stringify(data, null, 2));
```

---

## notifications

Native browser notification permission management and display. SSR-safe: returns `null`/`false` in non-browser environments.

### Types

```ts
type NotificationPermissionState = "granted" | "denied" | "default";

type ShowNotificationOptions = {
  title: string;
  body: string;
  icon?: string;         // Small icon URL, typically 128x128 px
  image?: string;        // Large preview image (Chromium only)
  tag?: string;          // Deduplication tag -- same tag replaces previous
  autoCloseMs?: number;  // Auto-close after N ms (disabled when omitted)
  onClick?: () => void;  // Called on user click
  onClose?: () => void;  // Called on close (manual, auto, or OS)
};

type NotificationHandle = {
  close: () => void;     // Safe to call multiple times
};
```

### notifications.isSupported

Check whether the Notification API is available. Returns `false` during SSR or in unsupported browsers.

```ts
notifications.isSupported(): boolean
```

### notifications.getPermission

Get the current permission state without prompting. Falls back to `"denied"` when the API is unavailable.

```ts
notifications.getPermission(): NotificationPermissionState
```

### notifications.requestPermission

Request permission from the user. Triggers the browser's native permission dialog. Returns `false` in non-browser environments or if already denied.

```ts
notifications.requestPermission(): Promise<boolean>
```

```ts
const allowed = await notifications.requestPermission();
if (allowed) {
  notifications.show({ title: "Enabled", body: "You will now receive notifications." });
}
```

### notifications.show

Display a native browser notification. Returns a handle with `close()`, or `null` if unsupported/not permitted.

```ts
notifications.show(options: ShowNotificationOptions): NotificationHandle | null
```

```ts
const handle = notifications.show({
  title: "New message",
  body: "Alice: Hey, are you there?",
  icon: "/avatar.png",
  tag: "chat-42",
  autoCloseMs: 5000,
  onClick: () => window.location.assign("/chat/42"),
  onClose: () => console.log("notification dismissed"),
});

// Close programmatically if needed
handle?.close();
```

---

## kvStore

Persistent key-value store backed by the Origin Private File System (OPFS). Think of it as `localStorage`, but async and without the 5 MB size limit. Requires a secure context (HTTPS or localhost).

Key characteristics:
- **No size limit** -- bounded only by available disk space.
- **Binary support** -- store raw `Uint8Array` data without serialization overhead via `setBytes`/`getBytes`.
- **O(1) lookups** -- `has`, `keys`, `meta`, and `size` resolve from an in-memory index and never touch disk after initial load.
- **Concurrency-safe** -- Web Locks serialize writes; reads are lock-free.
- **Cross-tab sync** -- a `BroadcastChannel` keeps every tab's in-memory cache in sync.
- **Namespace-friendly** -- use key prefixes (e.g. `"user:"`, `"cache:"`) and query with `keys(prefix)`.

Small values (4 KB or less) are stored inline in the index file. Larger values spill to individual blob files.

### Types

```ts
type KVEntryMeta = {
  key: string;
  size: number;
  timestamp: number;
  type: "json" | "bin";
};

type KVEvent = {
  type: "set" | "delete" | "clear";
  key: string;  // empty string for "clear" events
};
```

### kvStore.set

Store a JSON-serializable value. Overwrites any previous entry under the same key.

```ts
kvStore.set(key: string, value: unknown): Promise<void>
```

```ts
await kvStore.set("user:1", { name: "Alice", age: 30 });
await kvStore.set("prefs", { theme: "dark" });
await kvStore.set("counter", 42);
```

**Throws** `TypeError` when `value` is not JSON-serializable (top-level `undefined`, a function, or a `Symbol`). Previously silent — produced a corrupt `has(k) === true` + `get(k) === undefined` half-state. Use `kvStore.delete(key)` to remove an entry.

### kvStore.get

Retrieve a JSON value. Returns `undefined` for missing keys or keys stored with `setBytes`.

```ts
kvStore.get<T = unknown>(key: string): Promise<T | undefined>
```

```ts
const user = await kvStore.get<{ name: string; age: number }>("user:1");
if (user) console.log(user.name);
```

### kvStore.setBytes

Store raw binary data. Data 4 KB or less is inlined (base64) in the index; larger data gets its own blob file.

```ts
kvStore.setBytes(key: string, data: Uint8Array): Promise<void>
```

```ts
const response = await fetch("/large-dataset.bin");
await kvStore.setBytes("data:raw", new Uint8Array(await response.arrayBuffer()));
```

### kvStore.getBytes

Retrieve raw binary data. Returns `undefined` for missing keys or keys stored with `set`.

```ts
kvStore.getBytes(key: string): Promise<Uint8Array | undefined>
```

```ts
const photo = await kvStore.getBytes("files:photo.raw");
if (photo) processImage(photo);
```

### kvStore.has

Check whether a key exists. O(1) from in-memory index.

```ts
kvStore.has(key: string): Promise<boolean>
```

### kvStore.keys

List all keys, optionally filtered by prefix. O(1) from in-memory index. Results are sorted alphabetically.

```ts
kvStore.keys(prefix?: string): Promise<string[]>
```

```ts
const allKeys = await kvStore.keys();
const userKeys = await kvStore.keys("user:");    // ["user:1", "user:2"]
const cacheKeys = await kvStore.keys("cache:");  // ["cache:api:token"]
```

### kvStore.meta

Read entry metadata without loading the value. O(1) from in-memory index.

```ts
kvStore.meta(key: string): Promise<KVEntryMeta | undefined>
```

```ts
const info = await kvStore.meta("files:photo.raw");
if (info) console.log(`${info.key}: ${info.size} bytes, type=${info.type}`);
```

### kvStore.size

Return the total number of entries in the store. O(1) from in-memory index.

```ts
kvStore.size(): Promise<number>
```

### kvStore.delete

Delete a key and its data. No-op if the key does not exist.

```ts
kvStore.delete(key: string): Promise<void>
```

### kvStore.clear

Delete all entries and remove the store directory. The store is immediately usable again after clearing.

```ts
kvStore.clear(): Promise<void>
```

**Errors:** propagates `DOMException`s other than `NotFoundError` (permission / quota errors are no longer silently swallowed — only "already empty" is). Watchers (including prefix-filtered ones) all receive a `clear` event regardless of their prefix.

### kvStore.watch

Watch for store mutations, optionally filtered by key prefix. Fires for changes in the current tab and from other tabs (via BroadcastChannel). Returns an unsubscribe function. The event does not contain the value -- call `get`/`getBytes` inside the callback if needed.

```ts
kvStore.watch(
  callback: (event: KVEvent) => void,
  prefix?: string
): () => void  // returns unsubscribe function
```

```ts
const unwatch = kvStore.watch((e) => {
  console.log(`${e.type}: ${e.key}`);
  if (e.type === "set") refreshUI();
}, "user:");

// Later: stop watching
unwatch();
```

### kvStore.destroy

Tear down the module-level state and close the BroadcastChannel. Useful in test environments (each test wants a clean state) and for explicit shutdown in long-lived apps. The next operation re-initialises everything lazily.

```ts
kvStore.destroy(): void   // idempotent — safe to call twice
```

```ts
// Test setup: ensure no listeners leak between tests
afterEach(() => kvStore.destroy());
```

**Gotchas:**
- Corrupt on-disk index now **throws** with a descriptive error instead of silently resetting the store to empty (which previously orphaned every existing blob). Catch the error if your app legitimately needs to recover from a corrupted index.
- Concurrent same-tab writes are now serialised even when Web Locks are unavailable (Promise-chain fallback). Cross-tab serialisation still requires Web Locks.
- Old blobs are deleted **after** the new value is durably written, so a quota / write failure no longer loses the previous value.

---

## theme

Light/dark mode toggle with cookie persistence. SSR-safe.

### theme.getCurrent
Returns current theme by checking `document.documentElement` for `dark` class.
Returns `"light"` in SSR.

```ts
theme.getCurrent(): "light" | "dark"
```

### theme.set
Applies theme class to document root and persists to cookie.

```ts
theme.set(mode: "light" | "dark"): "light" | "dark"
```

### theme.toggle
Switches to opposite theme and persists.

```ts
theme.toggle(): "light" | "dark"
```

---

## Key patterns

1. **Browser-only**: All modules require a DOM environment. Do not import in Node.js/server-side code.
2. **Secure context**: `clipboard`, `notifications`, `kvStore`, and `files.OPFS` require HTTPS or localhost.
3. **SSR safety**: `notifications` functions return `null`/`false` gracefully in non-browser environments. Other modules will throw if DOM APIs are missing.
4. **Chainable images**: The `images` API uses a functional pipeline pattern -- each transform returns a function compatible with `Promise.then`. Chain transforms freely:
   ```ts
   const result = await images.create(file)
     .then(images.resize(800, 600, "cover"))
     .then(images.crop(0, 0, 400, 300))
     .then(images.filter(images.filters.vintage))
     .then(images.rotate(90))
     .then(images.flip())
     .then(images.toBlob("webp", 0.85));
   ```
5. **kvStore vs localStorage**: Use `kvStore` when you need more than 5 MB, binary storage, cross-tab reactivity, or structured namespacing. All operations are async (return Promises).
6. **Key prefixes for namespacing**: kvStore supports namespace-style keys like `"user:"`, `"cache:"`, `"files:"`. Use `keys(prefix)` and `watch(cb, prefix)` to scope operations.
