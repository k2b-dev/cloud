# Core Modules

```ts
import { encoding, crypto, password, dates, fileIcons, gradients, result, svg, timing, streaming, text, fuzzy, highlight, charts, searchParams, cache } from "@k2b/stdlib";
import { qr } from "@k2b/stdlib/qr"; // separate subpath -- requires the optional `lean-qr` peer
```

## money

Exact signed minor units with currency, strict localized parsing, decimal factors,
explicit rounding, tax breakdowns and lossless weighted allocation. Imports from
the root and runs in Bun, browsers and workers.

See [Exact money amounts](./money.md) for the API and invoice examples.

## encoding

Base64, hex, and Base32 encode/decode. Uses native `Buffer`/`Uint8Array.toHex` when available.

```ts
import { encoding } from "@k2b/stdlib";

const bytes = new Uint8Array([0xca, 0xfe]);
encoding.toHex(bytes);    // "cafe"
encoding.toBase64(bytes);  // "yv4="
encoding.toBase32(bytes);  // "ZL7A===="

// Round-trip
encoding.fromHex("cafe");
encoding.fromBase64("yv4=");
encoding.fromBase32("ZL7A====");

// Base62 (URL-safe, no special chars)
encoding.toBase62(123456789);        // "8M0kX"
encoding.toBase62(42, 6);            // "000010" (min 6 chars)
encoding.fromBase62("8M0kX");        // 123456789
```

## crypto

SHA-256 hashing, UUID/ULID generation, key generation, symmetric/asymmetric encryption, TOTP, and digital signatures. All built on the Web Crypto API.

### Common utilities

```ts
import { crypto } from "@k2b/stdlib";

await crypto.common.hash("hello");          // SHA-256 hex string
crypto.common.fnv1aHash("hello");           // fast non-crypto hash
crypto.common.uuid();                       // crypto.randomUUID()
crypto.common.ulid();                       // sortable 26-char ULID
crypto.common.ulid({ timestamp: Date.now() });
crypto.common.ulid({ monotonic: true });     // ordered within the same millisecond
crypto.common.readableId();                 // "a3X-B7nm-4Kp-qR9v"
crypto.common.readableId(5, 5);             // "3nK4p-Xm9Bq"
crypto.common.generateKey();                // 256-bit hex key
```

ULIDs are sortable identifiers, not secrets: the timestamp is visible in the first 10 characters. Use `generateKey()` for tokens or credentials.

### Symmetric encryption (AES-256-GCM)

```ts
// Password-based (PBKDF2, 100k iterations)
const enc = await crypto.symmetric.encrypt({ payload: "secret", key: "password" });
const dec = await crypto.symmetric.decrypt({ payload: enc, key: "password" });

// High-entropy key (HKDF, fast)
const key = crypto.common.generateKey();
const enc2 = await crypto.symmetric.encrypt({ payload: "data", key, stretched: false });
```

### Asymmetric encryption (ECDH P-256 + AES-256-GCM)

```ts
const { privateKey, publicKey } = await crypto.asymmetric.generate();
const encrypted = await crypto.asymmetric.encrypt({ payload: "hello", publicKey });
const decrypted = await crypto.asymmetric.decrypt({ payload: encrypted, privateKey });
```

### Digital signatures (ECDSA P-256)

```ts
const { nonce, timestamp, signature } = await crypto.asymmetric.sign({
  privateKey,
  message: "important data",
});
const valid = await crypto.asymmetric.verify({
  publicKey,
  signature,
  nonce,
  timestamp,
  message: "important data",
});
```

### TOTP (RFC 6238)

```ts
const { uri, secret } = await crypto.totp.create({ label: "user@example.com", issuer: "MyApp" });
// Show `uri` as QR code, store `secret` encrypted
const ok = await crypto.totp.verify({ token: "123456", secret });
```

## password

Password generation and strength analysis. Separated from crypto for tree-shaking -- importing crypto won't pull in the 5KB wordlist.

```ts
import { password } from "@k2b/stdlib";

password.random();                                    // "aB3kLm9xQr2Wp5Nj7Ht" (20 chars)
password.random({ length: 32, symbols: true });
password.memorable();                                 // "correct-horse-battery-staple"
password.memorable({ capitalize: true, addNumber: true });
password.pin();                                       // "384729"
password.pin({ length: 4 });                          // "2847"

// Strength analysis
password.strength("correct-horse-battery-staple");
// { entropy: 41.36, score: 2, label: "fair", crackTime: "5 minutes", feedback: ["Use more random words"] }

password.strength("password123");
// { entropy: 12.7, score: 1, label: "weak", crackTime: "seconds", feedback: ["Add more characters", ...] }
```

The memorable generator uses the EFF Short Wordlist 1 (1,296 words, 10.34 bits/word). Four random words are easy to type; use six or more words when offline cracking resistance matters.

## dates

Date formatting, relative time, and calendar helpers with optional IANA timezone support.

Most functions accept a final context object:

```ts
type DateContext = {
  timeZone?: string;      // e.g. "Europe/Berlin", "America/New_York"
  locale?: string;        // e.g. "en", "de", "fr"
  weekStartsOn?: 0 | 1;   // Sunday or Monday, default Monday
  firstDayOfWeek?: 0 | 1; // Alias for weekStartsOn
};
```

Absolute formatters default to UTC; calendar helpers default to the runtime's local timezone. Pass `timeZone` when the user's calendar day matters.

Since 0.27.0, `formatDate` follows the locale's order and punctuation through
`Intl.DateTimeFormat`. The default locale is `en`, so English output changes from
`05 Mar 2025` to `Mar 5, 2025`. Use `en-GB` for day-first English.
`formatDateTime` uses the same date and retains its 24-hour clock. Relative
formatters use this spelling in their absolute fallback, as does recurrence
`until`; their bucket logic is unchanged. `formatDateKey` and `formatDateShort`
keep their existing behavior (`formatDateShort` is still fixed `d.M.`).

