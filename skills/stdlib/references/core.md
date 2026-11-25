# @k2b/stdlib -- Core Modules

All imports come from the root entrypoint:

```ts
import { encoding, crypto, password, dates, timing, streaming, text, fuzzy, highlight, cache, result, svg, searchParams, fileIcons, gradients } from "@k2b/stdlib";
import { qr } from "@k2b/stdlib/qr"; // separate subpath -- requires the optional `lean-qr` peer
```

Every namespace is also a plain object, so you can destructure or use dot-access:

```ts
import { toBase64, fromBase64, ok, fail, err, parseSSE, parseNDJSON } from "@k2b/stdlib";
```

---

## money

Exact JSON money values: `{ amount: number, currency: string }`, where amount is a
signed safe integer in minor units. All operations validate inputs and throw on
invalid values. Uses encapsulated big.js; no library objects cross the API.

```ts
money.fromMinor(123456, "EUR");
money.fromDecimal("1234.56", { currency: "EUR" });
money.toDecimal(value); // fixed-decimal major units as a string
money.currencyDigits("KWD"); // 3; Intl-supported uppercase codes only
money.parse("1.234,56", { locale: "de-DE", currency: "EUR" });
money.format(value, { locale: "de-DE" });
money.add(a, b);
money.subtract(a, b);
money.sum([a, b]); // empty: money.sum([], { currency: "EUR" })
money.compare(a, b); // -1 | 0 | 1
money.multiply(value, "1.19", { rounding: "half-up" });
money.divide(value, "3", { rounding: "half-even" });
money.taxFromNet(value, { percent: "19", rounding: "half-up" });
money.taxFromGross(value, { percent: "19", rounding: "half-up" });
money.allocate(value, [1, 1, 1]); // 100 -> 34,33,33; -100 -> -34,-33,-33
```

- Parsing requires an explicit supported locale and currency; numeric text only,
  locale digits and strict optional grouping, no currency symbols or exponents.
- Decimal strings use an optional minus, digits, and optional dot plus digits.
  Parsing excess fraction digits requires an explicit `rounding` option.
- `half-up` ties go away from zero, `half-even` ties go to the even integer,
  `toward-zero` truncates. Multiply/divide/tax always require a rule.
- Tax rates are nonnegative percentage strings. Net input: round tax and derive
  gross. Gross input: round net and derive tax. Always net + tax = gross. Caller
  chooses per-line versus total rounding; no legal-rate lookup.
- Allocation uses largest remainders, ties in input order, negative sign symmetry.
  Weights are nonnegative safe integers or decimal strings; positive sum required.
- Requires modern Intl and BigInt; currencies/precision use runtime Intl data.
  No DOM, currency conversion or cash-increment rounding.
- See repository `docs/money.md` and `examples/money.ts` for complete recipes.

---

## encoding

Binary encoding/decoding for Base64, Hex, and Base32. All functions work in both Node.js/Bun (uses `Buffer` when available) and browsers.

### API

```ts
encoding.toBase64(bytes: Uint8Array): string
encoding.fromBase64(base64: string): Uint8Array        // lenient (Bun/Node accept garbage)
encoding.fromBase64Strict(base64: string): Uint8Array  // strict: validates alphabet + padding; cross-runtime-consistent. Use for untrusted input.

encoding.toHex(bytes: Uint8Array): string          // lowercase, no "0x" prefix
encoding.fromHex(hex: string): Uint8Array           // case-insensitive, throws on odd length

encoding.toBase32(bytes: Uint8Array): string        // RFC 4648, uppercase, "=" padded
encoding.fromBase32(base32: string): Uint8Array     // case-insensitive, padding optional

encoding.toBase62(num: number, minLength?: number): string   // 0-9A-Za-z, URL-safe
encoding.fromBase62(str: string): number                      // inverse of toBase62
```

### Examples

```ts
import { encoding } from "@k2b/stdlib";

const bytes = new TextEncoder().encode("hello");
encoding.toBase64(bytes);  // "aGVsbG8="
encoding.toHex(bytes);     // "68656c6c6f"
encoding.toBase32(bytes);  // "NBSWY3DP"

encoding.fromBase64("aGVsbG8=");   // Uint8Array
encoding.fromHex("cafe");          // Uint8Array([0xca, 0xfe])
encoding.fromBase32("NBSWY3DP");   // Uint8Array

encoding.toBase62(123456789);       // "8M0kX"
encoding.toBase62(42, 6);           // "000010" (zero-padded to 6 chars)
encoding.fromBase62("8M0kX");       // 123456789
```

### Gotchas
- `fromHex` throws on odd-length strings and non-hex characters.
- `fromBase32` throws on characters outside A-Z, 2-7.
- `toBase62` uses the charset `0-9A-Za-z`. `fromBase62` throws on invalid characters.
- Uses native `Uint8Array.toHex`/`fromHex` when available (modern runtimes).

---

## crypto

Cryptographic utilities organized into sub-namespaces: `common`, `asymmetric`, `symmetric`, `totp`. Password generation has moved to the separate `password` module (see below).

### crypto.common

```ts
crypto.common.hash(input: string | Uint8Array): Promise<string>   // SHA-256, returns hex
crypto.common.fnv1aHash(s: string): string                        // sync FNV-1a, NOT cryptographic
crypto.common.readableId(...pattern: number[]): string             // e.g. readableId() => "a3X-B7nm-4Kp-qR9v"
crypto.common.uuid(): string                                       // crypto.randomUUID() wrapper
crypto.common.ulid(options?: { timestamp?: number | Date; monotonic?: boolean }): string // sortable ULID, not a secret
crypto.common.generateKey(length?: number): string                 // random hex key, default 32 bytes (256-bit)
```

```ts
import { crypto } from "@k2b/stdlib";

await crypto.common.hash("hello");       // "2cf24dba5fb0a30e..."
crypto.common.fnv1aHash("hello");        // "4f9f2cab"
crypto.common.readableId();              // "a3X-B7nm-4Kp-qR9v"
crypto.common.readableId(5, 5);          // "3nK4p-Xm9Bq"
crypto.common.uuid();                    // "550e8400-e29b-..."
crypto.common.ulid();                    // "01K..."
crypto.common.ulid({ monotonic: true }); // ordered within the same millisecond
const key = crypto.common.generateKey(); // 64-char hex string
```

ULIDs expose their millisecond timestamp. Use `generateKey()` for tokens, credentials, and other secret values.

### crypto.asymmetric

Hybrid ECDSA (signing) + ECDH (encryption) on P-256. Keys are serialized as `"S01:<ecdsa>:<ecdh>"` (private) and `"P01:<ecdsa>:<ecdh>"` (public).

```ts
crypto.asymmetric.generate(): Promise<{ privateKey: string; publicKey: string }>

crypto.asymmetric.sign(data: { privateKey: string; message: string }): Promise<{
  nonce: string; timestamp: number; signature: string; v: number    // always 2 for new signatures (length-prefixed payload)
}>

crypto.asymmetric.verify(data: {
  publicKey: string; signature: string; nonce: string;
  timestamp: number; message: string;
  maxAge?: number;
  v?: number;          // forwarded from sign()'s output; controls payload format. Missing → tries both v2 and v1 for backward compat.
  strict?: boolean;    // when true: rejects v1 (legacy) signatures AND high-S ECDSA forms. Use for security-critical paths.
}): Promise<boolean>

crypto.asymmetric.encrypt(data: { payload: string; publicKey: string }): Promise<string>
crypto.asymmetric.decrypt(data: { payload: string; privateKey: string }): Promise<string>
```

