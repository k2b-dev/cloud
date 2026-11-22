# Common Patterns Across Core Modules

Reusable patterns combining multiple `@k2b/stdlib` modules.

---

## 1. Result + tryCatch Pattern

**When to use:** Wrapping any async operation that might fail (DB queries, HTTP calls, file I/O) so callers never deal with thrown exceptions.

```ts
import { ok, fail, err, tryCatch } from "@k2b/stdlib";

async function getUser(id: string): Promise<Result<User>> {
  return tryCatch(
    async () => {
      const user = await db.findUser(id);
      if (!user) throw err.notFound("User");
      return user;
    },
    (error) => err.internal(`Failed to fetch user: ${error}`),
  );
}

// Caller: no try/catch needed
const result = await getUser("123");
if (!result.ok) {
  console.error(result.error.code, result.error.message);
  return;
}
const user = result.data;
```

`tryCatch` catches everything. If the thrown value is already a `ServiceError` (like `err.notFound`), it wraps it directly via `fail()`. Otherwise, the `onError` mapper converts it. If `onError` is omitted, an `err.internal()` is created from the error message.

---

## 2. Cache + onMiss for API Responses

**When to use:** Any data that is expensive to fetch but acceptable to serve slightly stale (user profiles, config, feature flags).

```ts
import { createCache, tryCatch, err } from "@k2b/stdlib";

const userCache = createCache<User>({
  ttl: 5 * 60_000, // 5 minutes
  onMiss: async (key) => {
    const res = await fetch(`/api/users/${key}`);
    if (!res.ok) return null; // null = don't cache
    return res.json();
  },
  beforePurge: (key) => console.log(`evicted user: ${key}`),
});

// First call fetches, subsequent calls return cached
const user = await userCache.get("user-123");

// Force refresh: delete then get
userCache.delete("user-123");
const fresh = await userCache.get("user-123");
```

Key detail: `onMiss` returning `null` means "don't cache this miss." The next `get` will call `onMiss` again. Concurrent `get` calls for the same key both execute `onMiss` (no built-in deduplication).

---

## 3. Encoding Roundtrips

**When to use:** Converting between binary and string representations for storage, transport, or interop with external systems.

```ts
import { encoding } from "@k2b/stdlib";

const payload = new TextEncoder().encode("hello world");

// Base64 roundtrip (URLs, JSON payloads, email attachments)
const b64 = encoding.toBase64(payload);    // "aGVsbG8gd29ybGQ="
const back = encoding.fromBase64(b64);     // Uint8Array

// Hex roundtrip (hashes, keys, debugging)
const hex = encoding.toHex(payload);       // "68656c6c6f20776f726c64"
const back2 = encoding.fromHex(hex);       // Uint8Array

// Base32 roundtrip (TOTP secrets, case-insensitive contexts)
const b32 = encoding.toBase32(payload);    // "NBSWY3DPEB3W64TMMQ======"
const back3 = encoding.fromBase32(b32);    // Uint8Array

// Cross-format: Base64 -> raw bytes -> Hex
const hexFromB64 = encoding.toHex(encoding.fromBase64(b64));
```

Note: `fromHex` throws on odd-length strings. `fromBase32` throws on characters outside A-Z, 2-7. All functions work in both Node.js/Bun and browsers.

---

## 4. Date and Duration Formatting Decision Tree

**When to use:** Choosing the right formatter for dates, timestamps, and measured durations.

```
Formatting a raw measured millisecond count?
  Yes -> text.pprintDurationMs()         // "842ms", "1m 30s"
  No  -> Need exact date + time?
           Yes -> dates.formatDateTime() // "Mar 5, 2025, 13:53"
           No  -> Need relative wording?
                    Yes -> Feed/chat?
                             Yes -> dates.formatDateTimeRelative() // "4 mins ago"
                             No  -> Sidebar/list?
                                      Yes -> dates.formatDateRelative() // "yesterday"
                                      No  -> dates.formatTimeSpan() // "in 3 days"
                    No  -> Duration between two dates?
                             Yes -> dates.formatDuration() // "2 hours, 15 minutes"
                             No  -> dates.formatDate()     // "Mar 5, 2025"
```