```ts
dates.formatDate("2026-05-02", { locale: "de" }); // "2. Mai 2026"
dates.formatDate("2026-05-02", { locale: "de", style: "numeric" }); // "02.05.2026"
dates.formatDate("2026-05-02", { locale: "en-GB", style: "numeric" }); // "02/05/2026"
dates.formatDate("2026-05-02", { style: "numeric" }); // "05/02/2026"
```

```ts
import { dates } from "@k2b/stdlib";

dates.formatDate("2025-03-05T13:53:00Z");         // "Mar 5, 2025"
dates.formatDateTime("2025-03-05T13:53:00Z");      // "Mar 5, 2025, 13:53"
dates.formatDateTime("2025-03-05T23:30:00Z", { timeZone: "Europe/Berlin" });
// "Mar 6, 2025, 00:30"
dates.formatDateTimeRelative(new Date());           // "now"
dates.formatDateRelative(new Date());               // "14:30"
dates.formatTimeSpan("2025-03-10T00:00:00Z");       // "in 3 days"
dates.formatDuration("2025-03-01", "2025-03-03");   // "2 days"

// Relative wording and duration units come from Intl and follow the context
// locale (default "en"); pass `base` for deterministic output.
dates.formatDateTimeRelative(t, { locale: "de" });  // "vor 30 Minuten"
dates.formatTimeSpan(t, { base, locale: "de" });    // "vor 3 Stunden"
dates.formatDuration(a, b, { locale: "de" });       // "2 Stunden, 30 Minuten"

// Cloud edit flow: store UTC, render/edit in the app timezone
const input = dates.instantToZonedInput(event.startsAt, app.timeZone);
const startsAt = dates.zonedDateTimeToInstant(input, app.timeZone);

// Recurrence: preserve local wall-clock time across DST
const nextStartsAt = dates.addZonedInstant(event.startsAt, {
  timeZone: event.timeZone,
  weeks: 1,
});

// Recurrence rules as human-readable text
dates.formatRecurrence({ freq: "weekly", byWeekday: [2, 3], until: new Date("2024-12-23") });
// "Every Tue and Wed until Dec 23, 2024"
dates.formatRecurrence({ freq: "monthly", interval: 2, count: 6 });
// "Every 2 months, 6 times"
```

`formatRecurrence` uses an English sentence skeleton; weekday names, unit
names, and dates follow the context locale. For fully localized sentences,
compose `formatRecurrenceParts` (all parts come from `Intl`) with your own
message catalog:

```ts
dates.formatRecurrenceParts(
  { freq: "weekly", byWeekday: [2, 3], until: new Date("2024-12-23") },
  { locale: "de" },
);
// { every: "Woche", weekdays: "Di und Mi", until: "23 Dez. 2024" }
// -> t.recurrence(parts) => `Jeden ${parts.weekdays} bis ${parts.until}`
```

Timezone conversion uses the runtime's IANA data, including non-hour and
historical sub-minute offsets. `zonedDateTimeToInstant` rejects ambiguous and
nonexistent wall-clock times by default; pass `disambiguation` only when
choosing or shifting an occurrence is intentional.

## dates (calendar views)

Calendar grids, date checks, navigation, and locale-aware formatting are all part of the `dates` module.

```ts
import { dates } from "@k2b/stdlib";

const weeks = dates.getMonthGrid(2025, 0);  // January 2025, 2D array of Dates
const days = dates.getWeekDays(new Date());  // Mon-Sun array
const range = dates.getDateRange("month", new Date());
const berlinRange = dates.getDateRange("week", new Date(), { timeZone: "Europe/Berlin" });

dates.isToday(new Date());                  // true
dates.isSameDay(a, b, { timeZone: "America/New_York" });
dates.addMonths(new Date(), -1, { timeZone: "Europe/Berlin" });
dates.formatMonthYear(new Date());                      // "March 2025"
dates.formatMonthYear(new Date(), { locale: "de" });    // "März 2025"
dates.formatDateKey(new Date(), { timeZone: "Asia/Tokyo" }); // "2025-03-05"
dates.weekdays({ locale: "fr" });                       // ["lun.", "mar.", ...]

// Filter items that fall on a date
const items = dates.getDayItems(allItems, date, { timeZone: "Europe/Berlin" });

// Build calendar URLs
dates.buildCalendarUrl("/app", { view: "week", date: new Date() }, { timeZone: "Europe/Berlin" });
```

## dates (public holidays)

Statutory German public holidays by federal state, returned as calendar dates
and stable keys. Names belong to the app's message catalog; the module never
returns names and has no locale or timezone setting.

```ts
import { dates, publicHolidays } from "@k2b/stdlib";
import type { GermanState, HolidayKey } from "@k2b/stdlib";

// Both exports have this signature:
// publicHolidays(year: number, region: HolidayRegion): Holiday[]
type HolidayRegion = "DE" | `DE-${GermanState}`;
type Holiday = {
  date: string;        // "YYYY-MM-DD"
  key: HolidayKey;     // See the table below
  nationwide: boolean; // Applies in all 16 states that year
};

dates.publicHolidays(2026, "DE-BY");
publicHolidays(2026, "DE"); // Only nationwide holidays
```

`GermanState`, `HolidayRegion`, `HolidayKey`, and `Holiday` are also root exports.

State region codes use the `DE-` prefix: `BW` Baden-Württemberg, `BY` Bavaria,
`BE` Berlin, `BB` Brandenburg, `HB` Bremen, `HH` Hamburg, `HE` Hesse,
`MV` Mecklenburg-Western Pomerania, `NI` Lower Saxony, `NW` North Rhine-Westphalia,
`RP` Rhineland-Palatinate, `SL` Saarland, `SN` Saxony, `ST` Saxony-Anhalt,
`SH` Schleswig-Holstein, and `TH` Thuringia. `DE` returns only holidays that
apply in every state that year, including Reformation Day in 2017.

