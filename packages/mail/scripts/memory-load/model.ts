import { Readable } from "node:stream";

// Derived from the measured guard workload (#1549); the owner confirms the final threshold.
export const GUARD_PEAK_ABOVE_BASELINE_MIB = 400;

export const MiB = 1024 * 1024;
export const loads = ["hydration", "extraction", "api", "folders"] as const;
export type Load = (typeof loads)[number];
export const help = `Measure Mail memory under hydration load (simulated IMAP, in-process API).
Usage: bun --no-env-file packages/mail/scripts/memory-load.ts [options]
Requires CLOUD_TEST_DATABASE_URL (name ending _test), CLOUD_TEST_NATS_SERVERS,
CLOUD_TEST_VALKEY_URL; honors CLOUD_TEST_NATS_CREDS_FILE.
  --profile incident|guard   Default incident; guard targets <90 s, not a guarantee
  --seed N                   Default 1549
  --mailboxes N              Default 4 (one per hydration worker)
  --folders N                Small folders per mailbox: incident 40, guard 2
  --small-per-mailbox N      INBOX small messages: incident 20, guard 2
  --small-per-folder N       Default 2
  --large-per-mailbox N      Default incident 3, guard 1
  --large-min-mib N          Default 10
  --large-max-mib N          Default incident 40, guard 24
  --small-min-kib N          Default 2
  --small-max-kib N          Default 50
  --html-mib N               Decoded HTML bytes; default seeded 1–6 MiB
  --csv-mib N                Decoded CSV bytes; default seeded 4–18 MiB
  --readers N                Concurrent API loops, default 4
  --only hydration,extraction,api,folders  Default all; omitted hydration is prepared before baseline
  --timeout-s N              Measurement deadline, default 900 (also bounds preparation)
  --heap-snapshot-mib N      Snapshot once RSS rises N MiB above baseline
  --out DIR                 Fresh directory; default .local/mail-memory/<UTC timestamp>
  --json                    Print summary JSON as last stdout line
  --help                    No infrastructure imports or connections
Large sizes include MIME/base64 overhead. Incompatible component/size overrides fail.
Snapshots perturb memory and timing. No browser, HTTP socket, or real IMAP latency.
`;
export type Options = {
  help: boolean;
  json: boolean;
  profile: "incident" | "guard";
  seed: number;
  mailboxes: number;
  folders: number;
  smallPerMailbox: number;
  smallPerFolder: number;
  largePerMailbox: number;
  largeMinMib: number;
  largeMaxMib: number;
  smallMinKib: number;
  smallMaxKib: number;
  htmlMib?: number;
  csvMib?: number;
  readers: number;
  only: Load[];
  timeoutS: number;
  heapSnapshotMib?: number;
  out?: string;
};
export function parseArgs(args: string[]): Options {
  if (args.includes("--help")) return { ...parseArgs([]), help: true };
  const values = new Map<string, string>();
  let json = false;
  const numeric = new Map<string, keyof Options>([
    ["seed", "seed"],
    ["mailboxes", "mailboxes"],
    ["folders", "folders"],
    ["small-per-mailbox", "smallPerMailbox"],
    ["small-per-folder", "smallPerFolder"],
    ["large-per-mailbox", "largePerMailbox"],
    ["large-min-mib", "largeMinMib"],
    ["large-max-mib", "largeMaxMib"],
    ["small-min-kib", "smallMinKib"],
    ["small-max-kib", "smallMaxKib"],
    ["html-mib", "htmlMib"],
    ["csv-mib", "csvMib"],
    ["readers", "readers"],
    ["timeout-s", "timeoutS"],
    ["heap-snapshot-mib", "heapSnapshotMib"],
  ]);
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--json") {
      json = true;
      continue;
    }
    const name = flag?.slice(2) ?? "";
    if (!flag?.startsWith("--") || (!numeric.has(name) && !["profile", "out", "only"].includes(name)))
      throw new Error(`Unknown option ${flag}; see --help`);
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
    if (values.has(name)) throw new Error(`Duplicate ${flag}`);
    values.set(name, value);
  }
  const profile = values.get("profile") ?? "incident";
  if (profile !== "incident" && profile !== "guard") throw new Error("--profile must be incident or guard");
  const o: Options = {
    help: false,
    json,
    profile,
    seed: 1549,
    mailboxes: 4,
    folders: profile === "incident" ? 40 : 2,
    smallPerMailbox: profile === "incident" ? 20 : 2,
    smallPerFolder: 2,
    largePerMailbox: profile === "incident" ? 3 : 1,
    largeMinMib: 10,
    largeMaxMib: profile === "incident" ? 40 : 24,
    smallMinKib: 2,
    smallMaxKib: 50,
    readers: 4,
    only: [...loads],
    timeoutS: 900,
  };
  for (const [name, key] of numeric) {
    const raw = values.get(name);
    if (raw === undefined) continue;
    const n = Number(raw);
    const fractional = ["htmlMib", "csvMib", "largeMinMib", "largeMaxMib", "smallMinKib", "smallMaxKib", "heapSnapshotMib"].includes(key);
    const zero = ["seed", "folders", "smallPerMailbox", "smallPerFolder", "largePerMailbox"].includes(key);
    if (!Number.isFinite(n) || n < (zero ? 0 : Number.MIN_VALUE) || (!fractional && !Number.isSafeInteger(n)))
      throw new Error(`Invalid --${name}: ${raw}`);
    Object.assign(o, { [key]: n });
  }
  // JavaScript timers overflow above 2^31-1 ms; byte counts must stay exactly representable.
  if (o.timeoutS * 1000 > 2 ** 31 - 1) throw new Error("--timeout-s exceeds the JavaScript timer range");
  for (const value of [o.largeMaxMib, o.htmlMib ?? 0, o.csvMib ?? 0, o.heapSnapshotMib ?? 0])
    if (!Number.isSafeInteger(Math.floor(value * MiB))) throw new Error("MiB option exceeds the safe byte-count range");
  if (!Number.isSafeInteger(Math.floor(o.smallMaxKib * 1024))) throw new Error("KiB option exceeds the safe byte-count range");
  if (o.largeMinMib > o.largeMaxMib || o.smallMinKib > o.smallMaxKib) throw new Error("Minimum size exceeds maximum size");
  if (values.has("only")) {
    o.only = [];
    for (const part of values.get("only")!.split(",")) {
      const load = loads.find((l) => l === part);
      if (!load || o.only.includes(load)) throw new Error("--only expects unique hydration,extraction,api,folders names");
      o.only.push(load);
    }
  }
  o.out = values.get("out");
  return o;
}