```ts
import { crypto } from "@k2b/stdlib";

// Generate key pair
const { privateKey, publicKey } = await crypto.asymmetric.generate();

// Sign + verify — forward ALL fields from sig (including v) to lock in v2
const sig = await crypto.asymmetric.sign({ privateKey, message: "hello" });
const valid = await crypto.asymmetric.verify({
  ...sig, publicKey, message: "hello",
});
// For security-critical paths use strict mode (rejects legacy v1 + high-S sigs):
const strictlyValid = await crypto.asymmetric.verify({
  ...sig, publicKey, message: "hello", strict: true,
});

// Encrypt + decrypt
const encrypted = await crypto.asymmetric.encrypt({ payload: "secret", publicKey });
const decrypted = await crypto.asymmetric.decrypt({ payload: encrypted, privateKey });
```

**Gotchas:**
- `verify` rejects signatures >1 hour old (configurable via `maxAge`), and >30s in the future (clock skew).
- `verify` returns `false` on crypto failures, but THROWS `TypeError` on invalid `maxAge` (NaN/Infinity/<=0) so the expiration check can't be silently disabled.
- Each `encrypt` call generates an ephemeral key pair, so the same plaintext encrypts differently each time.
- **Signature format v2 (current default):** `sign()` returns `v: 2` and uses length-prefixed payload bytes, closing the v1 field-boundary collision attack. Old v1 signatures (no `v`) still verify by default for backward compat. Pass `strict: true` to reject them. Forward the full `sig` object via `{...sig}` to lock in v2 verification.
- **ECDSA malleability:** `sign()` always emits low-S signatures. `verify()` accepts both forms by default; pass `strict: true` to reject high-S (non-canonical) forgeries.
- **Asymmetric blob v2 (current default):** uses full 32-byte HKDF salt + raw key encoding consistently. Old v1 blobs (16-byte salt, SPKI header) still decrypt — the version byte in the blob drives the decryption path automatically.

### crypto.symmetric

AES-256-GCM encryption. Supports both password-based (PBKDF2, 100k iterations) and key-based (HKDF) derivation.

```ts
crypto.symmetric.encrypt(data: { payload: string; key: string; stretched?: boolean }): Promise<string>
// stretched=true (default): PBKDF2 for user passwords
// stretched=false: HKDF for high-entropy keys (e.g. from generateKey)

crypto.symmetric.decrypt(data: { payload: string; key: string }): Promise<string>
// Auto-detects derivation method from the encrypted blob
```

```ts
import { crypto } from "@k2b/stdlib";

// Password-based (slow, safe for user passwords)
const enc = await crypto.symmetric.encrypt({ payload: "secret", key: "user-password" });
const dec = await crypto.symmetric.decrypt({ payload: enc, key: "user-password" });

// Key-based (fast, for server-side keys)
const key = crypto.common.generateKey();
const enc2 = await crypto.symmetric.encrypt({ payload: "data", key, stretched: false });
const dec2 = await crypto.symmetric.decrypt({ payload: enc2, key });
```

**Gotchas:**
- With `stretched: false` (HKDF mode), the key must be at least 16 hex chars (8 bytes); shorter keys throw. PBKDF2 (`stretched: true`, default) tolerates short user passwords because it stretches them.
- `decrypt()` throws on blobs shorter than 46 bytes ("too short") or with an unknown KDF flag (must be 0x00 or 0x01). Previously these were silent failures producing kryptic WebCrypto errors.

### crypto.totp

RFC 6238 TOTP (Time-based One-Time Password) for two-factor authentication.

```ts
crypto.totp.create(data: { label: string; issuer: string }): Promise<{ uri: string; secret: string }>
// uri = otpauth:// URI for QR provisioning
// secret = Base32 encoded shared secret (encrypt before storing!)

crypto.totp.verify(data: { token: string; secret: string; window?: number }): Promise<boolean>
// window (default 1) = how many 30-second steps to check on each side
```

```ts
import { crypto } from "@k2b/stdlib";

// Setup: generate secret, show QR code of uri to user
const { uri, secret } = await crypto.totp.create({ label: "user@example.com", issuer: "MyApp" });

// Store secret encrypted:
const encryptedSecret = await crypto.symmetric.encrypt({ payload: secret, key: serverKey, stretched: false });

// Verify user's 6-digit code:
const ok = await crypto.totp.verify({ token: "123456", secret });
```

**Gotchas:**
- Uses SHA-1 (required by the TOTP spec), 6 digits, 30-second period.
- Constant-time comparison is uniform across all `window` steps regardless of input token length — no length-based timing leak.
- **Throws** on malformed Base32 secret (was previously silent `false` — programmer mistakes are now loud, not buried as "wrong token"). Crypto failures (HMAC errors) still return `false`.
- `window` is clamped to a max of 10 to prevent DoS via `window: 1e7` (which previously meant millions of HMACs). Negative or non-finite values throw `TypeError`.

---

## password

Password generation and strength analysis. Separated from crypto for tree-shaking -- the 5KB EFF wordlist is only loaded when you import `password`.

### Types

```ts
type PasswordStrength = {
  entropy: number;       // bits of entropy
  score: number;         // 0-4 (0 = very weak, 4 = very strong)
  label: string;         // "very weak" | "weak" | "fair" | "strong" | "very strong"
  crackTime: string;     // human-readable crack time estimate, e.g. "centuries"
  feedback: string[];    // improvement suggestions, empty when strong
};
```

### API

```ts
password.random(options?: RandomPasswordOptions): string
// options: { length?: number (4-64, default 20), uppercase?: boolean (true), numbers?: boolean (true), symbols?: boolean (false) }

password.memorable(options?: MemorablePasswordOptions): string
// options: { words?: number (3-10, default 4), capitalize?: boolean (false), fullWords?: boolean (true), separator?: string ("-"), addNumber?: boolean (false), addSymbol?: boolean (false) }

password.pin(options?: PinPasswordOptions): string
// options: { length?: number (3-12, default 6) }

password.strength(pw: string): PasswordStrength
// Analyses entropy, estimates crack time, returns score and actionable feedback.
```

### Examples

```ts
import { password } from "@k2b/stdlib";

password.random();                                    // "aB3kLm9xQr2Wp5Nj7Ht"
password.random({ length: 32, symbols: true });       // includes !@#$%^&*...
password.memorable();                                 // "correct-horse-battery-staple"
password.memorable({ capitalize: true, addNumber: true }); // "Correct-Horse-7-Battery-Staple"
password.pin();                                       // "384729"
password.pin({ length: 8 });                          // "38472916"

// Strength analysis
const strong = password.strength("correct-horse-battery-staple");
// { entropy: 41.36, score: 2, label: "fair", crackTime: "5 minutes", feedback: ["Use more random words"] }

const weak = password.strength("password123");
// { entropy: 12.7, score: 1, label: "weak", crackTime: "seconds", feedback: ["Add more characters", ...] }
```

**Gotchas:**
- The memorable generator uses the EFF Short Wordlist 1 (1,296 words, 10.34 bits/word).
- Four random words are easy to type; use six or more words when offline cracking resistance matters.
- `strength` is a pure synchronous function -- no crypto calls involved.
- `random` and `pin` use `crypto.getRandomValues` (cryptographically secure).

---

## dates

Date formatting and calendar helpers with full IANA timezone support via `DateContext`.
Absolute formatters default to UTC; calendar helpers default to runtime-local time.

Since 0.27.0, absolute dates follow Intl locale punctuation and order, including
relative fallbacks and recurrence `until`. Default `en` now yields `Mar 5, 2025`;
use `en-GB` for day-first English. `formatDate` accepts `style: "numeric"` for
padded day/month: `02.05.2026` (de), `02/05/2026` (en-GB), `05/02/2026` (en).
`formatDateShort` remains fixed `d.M.`; `formatDateKey` is unchanged.

### API

