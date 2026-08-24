# Notebook script utilities

This is the complete `std` utility surface available inside trusted Notebooks script blocks. Scripts do not import the underlying library, and functions not listed here are not exposed. Read [Notebook Script API](notebooks-scripts.md) first for `current`, `nb`, `ui`, state, and prompt APIs.

## Contents

- [`std.text`](#stdtext)
- [`std.dates`](#stddates)
- [`std.fuzzy`](#stdfuzzy)
- [`std.crypto`](#stdcrypto)
- [`std.encoding`](#stdencoding)
- [`std.charts`](#stdcharts)
- [`std.qr`](#stdqr)
- [`std.password`](#stdpassword)
- [`std.timing`](#stdtiming)
- [`std.files`](#stdfiles)
- [`std.images`](#stdimages)
- [`std.clipboard`](#stdclipboard)

## `std.text`

```ts
slugify(content): string
humanize(content): string
titleify(content): string
camelCase(content): string
pascalCase(content): string
snakeCase(content): string
kebabCase(content): string
truncate(content, limit, mode?: "end" | "middle"): string
summarize(content, limit, mode?: "end" | "middle"): string
pprintBytes(bytes, options?: { mode?: "iec" | "si"; locale?: string }): string
pprintBytesParts(bytes, options?: { mode?: "iec" | "si"; locale?: string }): { value: string; unit: string }
```

## `std.dates`

Formatting and calendar functions accept `DateContext` where shown:

```ts
type DateContext = { timeZone?: string; locale?: string; weekStartsOn?: 0 | 1; firstDayOfWeek?: 0 | 1 };
type RelativeDateContext = DateContext & { base?: string | Date };
```

```ts
isValidTimeZone(value): boolean
normalizeTimeZone(value, fallback?): string
zonedDateTimeToInstant(input, timeZone, { disambiguation?: "compatible"|"earlier"|"later"|"reject" }?): string
instantToZonedInput(input, timeZone): string
formatDate(input, context?): string
formatDateTime(input, context?): string
formatDateTimeRelative(input, context?: RelativeDateContext): string
formatDateRelative(input, context?: RelativeDateContext): string
formatTimeSpan(input, context?: RelativeDateContext): string
formatDuration(from, to, context?: DateContext): string
formatMonthYear(date, context?: DateContext): string
formatDayNumber(date, context?): string
formatWeekdayShort(date, context?: DateContext): string
formatWeekdayLong(date, context?: DateContext): string
formatFullDate(date, context?: DateContext): string
formatDateShort(date, context?): string
formatDateKey(input, context?): string
formatTime(input, context?): string
isToday(date, context?): boolean
isSameMonth(date, reference, context?): boolean
isSameDay(a, b, context?): boolean
startOfDay(input, context?): Date
endOfDay(input, context?): Date
startOfMonth(date, context?): Date
startOfWeek(date, context?): Date
today(context?): Date
addDays(date, amount, context?): Date
addWeeks(date, amount, context?): Date
addMonths(date, amount, context?): Date
addZoned(input, { timeZone, years?, months?, weeks?, days?, hours?, minutes?, disambiguation? }): string
addZonedInstant(input, sameOptions): string
getMonthGrid(year, month, context?): Date[][]
getWeekDays(date, context?): Date[]
getDateRange("month" | "week", date, context?): { from: Date; to: Date }
itemOnDate(item, date, context?): boolean
getDayItems(items, date, context?): item[]
weekdays(context?: DateContext): string[]
months(context?: DateContext): string[]
getYearOptions(context?): number[]
buildCalendarUrl(baseUrl, { view?, date?, item? }, context?): string
parseCalendarDate(value, context?): Date
```

Calendar items have `{ startsAt, endsAt, deadline }`, each an ISO string or `null`.

## `std.fuzzy`

```ts
match(query, target, { caseSensitive? }?): FuzzyMatch | null
filter(query, items, { key?, limit?, caseSensitive? }?): FuzzyHit[]
segments(target, ranges): FuzzySegment[]
distance(a, b): number
closest(query, choices, { maxDistance?, caseSensitive? }?): ClosestMatch | null
```

Use `filter` for ranked object lists, `match` when ranges or score matter, and `closest` for typo suggestions.

## `std.crypto`

```ts
await std.crypto.common.hash(stringOrBytes): Promise<string>       // SHA-256 hex
std.crypto.common.fnv1aHash(string): string                        // non-cryptographic
std.crypto.common.readableId(...pattern): string
std.crypto.common.uuid(): string
std.crypto.common.ulid({ timestamp?, monotonic? }?): string
std.crypto.common.generateKey(length?): string

await std.crypto.asymmetric.generate(): Promise<{ privateKey; publicKey }>
await std.crypto.asymmetric.sign({ privateKey, message }): Promise<{ nonce; timestamp; signature; v }>
await std.crypto.asymmetric.verify({ publicKey, signature, nonce, timestamp, message, maxAge?, v?, strict? }): Promise<boolean>
await std.crypto.asymmetric.encrypt({ payload, publicKey }): Promise<string>
await std.crypto.asymmetric.decrypt({ payload, privateKey }): Promise<string>

await std.crypto.symmetric.encrypt({ payload, key, stretched? }): Promise<string>
await std.crypto.symmetric.decrypt({ payload, key }): Promise<string>

await std.crypto.totp.create({ label, issuer }): Promise<{ uri; secret }>
await std.crypto.totp.verify({ token, secret, window? }): Promise<boolean>
```

Do not treat hashes, readable ids, UUIDs, or ULIDs as secrets. `monotonic` ULIDs are ordered but partly predictable.

## `std.encoding`

```ts
toBase64(bytes): string
fromBase64(base64): Uint8Array
fromBase64Strict(base64): Uint8Array
toHex(bytes): string
fromHex(hex): Uint8Array
toBase32(bytes): string
fromBase32(base32): Uint8Array
toBase62(number, minLength?): string
fromBase62(string): number
```

## `std.charts`

Every function returns an SVG string. Prefer `ui.chart(kind, options)` for mounted responsive output; use `ui.html(std.charts.line(...))` only when direct SVG generation is needed.

Shared types:

```ts
type Point = { x: number; y: number; size?; errY?; errYHigh?; errYLow?; errX?; errXHigh?; errXLow? };
type Series = { label?: string; data: Point[]; marker?: "circle"|"square"|"triangle"|"diamond"|"plus"|"cross"; lineStyle?: "solid"|"dashed"|"dotted"|"dashdot" };
type ChartOptions = { width?; height?; padding?; className?; title?; subtitle? };
type Axis = { ticks?; format?; label?; scale?: "linear"|"log"; minorTicks? };
type Reference = { value: number; axis?: "x"|"y"; label?: string };
```

```ts
scatter({ series, xAxis?, yAxis?, references?, legend?, sizeRange?, autoVariant?, trendline?, ...chart }): string
line({ series, xAxis?, yAxis?, references?, legend?, smooth?, area?, step?, autoVariant?, errorBand?, ...chart }): string
bar({ data: [{ label, value }], yAxis?, colorByBar?, references?, showValues?, legend?, ...chart }): string
pie({ data: [{ label, value }], showLabels?, legend?, innerRadius?, ...chart }): string
donut(sameOptionsAsPie): string
sparkline({ data, width?, height?, smooth?, showLast?, showMinMax?, area?, className? }): string
histogram({ data: number[], bins?, xAxis?, yAxis?, references?, ...chart }): string
boxplot({ groups: [{ label, values }], yAxis?, showOutliers?, references?, colorByBox?, ...chart }): string
gauge({ value, min?, max?, label?, unit?, format?, thresholds?, showNeedle?, ...chart }): string
barGauge({ data: [{ label, value, min?, max?, unit? }], min?, max?, unit?, format?, thresholds?, ...chart }): string
stat({ label, value, unit?, delta?, deltaFormat?, trend?: "up"|"down"|"neutral", sparkline?, format?, ...chart }): string
heatmap({ data: [{ x, y, value }], xLabels?, yLabels?, min?, max?, format?, showValues?, ...chart }): string
stateTimeline({ rows: [{ label, intervals: [{ from, to, state, label? }] }], states?: [{ state, label?, color? }], xAxis?, legend?, ...chart }): string
```

Thresholds are `{ value, label?, color? }`; `value` is the inclusive upper bound.

## `std.qr`

```ts
wifi({ ssid, password?, encryption?: "WPA"|"WEP"|"nopass", hidden? }): string
email({ to, subject?, body? }): string
tel({ number }): string
vcard({ firstName, lastName?, organization?, title?, phone?, email?, website?, street?, city?, zip?, country? }): string
event({ title, location?, start?, end?, description? }): string
toSvg(data, { on?, off?, correctionLevel?: "L"|"M"|"Q"|"H" }?): string
```

Payload functions return QR payload text; `toSvg` renders it.

## `std.password`

```ts
random({ length?, uppercase?, numbers?, symbols? }?): string
memorable({ words?, capitalize?, fullWords?, separator?, addNumber?, addSymbol? }?): string
pin({ length? }?): string
strength(password): { entropy; score: 0|1|2|3|4; label; crackTime; feedback }
```

## `std.timing`

```ts
await withMinLoadTime(asyncFunction, minimumMs?): Promise<T>
buffer(asyncHandler, intervalMs?): (key, data) => void
jitter(value, range): number
await sleep(ms): Promise<void>
random(min?, max?, step?): number
shuffle(array): array
debounce(fn, delayMs): { call; cancel; flush; isPending }
throttle(fn, intervalMs): { call; cancel }
```

## `std.files`

These functions require browser capabilities.

```ts
downloadFileFromContent(content, filename, mimeType?): void
await createZip(files, { compressionLevel?, onProgress? }?): Promise<Uint8Array>
await extractZip(bytes, { onProgress?, maxEntries?, maxBytes? }?): Promise<Array<{ filename; data }>>
await downloadAsZip(files, zipFilename?, options?): Promise<void>
createDownloadLink(content, filename, mimeType?, linkText?, className?): HTMLAnchorElement
await showFileDialog({ accept?, multiple? }): Promise<File | File[]>
await showFolderDialog(accept?): Promise<File[]>
path`directory/${name}.txt`: string
mimeTypesToAccept(mimeTypes): string
checkMimeType(fileOrType, accept): boolean
await compress(bytes): Promise<Uint8Array>
await decompress(bytes): Promise<Uint8Array>
getMimeType(filenameOrExtension): string | null
getExtension(mimeType): string | null
```

ZIP entries are `{ filename, source, mimeType? }`, where `source` is a string, `Blob`, `ArrayBuffer`, or `Uint8Array`. Progress is `{ current, total, percent }`.

Origin Private File System helpers:

```ts
await std.files.OPFS.getDirHandle(pathSegments, create?): Promise<FileSystemDirectoryHandle>
await std.files.OPFS.write(name, bytes): Promise<void>
await std.files.OPFS.read(name): Promise<Uint8Array | undefined>
await std.files.OPFS.delete(name): Promise<void>
await std.files.OPFS.ls(directoryPath?): Promise<string[]>
```

## `std.images`

Image transforms are chainable and require browser canvas APIs.

```ts
const image = std.images.create(source);
const output = await std.images.toBlob("webp", 0.85)(
  std.images.resize(1200, 800, "contain")(image),
);
```

Complete surface:

```ts
create(source): Promise<ImgData>
batch(sources, transform, { onProgress? }?): Promise<results[]>
resize(width?, height?, fit?: "cover"|"contain"|"fill", letterboxColor?): transform
crop(x, y, width, height): transform
filter(cssFilter): transform
rotate(90 | 180 | 270): transform
flip(horizontal?, vertical?): transform
apply((context, canvas) => void): transform
toBlob(format?: "jpeg"|"webp"|"png", quality?): outputTransform
toBase64(format?, quality?): outputTransform
toFile(name, format?, quality?): outputTransform
toCanvas(image): Promise<HTMLCanvasElement>
```

`std.images.filters` contains `vintage`, `grayscale`, `dramatic`, `soft`, plus builders `blur(px)`, `brightness(value)`, `contrast(value)`, `saturate(value)`, and `hue(degrees)`. `std.images.presets` contains `avatar(source, size?, quality?, format?)` and `thumbnail(source, maxSize?, letterboxColor?, format?)`.

## `std.clipboard`

```ts
await std.clipboard.copy(text): Promise<void>
```

No clipboard read API is exposed to notebook scripts.
