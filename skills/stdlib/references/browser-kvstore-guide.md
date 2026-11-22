# kvStore Guide

## When to Use kvStore vs Alternatives

### kvStore vs localStorage
- Async API -- never blocks the main thread
- No 5MB storage limit (uses OPFS under the hood)
- Binary data support via `setBytes()` / `getBytes()`
- O(1) key operations thanks to in-memory index

### kvStore vs IndexedDB
- Simpler key-value API -- no schema, no versioning, no migrations
- No indexes or query capabilities -- if you need to filter/sort by field values, use IndexedDB
- Single-store model -- use key prefixes for namespacing instead of object stores

### kvStore vs Server Storage
- Offline-first -- works without any network connection
- Origin-scoped -- data is sandboxed per origin, not shared across domains
- No authentication or authorization layer -- all code on the origin can access all keys

## Key Naming Conventions

Use colon-separated prefixes to create logical namespaces:

```ts
// User data
await kvStore.set("user:123", { name: "Alice" });
await kvStore.set("user:456", { name: "Bob" });

// Cache entries
await kvStore.set("cache:api:users", responseData);
await kvStore.set("cache:api:posts", responseData);

// Binary files
await kvStore.setBytes("files:photo.raw", rawBuffer);
await kvStore.setBytes("files:document.pdf", pdfBuffer);
```

Use `keys(prefix)` to query within a namespace:

```ts
const userKeys = await kvStore.keys("user:");   // ["user:123", "user:456"]
const cacheKeys = await kvStore.keys("cache:");  // ["cache:api:users", "cache:api:posts"]
```

Keep keys human-readable for debugging. Avoid opaque IDs as the sole key component.

## Storage Architecture

### Inline Threshold
- Values <= 4KB are stored directly in the index file (fast reads, single file I/O)
- Values > 4KB are stored as separate blob files in OPFS (avoids bloating the index)

### In-Memory Index
- The index is loaded from disk once on first access
- Kept in sync across tabs via BroadcastChannel
- All key lookups and metadata queries hit the in-memory index (no disk I/O)

### Web Locks
- Write operations (`set`, `setBytes`, `delete`, `clear`) acquire an exclusive Web Lock
- Read operations (`get`, `getBytes`, `keys`, `meta`) are lock-free
- This means reads never block, even during concurrent writes

## Common Patterns

### Cache-Aside

```ts
async function fetchWithCache(url: string) {
  const cacheKey = `cache:${url}`;
  const cached = await kvStore.get(cacheKey);
  if (cached !== undefined) return cached;

  const response = await fetch(url);
  const data = await response.json();
  await kvStore.set(cacheKey, data);
  return data;
}
```

### File Processing Pipeline

```ts
// Store large files as bytes
for (const file of files) {
  await kvStore.setBytes(`queue:${file.name}`, await file.arrayBuffer());
}

// Process one by one
for (const key of await kvStore.keys("queue:")) {
  const data = await kvStore.getBytes(key);
  await processFile(data);
  await kvStore.delete(key);
}
```

### Cross-Tab State

```ts
// Tab A: update shared state
await kvStore.set("app:theme", "dark");

// Tab B: react to changes
kvStore.watch("app:theme", (newValue) => {
  document.body.classList.toggle("dark", newValue === "dark");
});
```

### Migration from localStorage

```ts
// localStorage (sync)
localStorage.setItem("user", JSON.stringify(user));
const user = JSON.parse(localStorage.getItem("user"));

// kvStore (async, but similar shape)
await kvStore.set("user", user);          // auto-serializes
const user = await kvStore.get("user");   // auto-deserializes
```

## Gotchas

### String vs Binary Mismatch
`get()` returns `undefined` for keys that were stored with `setBytes()`, and `getBytes()` returns `undefined` for keys stored with `set()`. Use `meta()` to check the type before reading:

```ts
const info = await kvStore.meta("mykey");
if (info?.type === "bytes") {
  const data = await kvStore.getBytes("mykey");
} else {
  const data = await kvStore.get("mykey");
}
```

### watch() Cross-Tab Guarantees
`watch()` is **guaranteed** for same-tab updates. For cross-tab updates it is **best-effort** -- it relies on BroadcastChannel, which may not fire if the other tab is frozen or throttled by the browser.

### clear() Behavior
`clear()` deletes the entire OPFS directory for the store. The next write operation will automatically recreate it. There is no "undo" -- treat `clear()` as destructive.

### First Operation Latency
The very first kvStore operation in a page load reads the index from disk, which may take a few milliseconds. All subsequent calls use the in-memory index and are effectively instant. If startup latency matters, call `kvStore.keys()` early to warm the index.