```ts
type DateContext = {
  timeZone?: string;      // IANA, e.g. "Europe/Berlin"
  locale?: string;        // BCP 47, e.g. "de"
  weekStartsOn?: 0 | 1;   // Sunday or Monday, default Monday
  firstDayOfWeek?: 0 | 1; // Alias for weekStartsOn
};

dates.isValidTimeZone(timeZone: string): boolean
dates.normalizeTimeZone(value: string | null | undefined, fallback?: string): string
dates.zonedDateTimeToInstant(input: string, timeZone: string, options?: { disambiguation?: "compatible" | "earlier" | "later" | "reject" }): string
dates.instantToZonedInput(input: string | Date, timeZone: string): string       // "YYYY-MM-DDTHH:mm"
dates.formatDate(input: string | Date, ctx?: DateContext & { style?: "numeric" }): string              // "Mar 5, 2025"
dates.formatDateTime(input: string | Date, ctx?: DateContext): string          // "Mar 5, 2025, 13:53"
dates.formatDateTimeRelative(input: string | Date, ctx?: DateContext & { base?: string | Date }): string
dates.formatDateRelative(input: string | Date, ctx?: DateContext & { base?: string | Date }): string
dates.formatTimeSpan(input: string | Date, ctx?: DateContext & { base?: string | Date }): string
dates.formatDuration(from: string | Date, to: string | Date, ctx?: DateContext): string  // "2 hours, 15 minutes"
dates.formatRecurrence(rule: RecurrenceRule, ctx?: DateContext): string        // "Every Tue and Wed until Dec 23, 2024"
dates.formatRecurrenceParts(rule: RecurrenceRule, ctx?: DateContext): RecurrenceParts
dates.publicHolidays(year: number, region: "DE" | `DE-${GermanState}`): Holiday[] // German statutory holidays by state
```

### Examples

```ts
import { dates } from "@k2b/stdlib";

dates.formatDate("2025-03-05T13:53:00Z");          // "Mar 5, 2025"
dates.formatDateTime("2025-03-05T13:53:00Z");       // "Mar 5, 2025, 13:53"
dates.formatDateTime("2025-03-05T23:30:00Z", { timeZone: "Europe/Berlin" }); // "Mar 6, 2025, 00:30"
dates.formatDateTimeRelative(new Date());            // "now" (Intl.RelativeTimeFormat, ctx.locale, default "en")
dates.formatDateRelative(new Date());                // "14:30" (UTC default)
dates.formatDuration("2025-01-01", "2025-01-02T03:30:00Z"); // "1 day, 3 hours"
dates.formatDuration(a, b, { locale: "de" });        // "2 Stunden, 30 Minuten" (Intl unit style)
dates.formatRecurrence({ freq: "weekly", byWeekday: [2, 3], until });  // "Every Tue and Wed until Dec 23, 2024"
dates.formatRecurrenceParts({ freq: "weekly", byWeekday: [2, 3] }, { locale: "de" });
// { every: "Woche", weekdays: "Di und Mi" } -- compose localized sentences via an i18n catalog;
// formatRecurrence itself uses an English sentence skeleton ("Every ... until ...").

// Cloud apps: store UTC instants, edit in the app timezone
const timeZone = dates.normalizeTimeZone(app.timeZone, "UTC");
dates.isValidTimeZone(timeZone); // true

const startsAtIso = dates.zonedDateTimeToInstant("2026-06-01T09:00", "Europe/Berlin");
// "2026-06-01T07:00:00.000Z"

const inputValue = dates.instantToZonedInput(event.startsAt, app.timeZone);
const startsAt = dates.zonedDateTimeToInstant(inputValue, app.timeZone);

// Native datetime-local input values
dates.instantToZonedInput("2026-06-01T07:00:00.000Z", "Europe/Berlin");
// "2026-06-01T09:00"

// Calendar day queries in the user's timezone
dates.formatDateKey(new Date(), { timeZone });
dates.today({ timeZone });
dates.startOfDay("2026-06-01", { timeZone });
dates.endOfDay("2026-06-01", { timeZone });
dates.isSameDay(new Date(event.startsAt), new Date(), { timeZone });

// Recurring calendar events: keep "09:00 Europe/Berlin" at 09:00 across DST
const nextWallClock = dates.addZoned("2026-06-01T09:00", { timeZone, days: 7 });
const nextStartsAt = dates.addZonedInstant(event.startsAt, {
  timeZone: event.timeZone,
  weeks: 1,
});
```

### German public holidays

`dates.publicHolidays` and the named root export `publicHolidays` return fresh,
date-sorted `Holiday[]`: `{ date: string, key: HolidayKey, nationwide: boolean }`.
Dates are `YYYY-MM-DD`; names belong to app-owned `i18n.define` catalogs.
`DE` returns only nationwide holidays; state codes are `DE-BW`, `DE-BY`, `DE-BE`,
`DE-BB`, `DE-HB`, `DE-HH`, `DE-HE`, `DE-MV`, `DE-NI`, `DE-NW`, `DE-RP`, `DE-SL`,
`DE-SN`, `DE-ST`, `DE-SH`, `DE-TH`. Types `GermanState`, `HolidayRegion`,
`HolidayKey`, and `Holiday` are exported from the root.

Integer years **1995–9999**, inclusive; invalid years or unknown/case-mismatched
regions throw `RangeError` naming the value. No locale/timezone options. Date
ties keep rule-table order (2008-05-01: `labour-day`, then `ascension-day`).

Keys: `new-year`, `epiphany`, `womens-day`, `good-friday`, `easter-sunday`,
`easter-monday`, `labour-day`, `liberation-day`, `ascension-day`, `whit-sunday`,
`whit-monday`, `corpus-christi`, `uprising-1953`, `assumption-day`, `childrens-day`,
`german-unity-day`, `reformation-day`, `all-saints-day`, `repentance-day`,
`christmas-day`, `boxing-day`.

Historical boundaries: Women's Day BE since 2019, MV since 2023; Children's Day
TH since 2019; Reformation Day BB/MV/SN/ST/TH every supported year,
HB/HH/NI/SH since 2018, nationwide only in 2017. Berlin Liberation Day only in
2020 and 2025; Berlin uprising anniversary only in 2028. Easter/Whit Sunday
are listed only for BB, whose law names them; Hesse's general all-Sundays rule
is not modelled. Repentance Day is SN only.

Not modelled: Bavarian Assumption Day (municipalities with a predominantly
Catholic population; `assumption-day` is SL only), municipal Corpus Christi in
SN/TH, Augsburg Peace Festival (08-08, city only), or non-statutory days off
such as Christmas Eve and New Year's Eve.

### Relative time buckets (formatDateTimeRelative)
- < 5s: "now"
- < 1min: "12 secs ago"
- < 1h: "4 mins ago"
- < 24h: "2 hours ago"
- < 48h: "yesterday" (localized via Intl.RelativeTimeFormat)
- < 7d: weekday name ("Mon")
- >= 7d or future: falls back to formatDate

---

## dates (calendar views)

Calendar grid generation, date arithmetic, and formatting are all part of the `dates` module (not a separate `calendar` module).

### Types

```ts
type CalendarItemLike = { startsAt: string | null; endsAt: string | null; deadline: string | null };
type CalendarUrlParams = { view?: "month" | "week"; date?: Date; item?: string };
```

### API

