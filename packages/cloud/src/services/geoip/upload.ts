import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import { Reader } from "mmdb-lib";
import { GEOIP_MAX_DATABASE_BYTES, GEOIP_MAX_REQUEST_BYTES, type GeoIpErrorCode, type GeoIpKind } from "../../contracts/geoip";
import { openGeoIpDatabase, truncateUtf8 } from "../../server/request-context/geoip";

const probeAddresses = [
  ...Array.from({ length: 512 }, (_, i) => [`${i >> 1}.${(i % 2) * 128}.0.0`, `${(0x2000 + i * 16).toString(16)}::`]).flat(),
  "1.1.1.1",
  "8.8.8.8",
  "9.9.9.9",
  "2001:4860:4860::8888",
  "2606:4700:4700::1111",
  "2a01:4f8::1",
];

const errors = {
  geoip_too_large: { status: 413, message: "The GeoIP database or request exceeds the upload limit." },
  geoip_empty: { status: 400, message: "The GeoIP upload is empty." },
  geoip_invalid: { status: 422, message: "Upload a valid IPv6 MMDB database with a build date." },
  geoip_unsupported_type: { status: 422, message: "Upload a City or ASN MMDB database." },
  geoip_upload_busy: { status: 409, message: "Another GeoIP upload is being processed. Try again shortly." },
} as const;
export class GeoIpError extends Error {
  readonly status;
  constructor(public readonly code: GeoIpErrorCode) {
    super(errors[code].message);
    this.status = errors[code].status;
  }
}

/** Backpressure reaches the request; both limits are enforced before retaining a chunk. */
export const readGeoIpUpload = async (body: ReadableStream<Uint8Array>, contentLength?: number): Promise<Buffer> => {
  if (contentLength !== undefined && contentLength > GEOIP_MAX_REQUEST_BYTES) throw new GeoIpError("geoip_too_large");
  const reader = body.getReader();
  let requestBytes = 0;
  async function* counted() {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return;
      requestBytes += chunk.value.byteLength;
      if (requestBytes > GEOIP_MAX_REQUEST_BYTES) throw new GeoIpError("geoip_too_large");
      if (chunk.value.byteLength) yield chunk.value;
    }
  }
  let source: Readable | undefined;
  let gunzip: ReturnType<typeof createGunzip> | undefined;
  try {
    const chunks = counted();
    const prefix: Uint8Array[] = [];
    let prefixBytes = 0;
    while (prefixBytes < 2) {
      const next = await chunks.next();
      if (next.done) break;
      prefix.push(next.value);
      prefixBytes += next.value.byteLength;
    }
    if (!prefixBytes) throw new GeoIpError("geoip_empty");
    const first = prefix[0]!;
    const gzip = first[0] === 0x1f && (first.byteLength > 1 ? first[1] : prefix[1]?.[0]) === 0x8b;
    source = Readable.from(
      (async function* () {
        yield* prefix;
        yield* chunks;
      })(),
    );
    let output = source;
    if (gzip) {
      gunzip = createGunzip();
      source.on("error", (error) => gunzip?.destroy(error));
      output = source.pipe(gunzip);
    }
    // A resizable backing store avoids retaining all chunks plus a second full-size concatenation.
    const storage = new ArrayBuffer(0, { maxByteLength: GEOIP_MAX_DATABASE_BYTES });
    let size = 0;
    for await (const chunk of output) {
      if (!(chunk instanceof Uint8Array)) throw new GeoIpError("geoip_invalid");
      if (size + chunk.byteLength > GEOIP_MAX_DATABASE_BYTES) throw new GeoIpError("geoip_too_large");
      const needed = size + chunk.byteLength;
      if (needed > storage.byteLength)
        storage.resize(Math.min(GEOIP_MAX_DATABASE_BYTES, Math.ceil(needed / (8 * 1024 * 1024)) * 8 * 1024 * 1024));
      new Uint8Array(storage).set(chunk, size);
      size = needed;
    }
    if (!size) throw new GeoIpError("geoip_empty");
    storage.resize(size);
    return Buffer.from(storage);
  } catch (error) {
    if (error instanceof GeoIpError) throw error;
    throw new GeoIpError("geoip_invalid");
  } finally {
    source?.destroy();
    gunzip?.destroy();
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
};

export const parseGeoIpUpload = (bytes: Uint8Array) => {
  try {
    const metadata = new Reader(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)).metadata;
    const type = metadata.databaseType.toLowerCase();
    const kind: GeoIpKind | null = type.includes("city") ? "city" : type.includes("asn") ? "asn" : null;
    if (!kind) throw new GeoIpError("geoip_unsupported_type");
    const database = openGeoIpDatabase(kind, bytes, "uploaded");
    if (!database || Buffer.byteLength(metadata.databaseType) > 128) throw new GeoIpError("geoip_invalid");
    const description: unknown = metadata.description;
    const english =
      typeof description === "object" && description !== null && "en" in description && typeof description.en === "string"
        ? description.en
        : "";
    const subset = {
      databaseType: metadata.databaseType,
      buildEpoch: metadata.buildEpoch.toISOString(),
      ipVersion: metadata.ipVersion,
      languages: metadata.languages.slice(0, 16).map((language) => truncateUtf8(language, 32)),
      description: { en: truncateUtf8(english, 256) },
      nodeCount: metadata.nodeCount,
      recordSize: metadata.recordSize,
      size: bytes.byteLength,
    };
    if (
      subset.databaseType.includes("\0") ||
      subset.description.en.includes("\0") ||
      subset.languages.some((language) => language.includes("\0"))
    )
      throw new GeoIpError("geoip_invalid");
    // Pretty JSON is larger than PostgreSQL jsonb text, including its separator spaces.
    if (Buffer.byteLength(JSON.stringify(subset, null, 1)) > 4096) throw new GeoIpError("geoip_invalid");
    // A bounded probe catches gross corruption, not every bad record; request lookups still fail closed.
    for (const address of probeAddresses) {
      const record: unknown = database.reader.get(address);
      if (record !== null && (typeof record !== "object" || Array.isArray(record))) throw new GeoIpError("geoip_invalid");
    }
    return { kind, database, metadata: subset };
  } catch (error) {
    if (error instanceof GeoIpError) throw error;
    throw new GeoIpError("geoip_invalid");
  }
};