In the table, **E** means Easter Sunday and offsets are calendar days.
“All” means all 16 states; “Every year” means every supported year.

| Key | Date rule | States | Since / only |
|---|---|---|---|
| `new-year` | 01-01 | All | Every year |
| `epiphany` | 01-06 | BW BY ST | Every year |
| `womens-day` | 03-08 | BE; MV | BE since 2019; MV since 2023 |
| `good-friday` | E − 2 | All | Every year |
| `easter-sunday` | E | BB | Every year |
| `easter-monday` | E + 1 | All | Every year |
| `labour-day` | 05-01 | All | Every year |
| `liberation-day` | 05-08 | BE | Only 2020 and 2025 |
| `ascension-day` | E + 39 | All | Every year |
| `whit-sunday` | E + 49 | BB | Every year |
| `whit-monday` | E + 50 | All | Every year |
| `corpus-christi` | E + 60 | BW BY HE NW RP SL | Every year |
| `uprising-1953` | 06-17 | BE | Only 2028 |
| `assumption-day` | 08-15 | SL | Every year |
| `childrens-day` | 09-20 | TH | Since 2019 |
| `german-unity-day` | 10-03 | All | Every year |
| `reformation-day` | 10-31 | BB MV SN ST TH; HB HH NI SH; All | First group every year; second since 2018; all only in 2017 |
| `all-saints-day` | 11-01 | BW BY NW RP SL | Every year |
| `repentance-day` | Last Wednesday strictly before 11-23 (11-16–11-22) | SN | Every year |
| `christmas-day` | 12-25 | All | Every year |
| `boxing-day` | 12-26 | All | Every year |

Years must be integers from **1995 through 9999**, inclusive. The lower bound
starts when Repentance and Prayer Day ceased to be a holiday outside Saxony;
the upper bound keeps dates within four-digit years. Invalid years (including
`NaN`, `Infinity`, and fractions) and unknown region codes throw `RangeError`
naming the invalid value. Region codes are case-sensitive; `BY` needs the
`DE-` prefix.

Results are sorted by date. Holidays sharing a date are kept in table order:
on 2008-05-01, `labour-day` comes before `ascension-day`. Each call returns a
fresh array of fresh objects, so callers may mutate the result.

Not modelled: Assumption Day in Bavarian municipalities with a predominantly
Catholic population, Corpus Christi in some municipalities of Saxony and
Thuringia, Augsburg Peace Festival (08-08, city of Augsburg only), and days
without a statutory day off such as Christmas Eve and New Year's Eve.
Easter Sunday and Whit Sunday are included only for Brandenburg, whose holiday
law lists them explicitly; Hesse treats Sundays under its general Sunday rule.

Translate the keys through an app-owned `i18n.define` catalog:

```ts
import { dates, i18n } from "@k2b/stdlib";
import type { HolidayKey } from "@k2b/stdlib";

const catalog = i18n.define({
  baseLocale: "de",
  messages: { de: {
    "new-year": "Neujahr", "epiphany": "Heilige Drei Könige",
    "womens-day": "Internationaler Frauentag", "good-friday": "Karfreitag",
    "easter-sunday": "Ostersonntag", "easter-monday": "Ostermontag",
    "labour-day": "Tag der Arbeit", "liberation-day": "Tag der Befreiung",
    "ascension-day": "Christi Himmelfahrt", "whit-sunday": "Pfingstsonntag",
    "whit-monday": "Pfingstmontag", "corpus-christi": "Fronleichnam",
    "uprising-1953": "Jahrestag des Volksaufstands vom 17. Juni 1953",
    "assumption-day": "Mariä Himmelfahrt", "childrens-day": "Weltkindertag",
    "german-unity-day": "Tag der Deutschen Einheit", "reformation-day": "Reformationstag",
    "all-saints-day": "Allerheiligen", "repentance-day": "Buß- und Bettag",
    "christmas-day": "Erster Weihnachtstag", "boxing-day": "Zweiter Weihnachtstag",
  } satisfies Record<HolidayKey, string> },
});
const { t } = catalog.resolve(["de"]);
const labelled = dates.publicHolidays(2026, "DE-BY").map((holiday) => ({
  ...holiday, name: t[holiday.key],
}));
```

## fileIcons

Maps files to Tabler icon CSS classes and broad categories by extension and MIME type.

```ts
import { fileIcons } from "@k2b/stdlib";

fileIcons.getFileIcon({ name: "app.ts", type: "file" });
// "ti-brand-typescript text-blue-500"

fileIcons.getFileIcon({ name: "photos", type: "directory" });
// "ti-photo text-emerald-500"

fileIcons.getFileCategory({ name: "photo.jpg", type: "file" });
// "image"
```

## gradients

Named CSS gradient presets for UI theming (Berry, Ocean, Sunset, Forest, Pride, Gold, Mono).

```ts
import { gradients } from "@k2b/stdlib";

gradients.presets;                    // GradientPreset[]
gradients.getById("ocean");          // { id, label, style, preview }
gradients.defaultGradient;           // Berry preset
```

Apply with inline styles: `<span style={preset.style}>Username</span>`.

## i18n

Type-safe message catalogs with BCP-47 locale resolution, plus thin `Intl`
wrappers. Dependency-free and SSR-safe: no global state, no cookies, no
framework glue -- `resolve` returns a request-local translator.

```ts
import { i18n } from "@k2b/stdlib";

const catalog = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      title: "Inbox",
      greeting: ({ name }: { name: string }) => `Hello ${name}`,
    },
    de: {
      title: "Eingang",
      greeting: ({ name }) => `Hallo ${name}`, // params typed from the base locale
    },
  },
});

// Fallback: "de-AT" -> "de" -> baseLocale "en"
const { locale, t } = catalog.resolve(["de-AT", "en"]);  // locale === "de"
t.greeting({ name: "Ada" });                             // "Hallo Ada"
t.title;                                                 // "Eingang"

// Server request flow
const requested = i18n.parseAcceptLanguage(req.headers.get("accept-language"));
const { locale: l, t: tt } = catalog.resolve(requested);
```