```ts
// Grid generation
dates.getMonthGrid(year: number, month: number, ctx?: DateContext): Date[][]   // month is 0-indexed, returns 4-6 weeks
dates.getWeekDays(date: Date, ctx?: DateContext): Date[]                       // 7 days, Monday-Sunday

// Date ranges
dates.getDateRange(view: "month" | "week", date: Date, ctx?: DateContext): { from: Date; to: Date }

// Item filtering
dates.itemOnDate(item: CalendarItemLike, date: Date, ctx?: DateContext): boolean
dates.getDayItems<T extends CalendarItemLike>(items: T[], date: Date, ctx?: DateContext): T[]

// Date checks
dates.isToday(date: Date, ctx?: DateContext): boolean
dates.isSameMonth(date: Date, refDate: Date, ctx?: DateContext): boolean
dates.isSameDay(a: Date, b: Date, ctx?: DateContext): boolean

// Locale/timezone-aware formatting
dates.formatMonthYear(date: Date, ctx?: DateContext): string  // "March 2025"
dates.formatDayNumber(date: Date, ctx?: DateContext): string                   // "9"
dates.formatWeekdayShort(date: Date, ctx?: DateContext): string
dates.formatWeekdayLong(date: Date, ctx?: DateContext): string
dates.formatFullDate(date: Date, ctx?: DateContext): string
dates.formatDateShort(date: Date, ctx?: DateContext): string
dates.formatDateKey(input: string | Date, ctx?: DateContext): string           // "2025-03-09"
dates.formatTime(input: string | Date, ctx?: DateContext): string              // "14:30"

// Navigation
dates.startOfDay(input: string | Date, ctx?: DateContext): Date
dates.endOfDay(input: string | Date, ctx?: DateContext): Date
dates.addMonths(date: Date, n: number, ctx?: DateContext): Date
dates.addWeeks(date: Date, n: number, ctx?: DateContext): Date
dates.addDays(date: Date, n: number, ctx?: DateContext): Date
dates.startOfMonth(date: Date, ctx?: DateContext): Date
dates.startOfWeek(date: Date, ctx?: DateContext): Date                         // Monday by default
dates.today(ctx?: DateContext): Date                                           // start of current day
dates.addZoned(input: string, options: { timeZone: string; days?: number; weeks?: number; months?: number; years?: number }): string
dates.addZonedInstant(input: string | Date, options: { timeZone: string; days?: number; weeks?: number; months?: number; years?: number }): string

// Dynamic locale-aware constants
dates.weekdays(ctx?: DateContext): string[]  // ["Mon","Tue",...]
dates.months(ctx?: DateContext): string[]    // ["January",...]
dates.getYearOptions(ctx?: DateContext): number[]             // current year +/- 5

// URL helpers
dates.buildCalendarUrl(baseUrl: string, params: CalendarUrlParams, ctx?: DateContext): string
dates.parseCalendarDate(param: string | undefined, ctx?: DateContext): Date
```

### Examples

```ts
import { dates } from "@k2b/stdlib";

const weeks = dates.getMonthGrid(2025, 2);  // March 2025
// weeks[0] = [Mon, Tue, Wed, Thu, Fri, Sat, Sun]

const range = dates.getDateRange("month", new Date(), { timeZone: "Europe/Berlin" });
// { from: Date, to: Date } -- full month incl. padding days

const items = dates.getDayItems(allItems, new Date(), { timeZone: "Europe/Berlin" });
// only items that overlap today

const nextMonth = dates.addMonths(new Date(), 1, { timeZone: "Europe/Berlin" });

// Locale-aware
dates.formatMonthYear(new Date(), { locale: "de" });  // "März 2025"
dates.weekdays({ locale: "fr" });                     // ["lun.", "mar.", ...]
dates.formatDateKey(new Date("2025-03-05T02:30:00Z"), { timeZone: "America/New_York" }); // "2025-03-04"

// Cloud timezone helpers
const timeZone = dates.normalizeTimeZone(app.timeZone, "UTC");
const dayKey = dates.formatDateKey(event.startsAt, { timeZone });
const startsAtInput = dates.instantToZonedInput(event.startsAt, timeZone);
const storedStartsAt = dates.zonedDateTimeToInstant(startsAtInput, timeZone);
const dayStart = dates.startOfDay(dayKey, { timeZone });
const dayEnd = dates.endOfDay(dayKey, { timeZone });
const isCurrentUserDay = dates.isSameDay(new Date(event.startsAt), new Date(), { timeZone });

// DST-safe recurrence. There is no addZonedDays alias; use days/weeks on addZoned.
dates.addZoned("2026-06-01T09:00", { timeZone: "Europe/Berlin", days: 7 });
dates.addZonedInstant("2026-06-01T07:00:00.000Z", { timeZone: "Europe/Berlin", weeks: 1 });
```

**Gotchas:**
- `month` parameter is 0-indexed (0 = January).
- `getMonthGrid` includes padding days from adjacent months.
- Date values are still instants. `timeZone` controls how those instants are read as civil calendar days.
- Calendar ranges return Date instants for the start/end of the zoned civil range.
- `zonedDateTimeToInstant` rejects nonexistent/ambiguous DST wall-clock values by default; pass `disambiguation` only when shifting or choosing an occurrence is intentional.
- Formatting and exact IANA offset resolution use native `Intl.DateTimeFormat`; calendar arithmetic uses dayjs `utc` + `timezone`.

---

## timing

Async timing primitives.

### API

```ts
timing.sleep(ms: number): Promise<void>

timing.withMinLoadTime<T>(fn: () => Promise<T>, minMs?: number): Promise<T>
// Ensures fn takes at least minMs (default 300ms). Prevents UI flicker.

timing.buffer<T>(fn: (key: string, data: T) => Promise<void>, intervalMs?: number): (key: string, data: T) => void
// Write-coalescing buffer. Batches by key, flushes after intervalMs (default 5000ms).
// Multiple writes within the interval keep the latest value; timer does NOT reset.

timing.jitter(value: number, range: number): number
// Adds crypto-random offset in [-range, +range] to value.

timing.random(min?: number, max?: number, step?: number): number
// Random in [min, max). With step, rounds to nearest multiple.
// Default: random() = 0-1 like Math.random.

timing.shuffle<T>(array: readonly T[]): T[]
// Fisher-Yates shuffle. Returns NEW array. Uses Math.random (not cryptographic).

timing.debounce<T extends (...args: any[]) => void>(fn: T, delayMs: number): T & { cancel(): void }
// Delays execution until delayMs after the last call. Returns debounced fn with cancel().

timing.throttle<T extends (...args: any[]) => void>(fn: T, intervalMs: number): T & { cancel(): void }
// Executes fn at most once per intervalMs. Trailing call is preserved.
```

### Examples

```ts
import { timing } from "@k2b/stdlib";

await timing.sleep(500);

// Prevent spinner flicker
const data = await timing.withMinLoadTime(() => fetchData(), 500);

// Debounced auto-save
const save = timing.buffer(async (key, data) => {
  await api.save(key, data);
}, 2000);
save("doc-1", { title: "Draft" });
save("doc-1", { title: "Final" }); // replaces previous, flushes after 2s

// Retry with jitter
await timing.sleep(1000 + timing.jitter(0, 200)); // ~800-1200ms

timing.random(1, 10);       // float 1-10
timing.random(1, 10, 1);    // integer 1-10
timing.random(0, 100, 5);   // 0, 5, 10, ... 100

timing.shuffle([1, 2, 3, 4, 5]); // e.g. [3, 1, 5, 2, 4]

// Debounce: delays until input stops
const search = timing.debounce((q: string) => fetchResults(q), 300);
search("hel"); search("hello");  // only "hello" fires after 300ms
search.cancel();                  // cancel pending call

// Throttle: at most once per interval
const onScroll = timing.throttle(() => updatePosition(), 100);
window.addEventListener("scroll", onScroll);
onScroll.cancel();                // cancel pending trailing call
```

**Gotchas:**
- `buffer` does NOT reset the timer on subsequent writes. First write starts the clock, latest value is flushed.
- `buffer` on flush error: logs to console, data is preserved (not deleted).
- `shuffle` uses `Math.random`. For cryptographic shuffle, use `crypto.common` internals (`secureShuffle` is internal).
- `jitter` uses `crypto.getRandomValues` (cryptographically secure).
- `debounce` resets the timer on each call. Only the last call's arguments are used.
- `throttle` preserves the trailing call -- if called during the cooldown, the last call fires after the interval.

---

## streaming

Async generators for consuming `ReadableStream` data (e.g. from `fetch()` response bodies).

### API

```ts
streaming.parseSSE(stream: ReadableStream<Uint8Array>): AsyncGenerator<{ event?: string; data: string; id?: string }>
// Yields parsed Server-Sent Event objects. Handles multi-line data fields and reconnection IDs.

streaming.parseNDJSON<T>(stream: ReadableStream<Uint8Array>): AsyncGenerator<T>
// Yields parsed JSON objects from a newline-delimited JSON stream. Skips blank lines.
```

