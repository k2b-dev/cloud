/**
 * Fetches DATEV's XSD and sample archives from the pinned URLs into the git-ignored
 * `.cache/datev-xml/`, verifies their SHA-256 and extracts what the tests need:
 * `xsd/` (the four document and ledger schemas) and `samples/` (DATEV sample XML).
 * DATEV's files are not part of this repository. A cached archive is reused only if its
 * hash still matches; CI starts empty, so a vanished URL fails the build.
 * Usage: bun scripts/datev-xml-fixtures.ts
 */
import { inflateRawSync } from "node:zlib";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { datevXmlSchemaSha256, datevXmlSchemaSource } from "../src/finance/datev-xml-schema-files";

const cache = new URL("../.cache/datev-xml/", import.meta.url).pathname;
const samples: { url: string; sha256: string; files: Record<string, Record<string, string>> }[] = [
  { url: "https://developer.datev.de/assets/accounts_Payable_Ledger_Eingangsrechnungen_7_8ce161174e.zip", sha256: "ad195de9ef7be9ce4a53db042533e98d66db0259e482560ee87702302c601c4a",
    files: { "ER_ledger_V6_2023.zip": { "document.xml": "ER_document.xml", "Rechnungsdaten_RE_R2023x204.xml": "ER_Rechnungsdaten_RE_R2023x204.xml" },
      "ERK_ledger_V6_2023.zip": { "Rechnungskorrekturdaten_REK_RK2023x101.xml": "ERK_Rechnungskorrekturdaten_REK_RK2023x101.xml" } } },
  { url: "https://developer.datev.de/assets/accounts_Receivable_Ledger_Ausgangsrechnungen_2_2061bc8391.zip", sha256: "bf6aa0d9af1ba1bafe2419551a4a73dd04e2e3eb8e78d14a784793750aff0b21",
    files: { "AR_ledger_V6_2023.zip": { "Rechnungsdaten_RA_R-2023-204.xml": "AR_Rechnungsdaten_RA_R-2023-204.xml" } } },
  { url: "https://developer.datev.de/assets/cash_Ledger_067be9d707.zip", sha256: "841c3a588dcce6fe7f8d5eb459514842b728f9f9707d9d0099ca63e75875ff1d",
    files: { "Kasse_ledger_V6_2023_einzelDateien.zip": { "document.xml": "Kasse_einzelDateien_document.xml" },
      "Kasse_ledger_V6_2023_GesamtDatei.zip": { "Kasse_12Januar2023.xml": "Kasse_12Januar2023.xml" } } },
];

const sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

/** Minimal reader for these trusted, hash-checked archives: central directory, stored or deflated entries. */
function unzip(zip: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = zip.byteLength - 22;
  while (eocd >= 0 && view.getUint32(eocd, true) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error("Not a ZIP archive.");
  const entries = new Map<string, Uint8Array>();
  let cursor = view.getUint32(eocd + 16, true);
  for (let i = 0; i < view.getUint16(eocd + 10, true); i++) {
    const method = view.getUint16(cursor + 10, true);
    const size = view.getUint32(cursor + 20, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const local = view.getUint32(cursor + 42, true);
    const name = new TextDecoder("latin1").decode(zip.subarray(cursor + 46, cursor + 46 + nameLength));
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const compressed = zip.subarray(start, start + size);
    const raw = method === 0 ? compressed : method === 8 ? new Uint8Array(inflateRawSync(compressed)) : undefined;
    if (!raw) throw new Error(`Unsupported ZIP method ${method} for ${name}.`);
    entries.set(name.split("/").at(-1)!, raw);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function archive(url: string, expected: string): Promise<Uint8Array> {
  const path = join(cache, "archives", `${expected}.zip`);
  const cached = Bun.file(path);
  if (await cached.exists()) {
    const bytes = await cached.bytes();
    if (sha256(bytes) === expected) return bytes;
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Download failed: ${url}: ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (sha256(bytes) !== expected) throw new Error(`Integrity failure: ${url} no longer matches the pinned SHA-256.`);
  await Bun.write(path, bytes);
  return bytes;
}

/** Returns the cache directory with `xsd/` and `samples/` filled and verified. */
export async function ensureDatevXmlFixtures(): Promise<string> {
  await mkdir(join(cache, "xsd"), { recursive: true });
  await mkdir(join(cache, "samples"), { recursive: true });
  const xsd = unzip(await archive(datevXmlSchemaSource.url, datevXmlSchemaSource.archiveSha256));
  for (const [name, hash] of Object.entries(datevXmlSchemaSha256)) {
    const bytes = xsd.get(name);
    if (!bytes || sha256(bytes) !== hash) throw new Error(`Schema ${name} is missing or does not match its pinned SHA-256.`);
    await Bun.write(join(cache, "xsd", name), bytes);
  }
  for (const sample of samples) {
    const outer = unzip(await archive(sample.url, sample.sha256));
    for (const [inner, files] of Object.entries(sample.files)) {
      const entries = unzip(outer.get(inner) ?? new Uint8Array());
      for (const [name, target] of Object.entries(files)) {
        const bytes = entries.get(name);
        if (!bytes) throw new Error(`Sample ${inner}/${name} is missing.`);
        await Bun.write(join(cache, "samples", target), bytes);
      }
    }
  }
  return cache;
}

if (import.meta.main) console.log(await ensureDatevXmlFixtures());