The base locale defines the key set and parameter types; other locales are
checked against it at compile time and may omit keys. Missing keys fall back
through the locale's defined BCP-47 ancestors to the base locale
(`de-CH` -> `de` -> `en`, most specific wins). `catalog.check()` reports keys
that fall all the way through to the base locale plus extra keys per locale --
assert it returns `[]` in a unit test.

The resolved `locale` plugs straight into `dates` and `text`:

```ts
dates.formatDate(date, { locale });
text.pprintNumber(1_234_567, { locale });
```

Intl helpers for use inside (and outside) message functions:

```ts
i18n.plural(2, "de", { one: "Tag", other: "Tage" });  // "Tage" (Intl.PluralRules)
i18n.formatList(["Di", "Mi", "Fr"], "de");            // "Di, Mi und Fr" (Intl.ListFormat)
i18n.formatList(["a", "b"], "en", { type: "disjunction" }); // "a or b"
["Öl", "Apfel"].sort(i18n.compare("de"));             // ["Apfel", "Öl"] (Intl.Collator)
```

The stdlib itself ships no translations: all locale-dependent output
(weekday/month/unit names, relative time, numbers, lists, plural rules) comes
from the runtime's `Intl` CLDR data, which is complete in modern browsers,
Node, Bun, and edge runtimes. Only your own app messages live in catalogs.

## result

Typed `Result<T, E>` for service-layer error handling with pagination support.

```ts
import { ok, fail, err, unwrap, tryCatch, paginate, okMany } from "@k2b/stdlib";

// Constructors
ok({ id: 1 });                       // { ok: true, data: { id: 1 } }
fail(err.notFound("User"));          // { ok: false, error: { code: "NOT_FOUND", ... } }

// Error factories
err.badInput("Email required");      // 400
err.unauthenticated();               // 401
err.forbidden();                     // 403
err.notFound("User");                // 404
err.conflict("Email already exists"); // 409, the sentence as given
err.tooManyRequests();               // 429, TOO_MANY_REQUESTS
err.internal();                      // 500
err.unavailable();                   // 503, UNAVAILABLE

// Unwrap or throw
const data = unwrap(result);

// Wrap async functions
const result = await tryCatch(() => fetchUser(id));

// Pagination
const { page, perPage, offset } = paginate({ page: 2, perPage: 10 });
okMany(items, { page, perPage, total: 100 });
```

Since 0.35.0, `ServiceError.status` supports
`400 | 401 | 403 | 404 | 405 | 406 | 408 | 409 | 410 | 412 | 413 | 415 | 416 | 421 | 422 | 429 | 500 | 501 | 502 | 503 | 504`.
`err.unavailable(why?)` defaults to "Service unavailable";
`err.tooManyRequests(why?)` defaults to "Too many requests".
Custom codes use the same statuses, for example:

```ts
fail({ code: "READ_UNAVAILABLE", message: "Draft reads unavailable", status: 503 });
```

`isServiceError()` keeps its existing shape check: string `code` and `message`
fields and a numeric `status`. It accepts custom codes and numeric statuses
outside the static union; it does not validate HTTP status ranges.
`tryCatch()` preserves these structured errors without invoking `onError`.
Other thrown values use `onError`, or an internal 500 error when no mapper is
supplied.

`ServiceError.message` is for logs and debugging, not for UIs. Localize at the
UI edge by mapping `error.code` through an `i18n` catalog:

```ts
const errors = i18n.define({
  baseLocale: "en",
  messages: {
    en: { NOT_FOUND: "Not found", CONFLICT: "This conflicts with the current state" },
    de: { NOT_FOUND: "Nicht gefunden", CONFLICT: "Das widerspricht dem aktuellen Stand" },
  },
});
if (!result.ok) toast(errors.resolve(requested).t[result.error.code]);
```

## qr

QR code payload generators and SVG rendering. Lives behind the `/qr` subpath
so the optional `lean-qr` peer dependency is only required for consumers that
actually use QR features.

```ts
import { qr } from "@k2b/stdlib/qr";

// Generate payloads
qr.wifi({ ssid: "Office", password: "secret" });
qr.email({ to: "a@b.c", subject: "Hello" });
qr.tel({ number: "+49123456" });
qr.vcard({ firstName: "Jane", lastName: "Doe", email: "jane@example.com" });
qr.event({ title: "Meeting", start: "2025-06-15T14:30", end: "2025-06-15T15:30" });

// Render to SVG
const svgString = qr.toSvg(qr.wifi({ ssid: "Guest" }), {
  correctionLevel: "M",
  on: "#000",
  off: "#fff",
});
```

## svg

Deterministic SVG avatar generation and WebP data URL parsing.

```ts
import { svg } from "@k2b/stdlib";

const avatarBytes = svg.generateAvatar("user-123", "JD");
// Uint8Array containing a 128x128 SVG with color derived from the ID

const imageData = svg.parseWebpDataUrl("data:image/webp;base64,...");
// Uint8Array | null
```

## timing

Async timing utilities: sleep, jitter, write-coalescing, min-load-time, shuffle, random.

```ts
import { timing } from "@k2b/stdlib";

await timing.sleep(500);
timing.jitter(1000, 200);              // 800-1200 (crypto-random)
timing.random(1, 10, 1);               // integer 1-10
timing.shuffle([1, 2, 3, 4, 5]);       // Fisher-Yates shuffle

// Prevent UI flicker on fast requests
const data = await timing.withMinLoadTime(() => fetch("/api"), 300);

// Batch writes per key
const save = timing.buffer(
  async (key, data) => await api.save(key, data),
  2000,
);
save("doc-1", { title: "Draft" });
save("doc-1", { title: "Final" });   // replaces previous, flushes after 2s

// Debounce -- delays execution until input stops
const search = timing.debounce((query: string) => {
  fetchResults(query);
}, 300);
search("hel"); search("hello");     // only "hello" fires, after 300ms

// Throttle -- executes at most once per interval
const onScroll = timing.throttle(() => {
  updateScrollPosition();
}, 100);
```