export function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}
export type Part = { kind: "text" | "html" | "csv" | "image" | "binary"; bytes: number; filename?: string; cid?: string; seed: number };
export type Fixture = {
  id: string;
  mailbox: number;
  folder: string;
  uid: number;
  large: boolean;
  size: number;
  htmlBytes: number;
  attachmentBytes: number;
  parts: Part[];
};
const encodedSize = (n: number) => 4 * Math.ceil(n / 3) + 2 * Math.ceil(n / 57);
const boundary = (f: Fixture, kind: string) => `memory-${f.id}-${kind}`;
function headers(f: Fixture): string {
  return `Message-ID: <${f.id}@memory.test>\r\nFrom: sender@example.test\r\nTo: mailbox-${f.mailbox}@example.test\r\nSubject: Memory newsletter ${f.id}\r\nDate: Thu, 01 Oct 2026 00:00:00 +0000\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="${boundary(f, "mixed")}"\r\n\r\n`;
}
function partHeader(p: Part): string {
  const type = {
    text: "text/plain; charset=utf-8",
    html: "text/html; charset=utf-8",
    csv: "text/csv",
    image: "image/png",
    binary: "application/octet-stream",
  }[p.kind];
  return `Content-Type: ${type}\r\nContent-Transfer-Encoding: base64\r\n${p.filename ? `Content-Disposition: ${p.cid ? "inline" : "attachment"}; filename="${p.filename}"\r\n` : ""}${p.cid ? `Content-ID: <${p.cid}>\r\n` : ""}\r\n`;
}
// The same skeleton drives sizing and streaming; only part bodies are generated lazily.
function* structure(f: Fixture): Generator<string | Part> {
  yield headers(f);
  yield `--${boundary(f, "mixed")}\r\nContent-Type: multipart/related; boundary="${boundary(f, "related")}"\r\n\r\n`;
  yield `--${boundary(f, "related")}\r\nContent-Type: multipart/alternative; boundary="${boundary(f, "alt")}"\r\n\r\n`;
  for (const p of f.parts.filter((p) => p.kind === "text" || p.kind === "html")) {
    yield `--${boundary(f, "alt")}\r\n${partHeader(p)}`;
    yield p;
  }
  yield `--${boundary(f, "alt")}--\r\n`;
  for (const p of f.parts.filter((p) => p.kind === "image")) {
    yield `--${boundary(f, "related")}\r\n${partHeader(p)}`;
    yield p;
  }
  yield `--${boundary(f, "related")}--\r\n`;
  for (const p of f.parts.filter((p) => p.kind === "csv" || p.kind === "binary")) {
    yield `--${boundary(f, "mixed")}\r\n${partHeader(p)}`;
    yield p;
  }
  yield `--${boundary(f, "mixed")}--\r\n`;
}
const partTypes = {
  text: "text/plain",
  html: "text/html",
  csv: "text/csv",
  image: "image/png",
  binary: "application/octet-stream",
} as const;
/** The BODYSTRUCTURE JSON the IMAP connector stores for this fixture (sizes are encoded bytes). */
export const mimeStructure = (f: Fixture): Record<string, unknown> => {
  const leaf = (p: Part, part: string) => ({
    part,
    type: partTypes[p.kind],
    parameters: p.kind === "text" || p.kind === "html" ? { charset: "utf-8" } : {},
    id: p.cid ? `<${p.cid}>` : null,
    encoding: "base64",
    size: encodedSize(p.bytes),
    disposition: p.filename ? (p.cid ? "inline" : "attachment") : null,
    dispositionParameters: p.filename ? { filename: p.filename } : {},
    childNodes: [],
  });
  const multipart = (type: string, part: string | null, childNodes: Record<string, unknown>[]) => ({
    part,
    type,
    parameters: {},
    id: null,
    encoding: null,
    size: null,
    disposition: null,
    dispositionParameters: {},
    childNodes,
  });
  const alternative = f.parts.filter((p) => p.kind === "text" || p.kind === "html").map((p, i) => leaf(p, `1.1.${i + 1}`));
  const images = f.parts.filter((p) => p.kind === "image").map((p, i) => leaf(p, `1.${i + 2}`));
  const attachments = f.parts.filter((p) => p.kind === "csv" || p.kind === "binary").map((p, i) => leaf(p, `${i + 2}`));
  return multipart("multipart/mixed", null, [
    multipart("multipart/related", "1", [multipart("multipart/alternative", "1.1", alternative), ...images]),
    ...attachments,
  ]);
};
export const sourceSize = (f: Fixture): number =>
  [...structure(f)].reduce((n, p) => n + (typeof p === "string" ? Buffer.byteLength(p) : encodedSize(p.bytes)), 0);