### Examples

```ts
import { streaming } from "@k2b/stdlib";

// Server-Sent Events
const res = await fetch("/api/events");
for await (const event of streaming.parseSSE(res.body!)) {
  console.log(event.event, event.data);  // e.g. "message", '{"text":"hello"}'
}

// NDJSON (e.g. structured log stream)
const res2 = await fetch("/api/logs");
for await (const entry of streaming.parseNDJSON<{ level: string; msg: string }>(res2.body!)) {
  console.log(`[${entry.level}] ${entry.msg}`);
}
```

**Gotchas:**
- Both generators fully consume the stream. Do not read the same stream twice.
- `parseSSE` follows the SSE spec: empty `event` defaults to `"message"`, multi-line `data:` fields are joined with `\n`.
- `parseNDJSON` calls `JSON.parse` per line -- invalid JSON lines throw.

---

## i18n

Type-safe message catalogs with BCP-47 fallback resolution, plus thin Intl
wrappers. Dependency-free, SSR-safe, no global state; the stdlib ships no
translations (Intl/CLDR provides all locale data).

```typescript
i18n.define(config: { baseLocale: B; messages: { [locale: string]: MessageRecord } }): Catalog
// MessageRecord values: string | ((params: P) => string)
// Base locale defines keys + param types; other locales are compile-time-checked
// subsets with params contextually typed from the base locale.

catalog.resolve(requested?: readonly string[]): { locale: string; t: BaseMessages }
// Fallback per requested tag: exact -> strip subtags ("de-AT" -> "de") -> next tag -> baseLocale.
// Case-insensitive matching. t merges base -> defined ancestors -> resolved locale
// (per-key hierarchical fallback: "de-CH" inherits from "de", then base; most specific wins).
catalog.check(): { locale: string; missing: string[]; extra: string[] }[]  // assert [] in a test
catalog.locales: string[]   // base first
catalog.baseLocale: string

i18n.parseAcceptLanguage(header: string | null | undefined): string[]
// Sorted by q desc (missing q = 1, stable ties), drops q<=0 and "*".

i18n.plural(count: number, locale: string | undefined, forms: { zero?; one?; two?; few?; many?; other }): string
i18n.formatList(items: readonly string[], locale?: string, opts?: { type?: "conjunction" | "disjunction" | "unit"; style?: "long" | "short" | "narrow" }): string
i18n.compare(locale?: string, opts?: Intl.CollatorOptions): (a: string, b: string) => number
```

```typescript
const catalog = i18n.define({
  baseLocale: "en",
  messages: {
    en: { title: "Inbox", greeting: ({ name }: { name: string }) => `Hello ${name}` },
    de: { title: "Eingang", greeting: ({ name }) => `Hallo ${name}` },
  },
});
const { locale, t } = catalog.resolve(i18n.parseAcceptLanguage(header)); // "de-AT" -> "de"
t.greeting({ name: "Ada" });          // "Hallo Ada"
t.title;                              // "Eingang"
dates.formatDate(date, { locale });   // resolved locale feeds dates/text formatting

i18n.plural(2, "de", { one: "Tag", other: "Tage" });   // "Tage"
i18n.formatList(["Di", "Mi", "Fr"], "de");             // "Di, Mi und Fr"
["Öl", "Apfel"].sort(i18n.compare("de"));              // ["Apfel", "Öl"]
```

Notes:
- Catalogs own only app messages; UI-facing `ServiceError`s should be localized by mapping `error.code` through a catalog at the UI edge (`message` stays dev-facing).
- `resolve` is cheap (precomputed translators); call it per request/render, never store the result globally.

## text

String manipulation utilities.

### API

```ts
text.slugify(content: string): string     // "Hello World!" => "hello-world"
text.humanize(content: string): string    // "hello_world-foo" => "Hello world foo"
text.titleify(content: string): string    // "hello_world-foo" => "Hello World Foo"
type PprintNumberOptions = {
  compact?: boolean;
  decimals?: number;
  locale?: string;
  fallback?: string;
};
text.pprintNumber(value: number | null | undefined, options?: PprintNumberOptions): string

type PprintPercentOptions = {
  decimals?: number;
  clamp?: boolean;
  locale?: string;
  fallback?: string;
};
text.pprintPercent(ratio: number | null | undefined, options?: PprintPercentOptions): string

type PprintDurationMsOptions = {
  locale?: string;
  fallback?: string;
};
text.pprintDurationMs(
  milliseconds: number | null | undefined,
  options?: PprintDurationMsOptions,
): string

text.pprintBytes(bytes: number, options?: { mode?: "iec" | "si"; locale?: string }): string
// 1536 => "1.5 KiB", (1500, { mode: "si" }) => "1.5 KB". Default mode: "iec".

text.pprintBytesParts(bytes: number, options?: { mode?: "iec" | "si"; locale?: string }): { value: string; unit: string }
text.pprintCurrency(value: number | null | undefined, currency: string, options?: { decimals?: number; locale?: string; fallback?: string }): string
// 1536 => { value: "1.5", unit: "KiB" } -- for styled UI rendering

text.truncate(content: string, limit: number, mode?: "end" | "start" | "middle"): string
// Truncates to limit chars with "..." marker. Default mode: "end".

text.summarize(content: string, limit: number, mode?: "end" | "start" | "middle"): string
// Like truncate but breaks at word boundaries.

text.camelCase(content: string): string   // "hello-world" => "helloWorld"
text.snakeCase(content: string): string   // "helloWorld" => "hello_world"
text.kebabCase(content: string): string   // "HelloWorld" => "hello-world"
text.pascalCase(content: string): string  // "hello_world" => "HelloWorld"
```

### Examples

```ts
import { text } from "@k2b/stdlib";

text.slugify("Uber uns!");         // "uber-uns"
text.slugify("  ---  ");           // ""
text.humanize("user_first_name");  // "User first name"
text.titleify("hello-world");      // "Hello World"
text.pprintNumber(1_234_567, { locale: "en-US" });                 // "1,234,567"
text.pprintNumber(1_234, { compact: true, locale: "de-DE" });      // "1,2k"
text.pprintPercent(0.999, { decimals: 3, locale: "en-US" });       // "99.900%"
text.pprintPercent(1.4, { clamp: true, locale: "en-US" });         // "100%"
text.pprintDurationMs(0.4);                                        // "<1ms"
text.pprintDurationMs(90_000);                                     // "1m 30s"
text.pprintDurationMs(null, { fallback: "n/a" });                  // "n/a"
text.pprintBytes(0);               // "0 B"
text.pprintBytes(1536);            // "1.5 KiB"   (default IEC, 1024-base)
text.pprintBytes(1500, { mode: "si" });  // "1.5 KB"    (SI, 1000-base)
text.pprintBytes(1536, { locale: "de" });// "1,5 KiB"
text.pprintBytes(2 ** 50);         // "1 PiB"
text.pprintBytes(NaN);             // "0 B"
text.pprintBytesParts(1536);       // { value: "1.5", unit: "KiB" }
text.pprintCurrency(1234.5, "EUR", { locale: "de" });     // "1.234,50 €"
text.pprintCurrency(1234.5, "USD", { locale: "en-US" });  // "$1,234.50"

text.truncate("Hello World", 8);           // "Hello..."
text.truncate("Hello World", 8, "start");  // "...World"
text.truncate("Hello World", 8, "middle"); // "He...ld"
text.summarize("The quick brown fox jumps over the lazy dog", 20); // "The quick brown..."

text.camelCase("hello-world");     // "helloWorld"
text.snakeCase("helloWorld");      // "hello_world"
text.kebabCase("HelloWorld");      // "hello-world"
text.pascalCase("hello_world");    // "HelloWorld"
```