## streaming

Async generators for consuming `ReadableStream` data. Works with `fetch()` response bodies.

```ts
import { streaming } from "@k2b/stdlib";

// Parse Server-Sent Events (SSE)
const res = await fetch("/api/events");
for await (const event of streaming.parseSSE(res.body!)) {
  console.log(event.event, event.data);
}

// Parse newline-delimited JSON (NDJSON)
const res2 = await fetch("/api/logs");
for await (const entry of streaming.parseNDJSON<LogEntry>(res2.body!)) {
  console.log(entry.level, entry.message);
}
```

## text

String transformation and formatting utilities.

```ts
import { text } from "@k2b/stdlib";

text.slugify("Hello World!");     // "hello-world"
text.humanize("hello_world-foo"); // "Hello world foo"
text.titleify("hello_world-foo"); // "Hello World Foo"
text.pprintNumber(1_234_567, { locale: "en-US" });                 // "1,234,567"
text.pprintNumber(1_234_567, { compact: true, locale: "en-US" });  // "1.2M"
text.pprintPercent(0.1234, { decimals: 1, locale: "en-US" });      // "12.3%"
text.pprintDurationMs(1_234, { locale: "en-US" });                 // "1.23s"
text.pprintDurationMs(90_000);                                     // "1m 30s"
text.pprintBytes(1536);                        // "1.5 KiB" (IEC default, 1024-base)
text.pprintBytes(1500, { mode: "si" });        // "1.5 KB"  (SI mode, 1000-base)
text.pprintBytes(1536, { locale: "de" });      // "1,5 KiB"
text.pprintBytes(0);                           // "0 B"
text.pprintBytesParts(1536);                   // { value: "1.5", unit: "KiB" } — for styled UI rendering
text.pprintBytesParts(1500, { mode: "si" });   // { value: "1.5", unit: "KB"  }
text.pprintCurrency(1234.5, "EUR", { locale: "de" });     // "1.234,50 €"
text.pprintCurrency(1234.5, "USD", { locale: "en-US" });  // "$1,234.50"

// Truncation and summarization
text.truncate("Hello World", 8);               // "Hello..."
text.truncate("Hello World", 8, "start");      // "...World"
text.summarize("Long paragraph...", 100);       // first 100 chars, word-boundary aware

// Case conversion
text.camelCase("hello-world");    // "helloWorld"
text.snakeCase("helloWorld");     // "hello_world"
text.kebabCase("HelloWorld");     // "hello-world"
text.pascalCase("hello_world");   // "HelloWorld"
```

All `pprint*` helpers accept an optional `locale` and default to the runtime
locale. Their suffixes remain deterministic across locales: compact numbers use
`k/M/B/T`, percentages use `%`, durations use `ms/s/m/h/d`, and byte units use
`B/KiB/MiB/...`. Only the numeric part is localized; `pprintCurrency` fully
follows the locale's currency conventions.

`pprintPercent` always accepts a ratio (`0.12` becomes `12%`); set `clamp: true`
to constrain the ratio to `0..1`. Explicit `decimals` are fixed, which supports
SLO-style output such as `99.900%`. Null, undefined, and non-finite values
return `"—"` unless `fallback` is supplied. Negative millisecond durations are
also invalid. Durations of at least one minute render at most two non-zero
units.

## fuzzy

Subsequence fuzzy match for UI search and Levenshtein distance for "did you
mean?" lookups. Case-insensitive by default; pass `caseSensitive: true` to
opt into strict matching.

```ts
import { fuzzy } from "@k2b/stdlib";

// ─── Subsequence fuzzy match (UI search, command palette) ───────────────

fuzzy.match("udh", "userDashboard");
// { score: 78, ranges: [[0,1], [4,5], [7,8]] }

fuzzy.match("xyz", "userDashboard");                        // null
fuzzy.match("UDH", "userDashboard", { caseSensitive: true }); // null

// Filter + rank a list, with optional accessor and limit
fuzzy.filter("udh", ["userDashboard", "logout", "userHome"]);
// [{ item, target, score, ranges }, ...] sorted by score desc

fuzzy.filter("ab", users, { key: u => u.name, limit: 10 });

// Pre-split target into matched/non-matched runs for JSX <mark> highlighting
fuzzy.segments("userDashboard", [[0,1], [4,5], [7,8]]);
// [{ text: "u", match: true }, { text: "ser", match: false },
//  { text: "D", match: true }, { text: "as",  match: false },
//  { text: "h", match: true }, { text: "board", match: false }]

// ─── Levenshtein (typo-tolerant lookups) ────────────────────────────────

fuzzy.distance("color", "colour");                          // 1
fuzzy.distance("kitten", "sitting");                        // 3

fuzzy.closest("hellp", ["hello", "help", "world"]);
// { value: "hello", distance: 1, similarity: 0.8 }

fuzzy.closest("zzz", ["alpha", "beta"], { maxDistance: 2 }); // null
```

The `match` algorithm uses a fzf-inspired scoring heuristic that rewards
prefix matches, word boundaries (kebab/snake/space/dot/camelCase), contiguous
runs, and case agreement. Score values are raw and only comparable within a
single query — use them for sorting, not for cross-query thresholds.

## highlight

Headless string-to-HTML highlighting for textarea overlays, markdown previews,
and small domain-specific languages. It emits escaped HTML with semantic class
names only; it does not include CSS, themes, colors, DOM code, or external
parser dependencies.

