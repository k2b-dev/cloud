import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

type Kind = "city" | "asn";
type Snapshot = { month: string; city: string; asn: string };

export const rewriteGeoIpPin = (dockerfile: string, pin: Snapshot): string => {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(pin.month) || ![pin.city, pin.asn].every((hash) => /^[a-f0-9]{64}$/.test(hash)))
    throw new Error("Invalid GeoIP snapshot month or SHA-256");
  let result = dockerfile;
  for (const kind of ["city", "asn"] as const) {
    const url = new RegExp(`https://download\\.db-ip\\.com/free/dbip-${kind}-lite-\\d{4}-\\d{2}\\.mmdb\\.gz`, "g");
    const checksum = new RegExp(`[a-f0-9]{64}(  /geoip/dbip-${kind}-lite\\.mmdb\\.gz)`, "g");
    if ([...result.matchAll(url)].length !== 1 || [...result.matchAll(checksum)].length !== 1)
      throw new Error(`Expected one ${kind} URL and checksum in Dockerfile`);
    result = result
      .replace(url, `https://download.db-ip.com/free/dbip-${kind}-lite-${pin.month}.mmdb.gz`)
      .replace(checksum, `${pin[kind]}$1`);
  }
  return result;
};

const download = async (kind: Kind, month: string, dir: string) => {
  const url = `https://download.db-ip.com/free/dbip-${kind}-lite-${month}.mmdb.gz`;
  const response = await fetch(url);
  if (!response.ok || !response.body)
    throw new Error(`${kind} snapshot download failed: HTTP ${response.status} (${url}). DB-IP keeps only the current and previous month.`);
  const hash = new Bun.CryptoHasher("sha256");
  let compressed = 0;
  let uncompressed = 0;
  // Stream to disk and through gunzip; never hold the 127 MB city database in memory.
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      compressed += chunk.length;
      hash.update(chunk);
      done(null, chunk);
    },
  });
  const unpacked = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      uncompressed += chunk.length;
      done(null, chunk);
    },
  });
  const compressedPath = join(dir, `${kind}.mmdb.gz`);
  await pipeline(Readable.from(response.body), meter, createWriteStream(compressedPath));
  await pipeline(createReadStream(compressedPath), createGunzip(), unpacked, createWriteStream(join(dir, `${kind}.mmdb`)));
  return { hash: hash.digest("hex"), compressed, uncompressed };
};

const main = async (args: string[]) => {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(
      "Usage: bun scripts/geoip-snapshot.ts <YYYY-MM>\n\nDownload DB-IP City Lite and ASN Lite, print SHA-256 and byte sizes, and update the Dockerfile pin.\nDB-IP serves only the current and previous month. No runtime download is added.",
    );
    return;
  }
  const month = args[0];
  if (args.length !== 1 || !month || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month))
    throw new Error("Usage: bun scripts/geoip-snapshot.ts <YYYY-MM> (for example 2026-10)");
  const dockerfile = Bun.file(join(import.meta.dir, "..", "Dockerfile"));
  const original = await dockerfile.text();
  const dir = await mkdtemp(join(tmpdir(), "cloud-geoip-snapshot-"));
  try {
    const city = await download("city", month, dir);
    const asn = await download("asn", month, dir);
    const updated = rewriteGeoIpPin(original, { month, city: city.hash, asn: asn.hash });
    if ((await dockerfile.text()) !== original) throw new Error("Dockerfile changed during download; rerun to preserve the other edit");
    await Bun.write(dockerfile, updated);
    for (const [kind, data] of [
      ["city", city],
      ["asn", asn],
    ] as const)
      console.log(`${kind}: sha256 ${data.hash}; gzip ${data.compressed} bytes; mmdb ${data.uncompressed} bytes`);
    console.log(
      `Dockerfile pinned to ${month}. Update the snapshot month, build date and sizes in docs-site/docs/en/operations/sign-in-locations.md.\nKeep attribution: IP Geolocation by DB-IP (https://db-ip.com), CC BY 4.0; see THIRD_PARTY_NOTICES.md.`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

if (import.meta.main) {
  try {
    await main(Bun.argv.slice(2));
  } catch (error) {
    console.error(`GeoIP snapshot: ${error instanceof Error ? error.message : "download failed"}`);
    process.exitCode = 1;
  }
}