```ts
import { dates, text } from "@k2b/stdlib";

// Feed message timestamps
dates.formatDateTimeRelative(msg.createdAt); // "now" / "4 minutes ago" / "yesterday"
dates.formatDateTimeRelative(msg.createdAt, { locale: "de" }); // "vor 4 Minuten" / "gestern"

// Sidebar last-seen
dates.formatDateRelative(user.lastSeen);     // "14:30" / "Mon" / "Mar 5, 2025"

// Countdown/ETA
dates.formatTimeSpan(task.deadline);         // "in 3 days" (uses Intl.RelativeTimeFormat)

// Event duration
dates.formatDuration(event.start, event.end); // "1 day, 3 hours"

// Recurring events
dates.formatRecurrence({ freq: "weekly", byWeekday: [2, 3], until }); // "Every Tue and Wed until Dec 23, 2024"

// Request latency or timeout budget with no source timestamps
text.pprintDurationMs(request.durationMs);     // "1.23s"
```

Most date helpers accept an optional `DateContext`:

```ts
const ctx = { timeZone: "Europe/Berlin", locale: "de" };

dates.formatDateTime("2025-03-05T23:30:00Z", ctx); // "Mar 6, 2025, 00:30"
dates.formatDateKey(new Date("2025-03-05T02:30:00Z"), { timeZone: "America/New_York" }); // "2025-03-04"
dates.isSameDay(a, b, { timeZone: "Asia/Tokyo" });
```

Existing calls keep their current defaults: exact date/time formatters default to UTC; calendar helpers default to the runtime-local timezone.

Cloud apps should store UTC instants and convert only at the UI boundary:

```ts
const timeZone = dates.normalizeTimeZone(app.timeZone, "UTC");

// Render/edit
const inputValue = dates.instantToZonedInput(event.startsAt, timeZone);

// Save native datetime-local input back to UTC
const startsAt = dates.zonedDateTimeToInstant(form.startsAt, timeZone);

// Recurrence: keep Monday 09:00 in the event timezone across DST
const nextStartsAt = dates.addZonedInstant(event.startsAt, {
  timeZone,
  weeks: 1,
});
```

---

## 5. Calendar Integration

**When to use:** Building a calendar UI with month/week views, item filtering, and navigation.

```ts
import { dates } from "@k2b/stdlib";

// 1. Generate the grid for the current month
const now = new Date();
const weeks = dates.getMonthGrid(now.getFullYear(), now.getMonth());
// weeks = Date[][] (4-6 rows of 7 days, Mon-Sun)

// 2. Get the data range for fetching items from the API
const ctx = { timeZone: "Europe/Berlin" };
const range = dates.getDateRange("month", now, ctx);
const items = await api.getItems({ from: range.from, to: range.to });

// 3. For each day cell, filter items that belong to that day
weeks.forEach(week =>
  week.forEach(day => {
    const dayItems = dates.getDayItems(items, day, ctx);
    const isCurrentMonth = dates.isSameMonth(day, now, ctx);
    const isCurrentDay = dates.isToday(day, ctx);
    // render cell with dayItems, dim if !isCurrentMonth, highlight if isCurrentDay
  })
);

// 4. Navigation: previous/next month
const prev = dates.addMonths(now, -1, ctx);
const next = dates.addMonths(now, 1, ctx);
```

Remember: `getMonthGrid` month parameter is 0-indexed (0 = January). `WEEKDAYS_SHORT` is Monday-first -- do not index with `Date.getDay()`.

---

## 6. URL State Management

**When to use:** Syncing UI state (filters, pagination, view mode) with URL query parameters for shareable/bookmarkable URLs.

```ts
import { searchParams } from "@k2b/stdlib";

type Filters = { page: number; sort: string; active: boolean };

// Read current state from URL: ?page=2&sort=name&active=true
const state = searchParams.deserialize<Filters>();
// { page: 2, sort: "name", active: true }

// Update URL when user changes a filter
function updateFilters(updates: Partial<Filters>) {
  const qs = searchParams.serialize<Filters>(updates);
  window.history.pushState({}, "", `?${qs}`);
}
updateFilters({ page: 3 });           // ?page=3&sort=name&active=true
updateFilters({ active: false });      // ?page=3&sort=name (active=false is removed)

// Listen for back/forward navigation
const cleanup = searchParams.onChange<Filters>((params) => {
  renderTable(params); // re-render with updated filters
});
// cleanup() on unmount
```

Gotchas: `false`, `null`, `undefined`, and `""` all cause the param to be **deleted** during serialization. `onChange` only fires on `popstate` (back/forward), not on `pushState`/`replaceState`.