```ts
import { highlight } from "@k2b/stdlib";

highlight.escape(`<b>"x"</b>`); // "&lt;b&gt;&quot;x&quot;&lt;/b&gt;"

highlight.markdown("**Ship** `v1`", {
  knownLabels: new Set(["#roadmap", "@team"]),
});
// Cloud-compatible markdown classes such as md-bold, md-code, md-syntax.

highlight.overlay("**Ship**", highlight.markdown, {
  ghost: { at: 8, text: " it" },
});
// Injects completion-ghost/data-completion-anchor after markdown rendering.

const renderFormula = highlight.compile([
  { kind: "comment", match: /#.*/ },
  { kind: "string", match: /"(?:\\.|[^"])*"/ },
  { kind: "variable", match: /\$[a-zA-Z_]\w*/ },
  { kind: "keyword", match: /\b(IF|THEN|ELSE|SUM)\b/ },
  { kind: "number", match: /\b\d+(?:\.\d+)?\b/ },
  { kind: "operator", match: /[+\-*/=<>!]+/ },
]);

renderFormula(`IF $price > 10 THEN "ok"`);

highlight.presets.shell(`if [ "$USER" ]; then # hi`);
highlight.presets.code(`const x = "ok"; // hi`);
highlight.presets.sql(`SELECT id FROM users WHERE email = $1`);
```

`highlight.compile` returns a reusable highlighter. Create it once and call the
returned function during editor input events. Rule order is priority: at each
cursor position the first matching rule wins, so put comments and strings
before keywords. The built-in SQL preset is shallow and dependency-free: it
highlights common comments, strings, quoted identifiers, parameters, numbers,
keywords, functions, and operators without attempting dialect-specific parsing.

The code and SQL presets highlight unfinished block comments through EOF.
Other delimited tokens retain their existing output. Failed quoted-token scans
are cached through EOF; failed SQL bracket-identifier and shell `${...}` scans
are cached through the newline or EOF. Repeated openers therefore do not rescan
the same suffix. The code preset has no separate regex-literal rule.
Custom `highlight.compile` rules remain caller-owned; their regex complexity
is not bounded by the compiler.

## charts

SVG chart generators covering the basic shapes, dashboard panels, and the
features most useful for scientific publication: `scatter`, `line`, `bar`,
`pie`, `donut`, `sparkline`, `histogram`, `boxplot`, `gauge`, `barGauge`,
`stat`, `heatmap`, `map`, `stateTimeline`, `funnel`. Returns SVG strings —
inject into the DOM, write to disk, or send over the wire. Pure native, no
peer dependencies.

### Inspection metadata

Every chart accepts `inspect: true` to add inert `data-chart-datum` groups and
escaped SVG titles. The default output remains unchanged. This option does not
install listeners, add tab stops, or require a browser.

Each group carries a `ChartDatum`: its role, source `index`, optional
`seriesIndex`, label, `anchor: [x, y]`, optional grid coordinate, and raw value
fields with optional formatted text. Coordinates use the containing SVG's
coordinate system; use the group's screen matrix when enhancing the SVG.
Histogram indices identify computed bins. Box-plot outlier indices identify
source observations. References are valid for the current data snapshot.

Metadata is emitted beside the actual rendering calculation, so logarithmic
positions, bin counts, quartiles, percentage denominators, and clipping agree
with the visible chart. No second geometry calculation is needed in the UI.
`chartDatumSvg(svg, datum, inspect)` supports custom chart renderers that follow
the same contract; its SVG argument must be trusted renderer output.

```ts
const svg = charts.histogram({ data: [12, 18, 24, 42], bins: 3, inspect: true });
```

The consuming UI owns tooltip positioning, keyboard/touch interaction, and
selection. Keep the complete SVG in the server response.

```ts
import { charts } from "@k2b/stdlib";

charts.scatter({ series: [{ data: [{x:1,y:2,size:10}] }], sizeRange: [3,14] });
charts.line({ series: [{ data: [...] }, { data: [...] }] });
charts.bar({ data: [{label:"Q1",value:120}], colorByBar: true });
charts.pie({ data: [{label:"A",value:30}], showLabels: true });
charts.donut({ data: [...] });
charts.sparkline({ data: [3,7,5,9,12,10,14], area: true, showLast: true });
charts.histogram({ data: observations, bins: 30 });
charts.boxplot({ groups: [{label:"A", values:[1,2,3,4,5]}] });
charts.gauge({ value: 72, min: 0, max: 100, label: "CPU", unit: "%" });
charts.barGauge({ data: [{ label: "Disk", value: 91, unit: "%" }] });
charts.stat({ label: "Requests / min", value: 12482, delta: 8.4, sparkline: [...] });
charts.heatmap({ data: [{ x: "12:00", y: "p95", value: 89 }] });
charts.funnel({ stages: [{ label: "Visitors", value: 100 }, { label: "Signed up", value: 40 }] });
charts.map({
  series: [{ data: [{ latitude: 52.52, longitude: 13.405 }] }],
  viewport: { latitude: 52.52, longitude: 13.405, zoom: 2 },
});
charts.stateTimeline({ rows: [{ label: "API", intervals: [{ from: 0, to: 8, state: "ok" }] }] });
```

### Headers, axes, references, legend (every chart type)

```ts
charts.bar({
  title: "Quarterly Revenue", subtitle: "in thousand EUR",
  data: quarterlyRevenue,
  yAxis: { label: "Revenue", format: v => `€${v}k`, scale: "linear", minorTicks: true },
  references: [{ value: 200, label: "Target" }],
  showValues: true,                              // value labels on bars
  colorByBar: true, legend: true,
});
```

### Lines: smooth, area, step, error band, line styles

```ts
charts.line({
  series: [
    { label: "Revenue", data: revenue, lineStyle: "solid" },
    { label: "Costs",   data: costs,   lineStyle: "dashed" },
  ],
  smooth: true,        // Catmull-Rom by default; pass false for straight
  area: true,          // translucent fill below each line
  step: "before",      // step plot mode (overrides smooth)
  errorBand: true,     // CI band between errYHigh/errYLow per point
  autoVariant: true,   // cycle line styles when not explicit
  legend: true,
  references: [{ value: 50, label: "baseline" }],
});
```

### Scatter: bubbles, markers, error bars, trend line

```ts
charts.scatter({
  series: [
    { label: "Group A", marker: "square",   data: [{ x: 1, y: 2, size: 30, errY: 0.5 }] },
    { label: "Group B", marker: "triangle", data: [...] },
  ],
  sizeRange: [3, 16],   // bubble radii (when Point.size present)
  autoVariant: true,    // cycle marker shapes
  trendline: true,      // linear-regression overlay
  legend: true,
});
```

`Point` supports symmetric `errY`/`errX` or asymmetric `errYHigh`/`errYLow`/
`errXHigh`/`errXLow` for asymmetric uncertainty.

### Logarithmic axes

```ts
charts.scatter({
  series: [{ data: powerLawData }],
  xAxis: { scale: "log" },
  yAxis: { scale: "log", minorTicks: true },
});
```

Non-positive values are filtered automatically under log scale.

### Sparklines: inline trends

```ts
charts.sparkline({
  data: weeklyVisitors,
  area: true,        // soft currentColor gradient below the stroke
  showMinMax: true,
  showLast: true,
  width: 120,
  height: 32,
});
```

### Dashboard panels: gauge, bar gauge, stat, heatmap, state timeline

```ts
charts.gauge({
  value: 72,
  min: 0,
  max: 100,
  label: "CPU usage",
  unit: "%",
  thresholds: [{ value: 70 }, { value: 90 }, { value: 100 }],
  showNeedle: true,
});