function makeFixture(o: Options, rand: () => number, mailbox: number, folder: string, uid: number, large: boolean): Fixture {
  const id = `s${o.seed}-m${mailbox}-${folder}-${uid}`;
  const f: Fixture = { id, mailbox, folder, uid, large, size: 0, htmlBytes: 0, attachmentBytes: 0, parts: [] };
  const add = (kind: Part["kind"], bytes: number, filename?: string, cid?: string) =>
    f.parts.push({ kind, bytes: Math.floor(bytes), filename, cid, seed: Math.floor(rand() * 2 ** 32) });
  const range = (low: number, high: number) => low + rand() * (high - low);
  const target = Math.floor(
    large
      ? (o.profile === "incident" && uid === 1 && o.largeMinMib <= 34 && o.largeMaxMib >= 34 ? 34 : range(o.largeMinMib, o.largeMaxMib)) *
          MiB
      : range(o.smallMinKib, o.smallMaxKib) * 1024,
  );
  add("text", large ? 1024 : 64);
  const imageCount = large ? 2 + Math.floor(rand() * 3) : 0;
  const budget = target * 0.73 - 8192;
  // Reserve minima first, then distribute the remaining decoded budget within the profile.
  const html = large
    ? (o.htmlMib === undefined ? range(1, Math.min(6, Math.max(1, budget / MiB - (o.csvMib ?? 4) - imageCount * 0.5 - 0.1))) : o.htmlMib) *
      MiB
    : 128;
  const csv = large
    ? (o.csvMib === undefined ? range(4, Math.min(18, Math.max(4, (budget - html) / MiB - imageCount * 0.5 - 0.1))) : o.csvMib) * MiB
    : 128;
  add("html", html);
  let remaining = budget - html - csv;
  for (let i = 0; i < imageCount; i++) {
    const bytes = Math.floor(range(0.5, Math.min(2, Math.max(0.5, remaining / MiB - (imageCount - i - 1) * 0.5 - 0.1))) * MiB);
    add("image", bytes, `image-${i}.png`, `image-${i}`);
    remaining -= bytes;
  }
  add("csv", Math.floor(csv / 128) * 128, `${id}.csv`);
  add("binary", 0, `${id}.bin`);
  const binary = f.parts.at(-1)!;
  if (sourceSize(f) > target)
    throw new Error(`Components exceed source size for ${id}; increase --large-min-mib/--large-max-mib or reduce --html-mib/--csv-mib`);
  let low = 0,
    high = target;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    binary.bytes = mid;
    if (sourceSize(f) <= target) low = mid;
    else high = mid - 1;
  }
  binary.bytes = low;
  f.size = sourceSize(f);
  f.htmlBytes = Math.floor(html);
  f.attachmentBytes = f.parts.filter((p) => p.filename).reduce((n, p) => n + p.bytes, 0);
  return f;
}
export function fixtures(o: Options): Fixture[] {
  const rand = random(o.seed),
    result: Fixture[] = [];
  for (let m = 0; m < o.mailboxes; m++) {
    for (let uid = 1; uid <= o.largePerMailbox + o.smallPerMailbox; uid++)
      result.push(makeFixture(o, rand, m, "INBOX", uid, uid <= o.largePerMailbox));
    for (let folder = 0; folder < o.folders; folder++)
      for (let uid = 1; uid <= o.smallPerFolder; uid++) result.push(makeFixture(o, rand, m, `Folder-${folder}`, uid, false));
  }
  return result;
}
function* encoded(p: Part): Generator<Buffer> {
  const rand = random(p.seed);
  const csvRow = `item,description,price\n${p.seed},Newsletter subscription`;
  const csvPattern = `${csvRow}${" ".repeat(128 - csvRow.length - 7)},12.50\n`;
  const pattern = Buffer.from(
    p.kind === "html"
      ? `<div style="padding:12px;color:#234;background:#fff"><a href="https://example.test/${p.seed}">Newsletter ${p.seed}</a><img src="cid:image-0"><img src="cid:image-1"><img src="data:image/png;base64,aGVsbG8="><p>Latest news and offers.</p></div>\n`
      : p.kind === "csv"
        ? csvPattern
        : p.kind === "text"
          ? `Newsletter ${p.seed}. Read the latest updates.\n`
          : "",
  );
  // 57 decoded bytes form exactly one 76-column base64 line; intermediate chunks preserve alignment.
  for (let offset = 0; offset < p.bytes; offset += 57 * 800) {
    const raw = Buffer.allocUnsafe(Math.min(57 * 800, p.bytes - offset));
    for (let i = 0; i < raw.length; i++) raw[i] = pattern.length ? pattern[(offset + i) % pattern.length]! : Math.floor(rand() * 256);
    const base64 = raw.toString("base64");
    const lines: string[] = [];
    for (let i = 0; i < base64.length; i += 76) lines.push(`${base64.slice(i, i + 76)}\r\n`);
    yield Buffer.from(lines.join(""));
  }
}
export function* sourceChunks(f: Fixture, signal?: AbortSignal): Generator<Buffer> {
  let chunk = Buffer.allocUnsafe(64 * 1024),
    used = 0;
  for (const part of structure(f)) {
    const buffers = typeof part === "string" ? [Buffer.from(part)] : encoded(part);
    for (const bytes of buffers) {
      for (let offset = 0; offset < bytes.length; ) {
        signal?.throwIfAborted();
        const count = Math.min(chunk.length - used, bytes.length - offset);
        bytes.copy(chunk, used, offset, offset + count);
        used += count;
        offset += count;
        if (used === chunk.length) {
          yield chunk;
          chunk = Buffer.allocUnsafe(64 * 1024);
          used = 0;
        }
      }
    }
  }
  if (used) yield chunk.subarray(0, used);
}
export const sourceStream = (f: Fixture, signal?: AbortSignal): Readable =>
  Readable.from(sourceChunks(f, signal), { objectMode: false, highWaterMark: 64 * 1024, signal });