---

## 7. Timing Composition

**When to use:** Retry logic with backoff and jitter, or preventing UI spinner flicker on fast responses.

```ts
import { timing } from "@k2b/stdlib";

// Retry with exponential backoff + jitter
async function fetchWithRetry<T>(url: string, maxRetries = 3): Promise<T> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fetch(url).then(r => r.json());
    } catch (e) {
      if (attempt === maxRetries - 1) throw e;
      const baseDelay = 1000 * Math.pow(2, attempt); // 1s, 2s, 4s
      await timing.sleep(timing.jitter(baseDelay, baseDelay * 0.3));
    }
  }
  throw new Error("unreachable");
}

// Prevent spinner flicker: ensure loading takes at least 500ms
const data = await timing.withMinLoadTime(
  () => fetchWithRetry("/api/data"),
  500,
);
```

`jitter` uses `crypto.getRandomValues` (cryptographically secure). The offset is uniformly distributed in `[-range, +range]`. `withMinLoadTime` defaults to 300ms if no minimum is specified.

---

## 8. Text Pipeline

**When to use:** Transforming user-provided strings for different display contexts (URLs, headings, labels).

```ts
import { text } from "@k2b/stdlib";

const userInput = "Hello World -- My Blog Post!";

// URL slug: lowercase, hyphenated, stripped diacritics
const slug = text.slugify(userInput);
// "hello-world-my-blog-post"

// Display label: first letter capitalized, separators become spaces
const label = text.humanize("user_first_name");
// "User first name"

// Heading: every word capitalized
const heading = text.titleify("hello_world-foo");
// "Hello World Foo"

// File size display (IEC default — 1024-base, locale-aware decimal)
const size = text.pprintBytes(15728640);
// "15 MiB"

// SI mode (1000-base) when you want disk-vendor-style sizes
const siSize = text.pprintBytes(15_000_000, { mode: "si" });
// "15 MB"

// Split for styled UI rendering
const { value, unit } = text.pprintBytesParts(15728640);
// { value: "15", unit: "MiB" }

// Counts, ratios, and measured durations
text.pprintNumber(1_234_567, { compact: true }); // "1.2M" in an English locale
text.pprintPercent(0.999, { decimals: 3 });      // "99.900%"
text.pprintDurationMs(90_000);                   // "1m 30s"
```

`slugify` applies NFKD normalization and strips diacritics, so "Uber uns" becomes "uber-uns". Numeric pretty-printers localize separators while keeping compact and duration suffixes deterministic. `pprintPercent` always accepts a ratio. `pprintBytes` defaults to IEC binary units (1 KiB = 1024 B); pass `{ mode: "si" }` for decimal units (1 KB = 1000 B). All pprint helpers and the relative/duration date formatters take a `locale`; resolve it once via an `i18n` catalog and pass it through.

---

## 9. SSE + Result for Streaming API Calls

**When to use:** Consuming a streaming API endpoint (e.g. AI chat completions, live feeds) with typed error handling around the fetch call.

```ts
import { streaming, result } from "@k2b/stdlib";

async function streamEvents(url: string) {
  const res = await result.tryCatch(() => fetch(url));
  if (!res.ok) return res;

  for await (const event of streaming.parseSSE(res.data.body!)) {
    const payload = JSON.parse(event.data);
    if (payload.done) break;
    process(payload);
  }
  return result.ok();
}
```

`tryCatch` catches network errors before streaming begins. Inside the loop, each SSE event is parsed individually. Combine with `text.truncate` or `text.summarize` to keep displayed output within bounds.

---

## 10. Debounce + Cache for Search Inputs

**When to use:** Building a search-as-you-type UI where expensive lookups are debounced and results are cached to avoid refetching.

```ts
import { timing, cache } from "@k2b/stdlib";

const searchCache = cache.create<SearchResult[]>({ ttl: 2 * 60_000 });

const search = timing.debounce(async (query: string) => {
  const cached = await searchCache.get(query);
  if (cached) return renderResults(cached);

  const results = await fetch(`/api/search?q=${query}`).then(r => r.json());
  await searchCache.set(query, results);
  renderResults(results);
}, 300);

input.addEventListener("input", (e) => search(e.target.value));
```

`debounce` waits 300ms after the last keystroke. `cache.create` stores results by query string so revisiting a previous query is instant. Call `search.cancel()` on component teardown.