charts.barGauge({
  data: [
    { label: "API latency", value: 63, unit: "ms", max: 120 },
    { label: "Disk usage", value: 91, unit: "%" },
  ],
  thresholds: [{ value: 70 }, { value: 90 }, { value: 100 }],
});

charts.stat({
  label: "Requests / min",
  value: 12482,
  delta: 8.4,
  sparkline: weeklyRequests,
});

charts.heatmap({
  data: [
    { x: "00", y: "p95", value: 26 },
    { x: "04", y: "p95", value: 34 },
  ],
  yLabels: ["p95", "p75", "p50"],
  showValues: true,
});

charts.stateTimeline({
  rows: [
    { label: "API", intervals: [{ from: 0, to: 8, state: "ok" }] },
  ],
  states: [{ state: "ok", label: "OK" }],
  xAxis: { format: v => `${v}:00` },
});
```

### Funnel: stages, drop-off, and comparison

```ts
charts.funnel({
  stages: [{ label: "Visitors", value: 12400 }, { label: "Signed up", value: 4960 }],
  label: "Current",
  compare: { label: "Average", values: [31000, 10850] }, // optional; matched by index
  conversion: "previous", // "previous" | "first" | "none"
  shape: "bars",          // "bars" | "funnel"
  locale: "en",
  inspect: true,
});
```

`stages` contains ordered `{ label, value }` items. Defaults are width `480`,
`conversion: "previous"`, `shape: "bars"`, and `locale: "en"`. `height` is a
minimum; content can make the SVG taller. `title`, `subtitle`, and `className`
are supported; `padding` is not. Both `charts.funnel` and the named `funnel`
export are available from `@k2b/stdlib`.

Without `compare`, bar length is `value / max(values)`: rising stages remain
honest and draw longer. Values show absolute counts and shares of the first
stage. With `compare`, both series show shares of their own first stage and
scale to the largest share across both series. Bars use comparison ticks;
`shape: "funnel"` uses centered trapezoids, or a split comparison with the main
series left and comparison right of one center axis. Absolute counts remain
in the inspection datum and its SVG tooltip.

Step conversion uses the previous stage by default, the first stage with
`"first"`, or is hidden with `"none"`. Comparison deviation is main conversion
minus comparison conversion in percentage points. The datum rounds it to two
decimals; visible text rounds to whole points with `+`, `−`, or `±`.

Override plain-text templates with `labels`: `step` defaults to
`"↓ {share} continue"` (`"↓ {share} of start"` with `"first"`), `compare` to
`"avg {share}"`, `deviation` to `"{delta} pp"`, and `start` to `"Start"`.
`{share}` receives the locale-formatted share or conversion; `{delta}` receives
the signed deviation. `start` is used only by the funnel shape without a
comparison. For German text, for example, pass `locale: "de"` and
`labels: { step: "↓ {share} weiter", compare: "Ø {share}" }`.

Below width `420`, bars place labels above the bar and counts beside shares
(e.g. `2.730 · 22 %`). Long labels and legend names are shortened with `…` and
keep their full text in a `<title>`. Counts from one billion and shares from
10,000 % use compact notation (`1.2B`, `1B%`), and scientific notation once
compact suffixes run out (`1E305`); shares below 0.01 % read `<0.01%`.

With `inspect: true`, each stage emits one datum with role `"item"`, its stage
`index`, original `label`, and value keys `value`, `share`, and `step` (after
the first stage, when conversion is enabled and computable). Comparison adds
`compareValue`, `compareShare`, `compareStep`, and `deviation` when computable.
In the funnel shape, each datum group also holds a transparent, row-wide
`.stdlib-chart-funnel-hit` rectangle, so stages with tiny or zero width stay
inspectable. Empty stages show the `no data` state. Negative or non-finite values and
ratios with a zero start/denominator show `–`; non-computable fields are omitted
from the datum. Missing or invalid comparison positions have no mark or
deviation; extra comparison values are ignored.

Style `.stdlib-chart-funnel-*` classes: `bar`, `track`, `tick`, `compare`,
`hit`, `label`, `value`, `compare-value`, `muted`, `compact`, `legend`, and
`deviation`/`deviation-up`/`deviation-down`. Main marks use `--stdlib-chart-c1`;
comparison marks and text use `currentColor`. Deviation colors match the stat
delta colors (green up, red down).

### Histogram & box plot (statistical)

```ts
charts.histogram({
  data: observations,                // raw numeric list
  bins: 30,                           // number, edge array, or undefined (Sturges')
  yAxis: { label: "Count" },
});

