# Cross-Module Recipes

Practical examples showing how `@k2b/stdlib` modules compose together
to solve real tasks.

## 1. Authenticated API Client

Sign every outgoing request with an ECDSA key pair and cache responses with
automatic TTL expiration.

```ts
import { crypto, cache, result } from "@k2b/stdlib";

const apiCache = cache.create<unknown>({ ttl: 5 * 60_000 });

async function authedFetch<T>(url: string, privateKey: string): Promise<T> {
  const cached = await apiCache.get(url);
  if (cached) return cached as T;

  const { nonce, timestamp, signature } = await crypto.asymmetric.sign({
    privateKey,
    message: url,
  });

  const res = await result.tryCatch(async () => {
    const r = await fetch(url, {
      headers: { "X-Nonce": nonce, "X-Ts": String(timestamp), "X-Sig": signature },
    });
    if (!r.ok) throw new Error(r.statusText);
    return r.json() as Promise<T>;
  });

  if (!res.ok) throw new Error(res.error.message);
  await apiCache.set(url, res.data);
  return res.data;
}
```

## 2. Secure File Upload Pipeline

Resize a user-uploaded image, hash it for deduplication, and persist it to the
browser's OPFS-backed key-value store.

```ts
import { crypto } from "@k2b/stdlib";
import { images, kvStore } from "@k2b/stdlib/browser";

async function uploadImage(file: File) {
  const blob = await images
    .create(file)
    .then(images.resize(1200, undefined, "contain"))
    .then(images.filter(images.filters.contrast(1.05)))
    .then(images.toBlob("webp", 0.85));

  const bytes = new Uint8Array(await blob.arrayBuffer());
  const hash = await crypto.common.hash(bytes);

  await kvStore.setBytes(`uploads:${hash}`, bytes);
  return { hash, size: bytes.length };
}
```

## 3. Offline-First Data Layer

Use `kvStore` as a persistent offline cache with `cache.create` as a fast
in-memory layer, and keep the URL search params in sync with filter state.

```ts
import { cache, searchParams } from "@k2b/stdlib";
import { kvStore } from "@k2b/stdlib/browser";

type Project = { id: string; name: string; status: string };

const projectCache = cache.create<Project[]>({
  ttl: 10 * 60_000,
  async onMiss() {
    const stored = await kvStore.get<Project[]>("projects");
    if (stored) return stored;
    const res = await fetch("/api/projects").then((r) => r.json());
    await kvStore.set("projects", res);
    return res;
  },
  async beforePurge(_key, projects) {
    await kvStore.set("projects", projects);
  },
});

function applyFilters() {
  const params = searchParams.deserialize<{ status?: string; page?: number }>();
  const url = "/api/projects?" + searchParams.serialize({
    status: params.status,
    page: params.page ?? 1,
  });
  console.log("Fetching:", url);
}
```

## 4. User Settings with Cross-Tab Sync

Store user preferences that automatically synchronize across all open tabs using
the SolidJS `localStore` primitive.

```ts
import { localStore } from "@k2b/stdlib/solid";

type Settings = {
  theme: "light" | "dark";
  fontSize: number;
  sidebarOpen: boolean;
  locale: string;
};

const [settings, setSettings] = localStore.create<Settings>("app:settings", {
  theme: "light",
  fontSize: 14,
  sidebarOpen: true,
  locale: "en",
});

// Any change auto-persists to localStorage and syncs to other tabs
setSettings("theme", "dark");
setSettings("fontSize", 16);

// Read reactively in JSX
// <div class={settings.theme === "dark" ? "dark" : ""}>
//   Font size: {settings.fontSize}px
// </div>
```

## 5. Rate-Limited API with Retry

Use `cache.create` with `onMiss` as a single-flight fetch, combined with
`timing.sleep` and `timing.jitter` for exponential backoff retries.

```ts
import { cache, timing, result } from "@k2b/stdlib";

const apiCache = cache.create<unknown>({
  ttl: 60_000,
  async onMiss(key) {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) {
        const delay = timing.jitter(1000 * 2 ** attempt, 500);
        await timing.sleep(delay);
      }
      const res = await result.tryCatch(() =>
        fetch(`/api/${key}`).then((r) => {
          if (!r.ok) throw new Error(`${r.status}`);
          return r.json();
        }),
      );
      if (res.ok) return res.data;
      lastError = new Error(res.error.message);
    }
    throw lastError;
  },
});

// First call fetches with retry logic; subsequent calls hit cache
const data = await apiCache.get("users/123");
```

## 6. QR Code Business Card

Generate a vCard QR code with a deterministic SVG avatar, ready to embed in a
page or download.

```ts
import { svg } from "@k2b/stdlib";
import { qr } from "@k2b/stdlib/qr";

function renderBusinessCard(contact: {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  organization: string;
}) {
  const vcardData = qr.vcard({
    firstName: contact.firstName,
    lastName: contact.lastName,
    email: contact.email,
    phone: contact.phone,
    organization: contact.organization,
  });

  const qrSvg = qr.toSvg(vcardData, {
    correctionLevel: "M",
    on: "#1e293b",
    off: "#ffffff",
  });

  const initials = `${contact.firstName[0]}${contact.lastName[0]}`;
  const avatarBytes = svg.generateAvatar(contact.email, initials);
  const avatarSvg = new TextDecoder().decode(avatarBytes);

  return { qrSvg, avatarSvg };
}
```

## 7. Downloadable Report

Bundle multiple generated files into a ZIP and trigger a browser download, with
human-readable file sizes in the console.