**Gotchas:**
- `slugify` does NFKD normalization and strips diacritics. "u" with combining mark becomes "u".
- `pprintNumber` uses deterministic `k/M/B/T` compact suffixes. Only the numeric part follows `locale`; explicit `decimals` are fixed.
- `pprintPercent` always accepts a ratio: `0.19` renders as `19%`. It never accepts an already multiplied percentage scale. `clamp: true` constrains the ratio to `0..1`.
- `pprintDurationMs` accepts a raw millisecond count and uses the `ms/s/m/h/d` ladder with at most two non-zero units for minute-or-longer values.
- The new numeric pretty-printers return `"—"` for null, undefined, or non-finite values unless `fallback` is set. Negative durations are also invalid.
- `pprintBytes` defaults to IEC binary units (1 KiB = 1024 B). Pass `{ mode: "si" }` for decimal units (1 KB = 1000 B).
- `pprintBytes` is locale-aware: decimal separator follows `options.locale` (default runtime locale) via `Intl.NumberFormat` (e.g. `"1,5 KiB"` in DE, `"1.5 KiB"` in EN). Thousands grouping is disabled.
- `pprintCurrency` takes an ISO 4217 code; symbol, placement, and default fraction digits follow the locale/currency. Same `"—"` fallback contract as the other pprint helpers.
- `pprintBytes` and `pprintBytesParts` guard against Infinity, NaN, and non-positive values, returning `"0 B"` / `{ value: "0", unit: "B" }`.
- `pprintBytesParts` is the right call when you want to style value and unit independently in a UI (e.g. large number, small unit label).
- `truncate` counts the `"..."` marker towards the limit. If `limit` < 4, returns the raw truncation without a marker.
- `summarize` breaks at the last space before the limit, so the result may be shorter than `limit`.
- Case conversion functions split on hyphens, underscores, spaces, and camelCase boundaries.

---

## fuzzy

Subsequence fuzzy match for UI search (command palette, list filters) and
Levenshtein edit distance for "did you mean?" lookups. Case-insensitive by
default; pass `caseSensitive: true` to opt into strict matching.

### API

```ts
type FuzzyMatch = {
  score: number;                                       // raw, sort within a query only
  ranges: ReadonlyArray<readonly [number, number]>;    // [start, endExclusive] in target
};

type FuzzyHit<T> = FuzzyMatch & { item: T; target: string };
type ClosestMatch = { value: string; distance: number; similarity: number };
type FuzzySegment = { text: string; match: boolean };

fuzzy.match(query: string, target: string, opts?: { caseSensitive?: boolean }): FuzzyMatch | null

fuzzy.filter<T>(
  query: string,
  items: readonly T[],
  opts?: { key?: (item: T) => string; limit?: number; caseSensitive?: boolean },
): Array<FuzzyHit<T>>

fuzzy.segments(target: string, ranges: ReadonlyArray<readonly [number, number]>): FuzzySegment[]

fuzzy.distance(a: string, b: string): number  // Levenshtein, case-sensitive

fuzzy.closest(
  query: string,
  choices: readonly string[],
  opts?: { maxDistance?: number; caseSensitive?: boolean },
): ClosestMatch | null
```

### Examples

```ts
import { fuzzy } from "@k2b/stdlib";

// UI command palette
fuzzy.match("udh", "userDashboard");
// { score: 78, ranges: [[0,1], [4,5], [7,8]] }

fuzzy.filter("udh", ["userDashboard", "logout", "userHome"]);
// → sorted hits with score + ranges

fuzzy.filter("ab", users, { key: u => u.name, limit: 10 });

// Highlight matched substrings in JSX (SolidJS example)
const segs = fuzzy.segments(hit.target, hit.ranges);
// segs.map(s => s.match ? <mark>{s.text}</mark> : s.text)

// "Did you mean?"
fuzzy.distance("color", "colour");  // 1
fuzzy.closest("hellp", ["hello", "help"]);
// { value: "hello", distance: 1, similarity: 0.8 }
```

**Gotchas:**
- `fuzzy.match` returns `null` when `query` is not a subsequence of `target`. Empty queries return `{ score: 0, ranges: [] }` (a no-op match) — useful so `filter` returns all items unfiltered.
- The `score` is raw and only meaningful within a single query (e.g. for sorting). Don't compare scores across different queries or use absolute thresholds.
- Word boundaries are detected for kebab/snake/space/dot separators and lower→Upper camelCase transitions. Non-ASCII characters are treated as word chars (no boundary detection beyond ASCII).
- `fuzzy.distance` is case-sensitive (lowercase manually for case-insensitive distance). `fuzzy.closest` is case-insensitive by default but preserves the original casing in the returned `value`.
- The match algorithm is 2D dynamic programming — optimal, not greedy. Worst case O(Q·T) per match; subsequence pre-check rejects non-matches in O(T) before the DP runs. Suitable for live filtering of 10k+ items.
- `fuzzy.segments` expects sorted, non-overlapping ranges (the canonical shape produced by `match`/`filter`). Pass other shapes at your own risk.

---

## highlight

Headless string-to-HTML highlighting for textarea overlays, markdown previews,
and small domain-specific languages. It returns escaped HTML with semantic class
names only: no CSS, no themes, no colors, no DOM helpers, and no external parser
dependencies.

### API

```ts
type Highlighter = (text: string) => string;

type HighlightRule = {
  kind: string;  // rendered as `${classPrefix}${kind}` after class-name sanitising
  match: RegExp; // matched at the current cursor position
};

highlight.escape(text: string): string

highlight.markdown(text: string, options?: {
  knownLabels?: ReadonlySet<string>; // wraps standalone labels in md-completion-match
}): string

highlight.overlay(
  text: string,
  render: (text: string) => string,
  options?: {
    ghost?: { at: number; text: string };
    anchor?: { at: number };
  },
): string

highlight.compile(
  rules: readonly HighlightRule[],
  options?: { classPrefix?: string }, // default "hl-"
): Highlighter

highlight.presets.shell(text: string): string
highlight.presets.code(text: string): string
highlight.presets.sql(text: string): string
```

### Examples

```ts
import { highlight } from "@k2b/stdlib";

// Safe escaped HTML for raw text.
highlight.escape(`<b>"x"</b>`);
// "&lt;b&gt;&quot;x&quot;&lt;/b&gt;"

// Cloud-compatible markdown preview for textarea overlays.
highlight.markdown("**Ship** `v1` and ping #roadmap", {
  knownLabels: new Set(["#roadmap"]),
});
// Uses md-* classes such as md-bold, md-code, md-syntax, md-completion-match.

// Completion overlay. The sentinel is injected before markdown rendering,
// then replaced with a completion ghost or caret anchor.
highlight.overlay("**Ship**", highlight.markdown, {
  ghost: { at: 8, text: " it" },
});

// Domain-specific language highlighter. Compile once, reuse per input event.
const renderFormula = highlight.compile([
  { kind: "comment", match: /#.*/ },
  { kind: "string", match: /"(?:\\.|[^"])*"/ },
  { kind: "variable", match: /\$[a-zA-Z_]\w*/ },
  { kind: "keyword", match: /\b(IF|THEN|ELSE|SUM)\b/ },
  { kind: "number", match: /\b\d+(?:\.\d+)?\b/ },
  { kind: "operator", match: /[+\-*/=<>!]+/ },
]);

renderFormula(`IF $price > 10 THEN "ok" # comment`);