charts.boxplot({
  groups: [
    { label: "Class A", values: scoresA },
    { label: "Class B", values: scoresB },
  ],
  showOutliers: true,                 // default
  colorByBox: true,
});
```

### World map: geographic point series

```ts
charts.map({
  title: "Edge network health",
  viewport: { latitude: 35, longitude: 15, zoom: 1 },
  series: [
    {
      label: "Healthy",
      data: [
        { latitude: 52.52, longitude: 13.405, label: "Berlin", size: 128 },
        { latitude: 40.7128, longitude: -74.006, label: "New York", size: 82 },
      ],
    },
    {
      label: "Degraded",
      data: [{ latitude: 1.3521, longitude: 103.8198, label: "Singapore" }],
    },
  ],
  sizeRange: [3, 11],
  legend: true,
});
```

The built-in, simplified world land geometry is derived from the public-domain
Natural Earth 1:110m dataset, omits Antarctica, and is embedded directly in the module. Map points
outside latitude `-90..90` or longitude `-180..180` are ignored. Point labels
become escaped SVG `<title>` elements. The renderer does not cluster or
aggregate overlapping coordinates; pre-aggregate data and use `size` when the
magnitude should control the bubble radius.

`viewport` selects a deterministic center and zoom for the generated SVG.
Zoom `0` shows the full world; each additional level doubles the scale, up to
level `5`. The center is clamped so the viewport never exposes space beyond
the map, and marker radii remain fixed while zooming. Non-finite viewport
fields fall back to `0`; a non-finite zoom therefore selects the full-world
view.

The renderer remains pure and stateless. Interactive wrappers should own the
viewport state, update it for pan/zoom controls, and pass the resulting
`viewport` into each render. Reusing the same viewport during data refreshes
preserves the visible region and produces SSR-stable output.

### Common options (`ChartOptions`)

| option | default | notes |
|---|---|---|
| `width` | 400 (80 sparkline) | viewBox width |
| `height` | 240 (20 sparkline) | viewBox height |
| `padding` | `{16, 16, 32, 40}` | number applies to all sides |
| `className` | — | appended to root `<svg>`'s class |
| `title` / `subtitle` | — | centered header above the plot |

`AxisOptions` accepts `{ ticks?, format?, label?, scale?: "linear" | "log",
minorTicks?, domain?: [number, number] }`.

### Styling

Charts ship with embedded default CSS. Override via:

1. **Class selectors** — your CSS has higher specificity than the embedded `<style>`:
   ```css
   .stdlib-chart-line { stroke-width: 3; }
   .stdlib-chart-bar  { rx: 4; }
   .stdlib-chart-map-land { opacity: 0.2; }
   ```
2. **CSS custom properties** for the 8 default series colors:
   ```css
   .my-chart { --stdlib-chart-c1: #f43f5e; --stdlib-chart-c2: #f97316; }
   ```
3. **`currentColor`** is used for axes, tick labels, error bars, references,
   sparklines, map land, and sparkline area gradients — set the parent's `color` for
   theming (dark mode "just works").
4. The chart's font is **inherited from the surrounding HTML** — the app's
   font automatically applies.

Pass `className` to scope per-instance styles.

## searchParams

Typed URL search parameter serialization with smart coercion.

```ts
import { searchParams } from "@k2b/stdlib";

// Deserialize with type coercion (booleans, numbers, JSON)
const params = searchParams.deserialize<{ page: number; active: boolean }>(
  new URLSearchParams("page=2&active=true"),
);
// { page: 2, active: true }

// Serialize (removes null/undefined/false/"")
searchParams.serialize({ page: 2, active: true }); // "page=2&active=true"

// Watch for URL changes (popstate)
const cleanup = searchParams.onChange<{ page: number }>((p) => console.log(p.page));
```

## cache

In-memory TTL cache with lazy loading and cleanup hooks.

```ts
import { createCache } from "@k2b/stdlib";

const cache = createCache<User>({ ttl: 5 * 60_000 });
await cache.set("user:1", { name: "Alice" });
const user = await cache.get("user:1");

// Auto-fetching on miss
const apiCache = createCache<Response>({
  ttl: 30 * 60_000,
  onMiss: (key) => fetch(`/api/${key}`).then((r) => r.json()),
  beforePurge: (key) => console.log(`evicted: ${key}`),
});
const data = await apiCache.get("users"); // fetches on first call

// Updater function
await cache.set("count", (prev) => (prev ?? 0) + 1);

cache.has("user:1"); // true
cache.size();        // 1
cache.clear();
```


### Stable chart comparisons

For populated Cartesian axes, `domain: [min, max]` fixes exact inclusive bounds
instead of deriving them from each dataset. Bounds must be finite, strictly
increasing, and contain all plotted values, error bounds, and applicable baselines.
Log bounds must be positive. Invalid or insufficient bounds throw `RangeError`.
The renderer includes endpoint ticks; explicit domains currently omit minor ticks.
These bounds support comparisons across snapshots, not clipping or interactive zoom.

Bar, pie, and donut items accept `colorIndex?: number`. This is a nonnegative integer
palette slot that wraps modulo eight; invalid values throw. Preserve it when
filtering/sorting categories so their colors do not change. Bars use it only with
`colorByBar: true`. Pie/donut percentages still use the rendered positive total.
For series charts, retain original series slots with empty data for hidden series
to preserve palette and automatic marker/line variants.