```ts
import { text } from "@k2b/stdlib";
import { files } from "@k2b/stdlib/browser";

async function downloadReport(data: {
  csv: string;
  jsonSummary: object;
  logLines: string[];
}) {
  const csvBytes = new TextEncoder().encode(data.csv);
  const jsonBytes = new TextEncoder().encode(JSON.stringify(data.jsonSummary, null, 2));
  const logBytes = new TextEncoder().encode(data.logLines.join("\n"));

  console.log("CSV:", text.pprintBytes(csvBytes.length));
  console.log("JSON:", text.pprintBytes(jsonBytes.length));
  console.log("Logs:", text.pprintBytes(logBytes.length));

  const zipData = await files.createZip([
    { filename: "report.csv", source: data.csv },
    { filename: "summary.json", source: JSON.stringify(data.jsonSummary, null, 2) },
    { filename: "debug.log", source: data.logLines.join("\n") },
  ]);

  files.downloadFileFromContent(zipData, "report.zip", "application/zip");
  console.log("ZIP:", text.pprintBytes(zipData.length));
}
```

## 8. Keyboard-Driven App

Wire up global hotkeys, drag-and-drop reordering, and accessible click handlers
in a SolidJS component.

```ts
import { dnd, hotkeys, a11y } from "@k2b/stdlib/solid";

type Item = { id: string; label: string };

function createTaskBoard(items: Item[]) {
  // Keyboard shortcuts
  hotkeys.create({
    "mod+n": { label: "New task", run: () => addTask() },
    "mod+shift+d": { label: "Delete task", run: () => deleteSelected() },
    "mod+/": { label: "Show shortcuts", run: () => toggleHelp() },
  });

  // Drag and drop with keyboard support
  const controller = dnd.create<Item, { column: string }, { targetIndex: number }>({
    activationDistance: 5,
    onDrop: (ctx) => {
      if (!ctx.over || !ctx.intent) return;
      reorderTask(ctx.active.meta.id, ctx.over.meta.column, ctx.intent.targetIndex);
    },
    announcements: {
      dragStart: (active) => `Picked up ${active.meta.label}`,
      drop: (active, over) =>
        over ? `Dropped ${active.meta.label} in ${over.meta.column}` : "Cancelled",
    },
  });

  // Accessible action handler for non-button elements
  const selectHandlers = (item: Item) =>
    a11y.clickOrEnter(() => selectTask(item.id));

  return { controller, selectHandlers, shortcuts: hotkeys.entries };
}

function addTask() { /* ... */ }
function deleteSelected() { /* ... */ }
function toggleHelp() { /* ... */ }
function reorderTask(id: string, column: string, index: number) { /* ... */ }
function selectTask(id: string) { /* ... */ }
```

## 9. Streaming AI Chat

Consume an SSE-based AI chat completion endpoint with typed error handling and
incremental UI updates.

```ts
import { streaming, result } from "@k2b/stdlib";

type ChatChunk = { content: string; done: boolean };

async function streamChat(prompt: string, onChunk: (text: string) => void) {
  const res = await result.tryCatch(() =>
    fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    }),
  );
  if (!res.ok) return res;

  for await (const event of streaming.parseSSE(res.data.body!)) {
    const chunk: ChatChunk = JSON.parse(event.data);
    if (chunk.done) break;
    onChunk(chunk.content);
  }
  return result.ok();
}
```

## 10. Localized SSR Page

**Modules:** `i18n` + `dates` + `text` + `result`

```ts
import { i18n, dates, text, type RecurrenceParts } from "@k2b/stdlib";

// Module scope: one shared catalog, no global locale state (SSR-safe)
const catalog = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      greeting: ({ name }: { name: string }) => `Hello ${name}`,
      items: ({ count }: { count: number }) =>
        i18n.plural(count, "en", { one: `${count} item`, other: `${count} items` }),
      recurrence: (p: RecurrenceParts) =>
        `Every ${p.weekdays ?? p.every}${p.until ? ` until ${p.until}` : ""}`,
      NOT_FOUND: "Not found",
    },
    de: {
      greeting: ({ name }) => `Hallo ${name}`,
      items: ({ count }) =>
        i18n.plural(count, "de", { one: `${count} Eintrag`, other: `${count} Einträge` }),
      recurrence: (p) => `Jeden ${p.weekdays ?? p.every}${p.until ? ` bis ${p.until}` : ""}`,
      NOT_FOUND: "Nicht gefunden",
    },
  },
});

// Per request: resolve once, thread locale through all formatting
export const handle = (req: Request) => {
  const { locale, t } = catalog.resolve(
    i18n.parseAcceptLanguage(req.headers.get("accept-language")),
  );

  const rule = { freq: "weekly", byWeekday: [2, 3], until: series.until } as const;
  return render({
    greeting: t.greeting({ name: user.name }),
    schedule: t.recurrence(dates.formatRecurrenceParts(rule, { locale })),
    lastSeen: dates.formatTimeSpan(user.lastSeen, { locale }),
    storage: text.pprintBytes(user.storageBytes, { locale }),
    price: text.pprintCurrency(plan.price, "EUR", { locale }),
    // Service errors: translate the code at the UI edge, message stays dev-facing
    error: response.ok ? null : t[response.error.code],
  });
};
```

Catalog completeness belongs in a test: `expect(catalog.check()).toEqual([])`.
Chart axes stay locale-neutral by default; pass
`format: (v) => text.pprintNumber(v, { locale })` for localized ticks.