// Shallow dependency-free presets.
highlight.presets.shell(`if [ "$USER" ]; then # hi`);
highlight.presets.code(`const x = "ok"; // hi`);
highlight.presets.sql(`SELECT id FROM users WHERE email = $1`);
```

**Gotchas:**
- `highlight.markdown` is a Cloud-compatible editor highlighter, not a full Markdown renderer. It keeps syntax characters visible for textarea overlay alignment.
- `highlight.compile` is intentionally shallow. It does ordered regex token wrapping, not AST parsing.
- `highlight.presets.sql` is also shallow and dialect-neutral. It covers common comments, strings, quoted identifiers, parameters (`$1`, `:name`, `@name`, `?`), numbers, keywords, functions, and operators, but does not parse SQL semantics or nested dialect features.
- Rule order is priority. Put broad protected constructs such as comments and strings before keywords.
- Compile custom highlighters once and reuse the returned function during editor input renders.
- All raw input is HTML-escaped before wrapping, so the returned string is safe to use with `innerHTML` when the rules are trusted code.

The code and SQL presets highlight unfinished block comments through EOF.
Other delimited tokens retain their existing output. Failed quoted-token scans
are cached through EOF; failed SQL bracket-identifier and shell `${...}` scans
are cached through the newline or EOF. Repeated openers therefore do not rescan
the same suffix. The code preset has no separate regex-literal rule.
Custom `highlight.compile` rules remain caller-owned; their regex complexity
is not bounded by the compiler.

---

## cache

In-memory TTL cache with lazy loading and cleanup hooks.

### Types

```ts
type CacheOptions<T> = {
  ttl?: number;                              // default 30 minutes (30 * 60_000)
  onMiss?: (key: string) => T | null | Promise<T | null>;
  beforePurge?: (key: string, value: T) => void | Promise<void>;
};

type Cache<T> = {
  get(key: string): Promise<T | null>;
  set(key: string, valueOrUpdater: T | ((current: T | null) => T | Promise<T>)): Promise<T>;
  delete(key: string): void;
  has(key: string): boolean;
  clear(): void;
  size(): number;
};
```

### API

```ts
cache.create<T>(options?: CacheOptions<T>): Cache<T>
// Also exported as: createCache<T>(options?)
```

### Examples

```ts
import { cache, createCache } from "@k2b/stdlib";

// Simple TTL cache
const tokenCache = cache.create<string>({ ttl: 60_000 });
await tokenCache.set("access", "eyJ...");
const token = await tokenCache.get("access"); // string | null

// Auto-fetching cache (lazy loading)
const userCache = createCache<User>({
  ttl: 5 * 60_000,
  onMiss: async (key) => {
    const res = await fetch(`/api/users/${key}`);
    return res.ok ? res.json() : null;
  },
  beforePurge: (key) => console.log(`evicted: ${key}`),
});
const user = await userCache.get("user-123"); // fetches on first call, cached after

// Updater function for atomic read-modify-write
await tokenCache.set("count", 1);
await tokenCache.set("count", (prev) => (prev ?? 0) + 1);

// Check and size
tokenCache.has("access"); // true/false (sync)
tokenCache.size();        // number of non-expired entries
tokenCache.clear();       // removes all entries + cancels timers
```

**Gotchas:**
- `get` returns `Promise<T | null>` even without `onMiss` (async for consistency).
- `delete` and `clear` do NOT trigger `beforePurge`.
- `size()` iterates all entries to exclude expired ones (O(n)).
- Concurrent `get` calls triggering `onMiss` for the same key both execute. No built-in deduplication.

---

## result

Result type for service-layer error handling. Eliminates try/catch boilerplate.

### Types

```ts
type ServiceErrorCode = "BAD_INPUT" | "UNAUTHENTICATED" | "FORBIDDEN" | "NOT_FOUND" | "CONFLICT" | "TOO_MANY_REQUESTS" | "INTERNAL" | "UNAVAILABLE";

type ServiceError<C extends string = string> = {
  code: C;
  message: string;
  status: 400 | 401 | 403 | 404 | 405 | 406 | 408 | 409 | 410 | 412 | 413 | 415 | 416 | 421 | 422 | 429 | 500 | 501 | 502 | 503 | 504;
};

type Result<T = void, E extends ServiceError = ServiceError> =
  | { ok: true; data: T }
  | { ok: false; error: E };

type PageParams = { page?: number; perPage?: number };

type Paginated<T> = {
  items: T[];
  page: number;
  perPage: number;
  total: number;
  hasNext: boolean;
};
```

### API

```ts
// Constructors
ok(): Result<void, never>
ok<T>(data: T): Result<T, never>
okMany<T>(items: T[], info: { page: number; perPage: number; total: number }): Result<Paginated<T>, never>
fail<E extends ServiceError>(error: E): Result<never, E>

// Error factories
err.badInput(why: string): ServiceError         // 400
err.unauthenticated(why?: string): ServiceError // 401
err.forbidden(why?: string): ServiceError       // 403
err.notFound(what: string): ServiceError        // 404, message: "<what> not found"
err.conflict(message: string): ServiceError     // 409, message taken as given (a full sentence)
err.tooManyRequests(why?: string): ServiceError // 429, default "Too many requests"
err.internal(why?: string): ServiceError        // 500
err.unavailable(why?: string): ServiceError     // 503, default "Service unavailable"

// Helpers
paginate(params?: PageParams): { page: number; perPage: number; offset: number }
unwrap<T>(result: Result<T>): T                  // throws on failure
isServiceError(value: unknown): value is ServiceError
tryCatch<T>(fn: () => Promise<T>, onError?: (error: unknown) => ServiceError): Promise<Result<T>>
```

### Examples

```ts
import { ok, fail, err, okMany, paginate, unwrap, tryCatch } from "@k2b/stdlib";

// Service function pattern
async function getUser(id: string): Promise<Result<User>> {
  const user = await db.findUser(id);
  if (!user) return fail(err.notFound("User"));
  return ok(user);
}

// Consuming results
const result = await getUser("123");
if (!result.ok) {
  console.error(result.error.code, result.error.message); // "NOT_FOUND", "User not found"
  return;
}
console.log(result.data); // User

// unwrap -- throws if not ok
const user = unwrap(await getUser("123"));

// Paginated results
const { page, perPage, offset } = paginate({ page: 2, perPage: 10 });
const users = await db.query({ limit: perPage, offset });
return okMany(users, { page, perPage, total: 100 });
// { ok: true, data: { items: [...], page: 2, perPage: 10, total: 100, hasNext: true } }

// tryCatch -- wraps async function, never throws
const result2 = await tryCatch(() => riskyOperation());
// On error: { ok: false, error: { code: "INTERNAL", message: "...", status: 500 } }
```

**Gotchas:**
- `ok()` with no args produces `{ ok: true, data: undefined }` (`Result<void>`).
- `unwrap` throws an `Error` with `code` and `status` properties `Object.assign`ed onto it.
- `paginate` clamps both `page` and `perPage` to minimum 1. Default: page=1, perPage=20.
- `isServiceError` keeps its numeric shape check: string `code`/`message`, numeric `status`. It accepts custom codes and numbers outside the static status union; it does not validate HTTP status ranges. `tryCatch` preserves these objects without invoking its error mapper.
- `tryCatch` checks `isServiceError` first -- if the thrown value is already a `ServiceError`, it wraps it directly.
- `err.notFound("User")` produces message `"User not found"`. `err.conflict(message)` takes its full sentence as given, such as `err.conflict("Email already exists")` or `err.conflict("Task changed; read it and retry")`; it appends nothing (since 0.33.0).

---

## qr

QR code payload generation and SVG rendering. Lives behind the
`@k2b/stdlib/qr` subpath so the optional `lean-qr` peer dependency
is only required for consumers that actually use QR features.

### API

```ts
qr.wifi(opts: { ssid: string; password?: string; encryption?: "WPA" | "WEP" | "nopass"; hidden?: boolean }): string
qr.email(opts: { to: string; subject?: string; body?: string }): string
qr.tel(opts: { number: string }): string
qr.vcard(opts: {
  firstName: string; lastName?: string; organization?: string; title?: string;
  phone?: string; email?: string; website?: string;
  street?: string; city?: string; zip?: string; country?: string;
}): string
qr.event(opts: {
  title: string; location?: string;
  start?: string; end?: string;    // datetime-local format: "2025-06-15T14:30"
  description?: string;
}): string
qr.toSvg(data: string, opts?: { on?: string; off?: string; correctionLevel?: "L" | "M" | "Q" | "H" }): string
```

### Examples

```ts
import { qr } from "@k2b/stdlib/qr";

// WiFi QR code
const wifiData = qr.wifi({ ssid: "Office", password: "secret", encryption: "WPA" });
// "WIFI:T:WPA;S:Office;P:secret;;"

// Render as SVG
const svgString = qr.toSvg(wifiData, { correctionLevel: "M", on: "#000", off: "#fff" });

// Email
qr.email({ to: "a@b.c", subject: "Hello" }); // "mailto:a@b.c?subject=Hello"

// Phone
qr.tel({ number: "+49123456" }); // "tel:+49123456"

// vCard contact
const vcardData = qr.vcard({
  firstName: "John", lastName: "Doe",
  organization: "Acme", phone: "+49123456", email: "john@acme.com"
});

// Calendar event
const eventData = qr.event({
  title: "Meeting",
  start: "2025-06-15T14:30", end: "2025-06-15T15:30",
  location: "Room 42"
});
const eventSvg = qr.toSvg(eventData);
```

**Gotchas:**
- `toSvg` defaults: `on="#000000"`, `off="#ffffff"`, `correctionLevel="M"`.
- WiFi special characters (`;,:"\`) are auto-escaped in SSID and password.
- vCard uses CRLF line endings per RFC 6350.
- Event start/end use `datetime-local` format (`"2025-06-15T14:30"`), not ISO 8601 with timezone.

---

## svg

Deterministic SVG avatar generation and WebP parsing.

### API

```ts
svg.generateAvatar(id: string, text: string): Uint8Array
// Returns UTF-8 encoded SVG (128x128). Color is deterministic from id.
// Text is uppercased, truncated to 2 chars. Empty text shows "?".

svg.parseWebpDataUrl(dataUrl: string): Uint8Array | null
// Extracts raw bytes from "data:image/webp;base64,...". Returns null if format is wrong.
```

### Examples

```ts
import { svg } from "@k2b/stdlib";

const avatarBytes = svg.generateAvatar("user-123", "JD");
// Uint8Array containing SVG with colored background and "JD" text

// Use as data URL
const blob = new Blob([avatarBytes], { type: "image/svg+xml" });
const url = URL.createObjectURL(blob);

// Parse WebP
const webpBytes = svg.parseWebpDataUrl("data:image/webp;base64,UklGR...");
// Uint8Array | null
```

**Gotchas:**
- Avatar color palette has 10 colors. Same `id` always yields same color.
- `parseWebpDataUrl` only accepts `image/webp` MIME type. Other formats return `null`.
- The generated SVG uses JetBrains Mono font.

---

## searchParams

URL search parameter serialization, deserialization, and change listening.

### API

```ts
searchParams.deserialize<T>(params?: URLSearchParams): Partial<T>
// "true"/"false" => boolean, numeric strings => number (only if round-trip safe),
// complex values => JSON.parse, fallback => raw string.
// Without params arg, reads from globalThis.location.search.

searchParams.serialize<T>(newParams: Partial<T>, params?: URLSearchParams): string
// Returns URL search string (no leading "?").
// Removes params that are undefined, null, false, or "".
// Primitives stringified directly, objects/arrays JSON-encoded.

searchParams.onChange<T>(callback: (params: Partial<T>) => void): () => void
// Listens for popstate events. Returns cleanup function.
// No-op in non-browser environments.
```

### Examples

```ts
import { searchParams } from "@k2b/stdlib";

// Deserialize (browser: reads from URL)
// URL: ?page=2&active=true&name=John
const params = searchParams.deserialize<{ page: number; active: boolean; name: string }>();
// { page: 2, active: true, name: "John" }

// Deserialize from explicit params
const p = searchParams.deserialize(new URLSearchParams("page=2&tags=[\"a\",\"b\"]"));
// { page: 2, tags: ["a", "b"] }

// Serialize
searchParams.serialize({ page: 2, active: true, q: "" });
// "page=2&active=true" (q removed because empty string)

// Listen for changes
const cleanup = searchParams.onChange<{ page: number }>((params) => {
  console.log("Page:", params.page);
});
// cleanup() to stop listening
```

**Gotchas:**
- Zero-padded strings like `"007"` are kept as strings (round-trip check: `String(Number("007"))` is `"7"`, not `"007"`).
- `"null"` is kept as the literal string `"null"`, not coerced.
- `false`, `null`, `undefined`, and `""` all cause the param to be deleted during serialization.
- `onChange` only fires on `popstate` (back/forward navigation), not on `pushState`/`replaceState`.

---

## fileIcons

File type categorization and Tabler Icons CSS class lookup.

### Types

```ts
type FileInfoLike = { name: string; type: "file" | "directory"; mimeType?: string };
type FileCategory = "image" | "pdf" | "video" | "audio" | "text" | "code" | "document" | "archive" | "other";
```

### API

```ts
fileIcons.getFileCategory(item: FileInfoLike): FileCategory
// Checks MIME type first, then file extension. Falls back to "other".

fileIcons.getFileIcon(item: FileInfoLike): string
// Returns Tabler Icons class + Tailwind color, e.g. "ti-brand-typescript text-blue-500".
// Priority: folder name > exact filename > extension > MIME prefix > default.
```

### Examples

```ts
import { fileIcons } from "@k2b/stdlib";

fileIcons.getFileCategory({ name: "photo.png", type: "file" });           // "image"
fileIcons.getFileCategory({ name: "app.ts", type: "file" });              // "code"
fileIcons.getFileCategory({ name: "data.csv", type: "file" });            // "document"

fileIcons.getFileIcon({ name: "index.ts", type: "file" });                // "ti-brand-typescript text-blue-500"
fileIcons.getFileIcon({ name: "photo.jpg", type: "file" });               // "ti-photo text-emerald-500"
fileIcons.getFileIcon({ name: "package.json", type: "file" });            // "ti-brand-npm text-red-500"
fileIcons.getFileIcon({ name: "documents", type: "directory" });           // "ti-briefcase text-blue-500"
fileIcons.getFileIcon({ name: "src", type: "directory" });                 // "ti-folder text-amber-500"
fileIcons.getFileIcon({ name: "unknown.xyz", type: "file" });             // "ti-file text-zinc-400"
```

**Gotchas:**
- Icons are Tabler Icons class names (`ti-*`) with Tailwind CSS color utilities.
- Supports special filenames: `dockerfile`, `package.json`, `tsconfig.json`, `.env`, etc.
- Supports GNOME standard folders: `documents`, `pictures`, `music`, `downloads`, etc. (including German: `dokumente`, `bilder`).

---

## gradients

CSS gradient presets for UI name styling.

### Types

```ts
type GradientPreset = {
  id: string;
  label: string;
  style: string;    // CSS inline style for background-clip text gradient
  preview: string;  // CSS background-image for swatch preview
};
```

### API

```ts
gradients.presets: GradientPreset[]              // alias for gradientPresets
gradients.gradientPresets: GradientPreset[]      // all presets
gradients.defaultGradient: GradientPreset        // "Berry" (purple-pink)
gradients.getById(id: string): GradientPreset    // alias for getGradientById
gradients.getGradientById(id: string): GradientPreset  // returns default if not found
```

Available presets: `"default"` (Berry), `"mono"`, `"ocean"`, `"sunset"`, `"forest"`, `"pride"`, `"gold"`.

### Examples

```ts
import { gradients } from "@k2b/stdlib";

const preset = gradients.getById("ocean");
// Apply as inline style:
// <span style={preset.style}>User Name</span>

gradients.presets.map(p => p.label); // ["Berry","Mono","Ocean","Sunset","Forest","Pride","Gold"]
```

**Gotchas:**
- `"mono"` preset has an empty `style` string (plain text, no gradient).
- `getById` returns the default ("Berry") when the ID is not found, never null/undefined.
