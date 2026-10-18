import { Reader } from "mmdb-lib";
import type { GeoIpKind } from "../../contracts/geoip";
import { geoIpUploads } from "../../services/geoip/store";
import { logger } from "../../services/logging";
import { publicClientAddress } from "./address";

export const BUNDLED_GEOIP_PATHS = {
  cityPath: "/app/geoip/dbip-city-lite.mmdb",
  asnPath: "/app/geoip/dbip-asn-lite.mmdb",
} as const;
export { DBIP_ATTRIBUTION } from "../../contracts/geoip";

// Both names fit the 512-byte request context budget of the later slice.
const NAME_MAX_BYTES = 96;
export type GeoIpDatabaseInfo = { databaseType: string; buildDate: Date; source: "bundled" | "uploaded"; sha256?: string };

export const truncateUtf8 = (value: string, maxBytes: number): string => {
  let result = "";
  let bytes = 0;
  for (const char of value) {
    const point = char.codePointAt(0)!;
    // Drop lone surrogates rather than carrying invalid Unicode into stored context.
    if (point >= 0xd800 && point <= 0xdfff) continue;
    const size = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    if (bytes + size > maxBytes) break;
    result += char;
    bytes += size;
  }
  return result;
};

const cleanName = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  return (
    truncateUtf8(
      value
        .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
        .replace(/\s+/g, " ")
        .trim(),
      NAME_MAX_BYTES,
    ) || null
  );
};
const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};

const METADATA_MARKER = Buffer.from("abcdef4d61784d696e642e636f6d", "hex");
const isBoundedMmdbValue = (
  bytes: Buffer,
  start: number,
  base: number,
  end: number,
  checked: Set<number>,
  expandedLimit?: number,
): boolean => {
  if (start < base || start >= end) return false;
  let budget = end - base;
  let offset = start;
  let expansionBudget = expandedLimit ?? Infinity;
  const costs = expandedLimit === undefined ? undefined : new Map<number, number>();
  const active = new Set([start]);
  checked.add(start);
  const stack: { remaining: number; map?: boolean; resume?: number; target?: number; expansionStart?: number }[] = [{ remaining: 1 }];
  while (stack.length) {
    const frame = stack[stack.length - 1]!;
    if (!frame.remaining) {
      stack.pop();
      if (frame.target !== undefined) {
        active.delete(frame.target);
        costs?.set(frame.target, frame.expansionStart! - expansionBudget);
      }
      offset = frame.resume ?? offset;
      continue;
    }
    const key = frame.map && frame.remaining % 2 === 0;
    frame.remaining--;
    if (--budget < 0 || --expansionBudget < 0 || offset < base || offset >= end) return false;
    const control = bytes[offset++]!;
    let type = control >> 5;
    if (key && type !== 2 && type !== 1) return false;
    if (type === 1) {
      const size = (control >> 3) & 3;
      if (offset + size + 1 > end) return false;
      let target = size === 3 ? 0 : control & 7;
      for (let i = 0; i <= size; i++) target = target * 256 + bytes[offset++]!;
      target += base + [0, 2048, 526336, 0][size]!;
      if (target < base || target >= end || active.has(target)) return false;
      // A key may point directly to a string, never another pointer or a container.
      if (key && bytes[target]! >> 5 !== 2) return false;
      if (checked.has(target)) {
        expansionBudget -= costs?.get(target) ?? 0;
        if (expansionBudget < 0) return false;
        continue;
      }
      checked.add(target);
      active.add(target);
      stack.push({ remaining: 1, resume: offset, target, expansionStart: expansionBudget });
      offset = target;
      continue;
    }
    if (type === 0) {
      if (offset >= end) return false;
      type = bytes[offset++]! + 7;
      if (type < 8 || type > 15) return false;
    }
    let size = control & 31;
    if (size >= 29) {
      const extra = size - 28;
      if (offset + extra > end) return false;
      size = [29, 285, 65821][extra - 1]! + bytes.readUIntBE(offset, extra);
      offset += extra;
    }
    if (type === 7 || type === 11) {
      const remaining = size * (type === 7 ? 2 : 1);
      if (remaining > budget) return false;
      stack.push({ remaining, map: type === 7 });
      continue;
    }
    switch (type) {
      case 2:
      case 4:
        break;
      case 3:
        if (size !== 8) return false;
        break;
      case 5:
      case 6:
      case 8:
      case 9:
      case 10:
        if (size > ({ 5: 2, 6: 4, 8: 4, 9: 8, 10: 16 } as const)[type]) return false;
        break;
      case 14:
        if (size > 1) return false;
        size = 0;
        break;
      case 15:
        if (size !== 4) return false;
        break;
      default:
        return false;
    }
    // Payload bytes count as well: uncached metadata decodes a shared string once per reference.
    expansionBudget -= size;
    if (offset + size > end || expansionBudget < 0) return false;
    offset += size;
  }
  return true;
};

// The MMDB spec caps the metadata section, marker included, at 128 KiB.
const METADATA_MAX_BYTES = 128 * 1024;
const boundedMmdbMetadataStart = (bytes: Buffer): number => {
  // Mirror mmdb-lib's backward marker scan exactly: it can skip a marker after a partial match, and the checked
  // section must be the one Reader decodes.
  const floor = bytes.byteLength - METADATA_MAX_BYTES;
  const last = METADATA_MARKER.length - 1;
  let found = 0;
  let position = bytes.byteLength - 1;
  while (found <= last && position-- > 0) {
    if (position < floor) return -1;
    found += bytes[position] === METADATA_MARKER[last - found] ? 1 : -found;
  }
  if (found <= last) return -1;
  const metaStart = position + found;
  // Metadata decoding has no cache: count repeated expansion, in nodes and payload bytes, using memoized target costs.
  // Shared strings may expand beyond the encoded section, up to the size the spec allows for the whole section.
  return isBoundedMmdbValue(bytes, metaStart, metaStart, bytes.length, new Set(), METADATA_MAX_BYTES) ? metaStart : -1;
};

export const hasBoundedMmdbMetadata = (bytes: Uint8Array): boolean =>
  boundedMmdbMetadataStart(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)) !== -1;

export const openGeoIpDatabase = (kind: GeoIpKind, bytes: Uint8Array, source: "bundled" | "uploaded" = "bundled") => {
  // This Buffer is a view: Buffer.from(bytes) would copy the entire mmap.
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const metadataStart = boundedMmdbMetadataStart(buffer);
  if (metadataStart === -1) return null;
  const dataEnd = metadataStart - METADATA_MARKER.length;
  try {
    const cursors = new Map<string | number, unknown>();
    const checked = new Set<number>();
    // decodeMap coerces non-string keys, which can expand shared arrays exponentially.
    // mmdb-lib asks the cache before decoding each record and pointer target.
    const cache = {
      get(key: string | number) {
        if (typeof key !== "number" || (!checked.has(key) && !isBoundedMmdbValue(buffer, key, dataStart, dataEnd, checked)))
          throw new Error("Invalid MMDB data value");
        return cursors.get(key);
      },
      set(key: string | number, value: unknown) {
        cursors.set(key, value);
      },
    };
    const reader = new Reader(buffer, { cache });
    const metadata = reader.metadata;
    const dataStart = metadata.searchTreeSize + 16;
    if (
      !Number.isSafeInteger(metadata.nodeCount) ||
      metadata.nodeCount <= 0 ||
      !(dataStart <= dataEnd) ||
      metadata.binaryFormatMajorVersion !== 2
    )
      return null;
    // An IPv4-only tree answers IPv6 lookups with unrelated IPv4 records, so only IPv6 databases qualify.
    if (metadata.ipVersion !== 6 || !metadata.databaseType.toLowerCase().includes(kind)) return null;
    const info: GeoIpDatabaseInfo = { databaseType: metadata.databaseType, buildDate: metadata.buildEpoch, source };
    if (!Number.isFinite(info.buildDate.getTime())) return null;
    const clear = () => {
      cursors.clear();
      checked.clear();
    };
    return {
      info,
      get(address: string) {
        try {
          return reader.get(address);
        } finally {
          clear();
        }
      },
      /** One cache for the whole batch: a record shared by many addresses is checked and decoded once. */
      getMany(addresses: readonly string[]) {
        try {
          return addresses.map((address) => reader.get(address));
        } finally {
          clear();
        }
      },
    };
  } catch {
    return null;
  }
};

export type GeoIpDatabase = NonNullable<ReturnType<typeof openGeoIpDatabase>>;
export type GeoIpLookup = {
  cityDatabase: boolean;
  asnDatabase: boolean;
  country: string | null;
  city: string | null;
  network: string | null;
};
export type GeoIpUploads = {
  versions(): Promise<Partial<Record<GeoIpKind, string>>>;
  read(kind: GeoIpKind, sha256: string): Promise<Uint8Array | null>;
};

export type GeoIp = {
  refresh(): Promise<void>;
  install(kind: GeoIpKind, database: GeoIpDatabase | null): void;
  lookup(address: string | null, locale?: string): GeoIpLookup;
  status(): { city: GeoIpDatabaseInfo | null; asn: GeoIpDatabaseInfo | null };
};

type GeoIpPaths = { cityPath: string; asnPath: string };
export const createGeoIp = (
  options: { paths?: GeoIpPaths; uploads?: GeoIpUploads; refreshIntervalMs?: number; now?: () => number } | GeoIpPaths = {},
): GeoIp => {
  const {
    paths = BUNDLED_GEOIP_PATHS,
    uploads,
    refreshIntervalMs = 60_000,
    now = Date.now,
  } = "cityPath" in options ? { paths: options } : options;
  const databases: Partial<Record<GeoIpKind, GeoIpDatabase | null>> = {};
  const generations = { city: 0, asn: 0 };
  const unreadable: Partial<Record<GeoIpKind, string>> = {};
  let lastCheck = -Infinity;
  let pending: Promise<void> | undefined;
  const logged = new Set<string>();
  const logOnce = (key: string, message: string) => {
    if (logged.has(key)) return;
    logged.add(key);
    // Logging failure must never prevent a sign-in. Do not include lookup addresses or decoder errors.
    try {
      logger("request-context").warn(message);
    } catch {}
  };
  const open = (kind: "city" | "asn", path: string): GeoIpDatabase | null => {
    try {
      // A private mapping: pages load on demand and a stray write never reaches the file.
      const database = openGeoIpDatabase(kind, Bun.mmap(path, { shared: false }));
      if (!database)
        logOnce(kind, `GeoIP ${kind} snapshot is invalid; sign-in ${kind === "city" ? "locations" : "network names"} are unavailable`);
      return database;
    } catch (error) {
      const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
      logOnce(
        kind,
        `GeoIP ${kind} snapshot ${missing ? "not found" : "could not be opened"}; sign-in ${kind === "city" ? "locations" : "network names"} are unavailable`,
      );
      return null;
    }
  };
  const load = (kind: GeoIpKind): GeoIpDatabase | null => {
    if (databases[kind] === undefined) databases[kind] = open(kind, paths[kind === "city" ? "cityPath" : "asnPath"]);
    return databases[kind] ?? null;
  };
  const install = (kind: GeoIpKind, database: GeoIpDatabase | null) => {
    generations[kind]++;
    // Undefined opens the bundled mapping lazily, without retaining a second reader.
    if (database) databases[kind] = database;
    else delete databases[kind];
  };
  const refresh = (): Promise<void> => {
    if (!uploads) return Promise.resolve();
    if (pending) return pending;
    const started = { ...generations };
    pending = Promise.resolve().then(async () => {
      try {
        const versions = await uploads.versions();
        const replacements: Partial<Record<GeoIpKind, GeoIpDatabase | null>> = {};
        for (const kind of ["city", "asn"] as const) {
          if (started[kind] !== generations[kind]) continue;
          const sha256 = versions[kind];
          if (sha256 === databases[kind]?.info.sha256 || (sha256 && sha256 === unreadable[kind])) continue;
          if (!sha256) replacements[kind] = null;
          else {
            const bytes = await uploads.read(kind, sha256);
            if (!bytes) continue; // Replaced or reset during the sliced read; retry next interval.
            const database = openGeoIpDatabase(kind, bytes, "uploaded");
            if (!database) {
              // Keep the current reader and do not read the same blob again every interval.
              unreadable[kind] = sha256;
              logOnce(`${kind}-stored`, `Stored GeoIP ${kind} upload could not be opened; keeping the current database`);
              continue;
            }
            database.info.sha256 = sha256;
            replacements[kind] = database;
          }
        }
        for (const kind of ["city", "asn"] as const) {
          if (started[kind] !== generations[kind] || !(kind in replacements)) continue;
          install(kind, replacements[kind] ?? null);
        }
      } catch {
        logOnce("uploads", "GeoIP uploads could not be refreshed; keeping current sign-in databases");
      } finally {
        lastCheck = now();
        pending = undefined;
      }
    });
    return pending;
  };
  const read = (kind: "city" | "asn", database: GeoIpDatabase | null, address: string) => {
    try {
      return record(database?.get(address));
    } catch {
      logOnce(`${kind}-lookup`, `GeoIP ${kind} lookup failed; sign-in details are unavailable for this request`);
      return {};
    }
  };
  return {
    refresh,
    install,
    status() {
      const city = load("city");
      const asn = load("asn");
      const info = (database: GeoIpDatabase | null): GeoIpDatabaseInfo | null =>
        database ? { ...database.info, buildDate: new Date(database.info.buildDate.getTime()) } : null;
      return { city: info(city), asn: info(asn) };
    },
    lookup(address, locale = "en") {
      if (now() - lastCheck >= refreshIntervalMs) void refresh();
      const city = load("city");
      const asn = load("asn");
      const result: GeoIpLookup = { cityDatabase: city !== null, asnDatabase: asn !== null, country: null, city: null, network: null };
      const publicAddress = publicClientAddress(address);
      if (!publicAddress) return result;
      const cityRecord = read("city", city, publicAddress);
      const country = record(cityRecord.country).iso_code;
      if (typeof country === "string" && /^[a-z]{2}$/i.test(country) && country.toUpperCase() !== "ZZ")
        result.country = country.toUpperCase();
      const names = record(record(cityRecord.city).names);
      result.city = cleanName(names[locale]) ?? cleanName(names[locale.split("-")[0] ?? "en"]) ?? cleanName(names.en);
      result.network = cleanName(read("asn", asn, publicAddress).autonomous_system_organization);
      return result;
    },
  };
};

let instance: GeoIp | undefined;
export const getGeoIp = (): GeoIp => (instance ??= createGeoIp({ uploads: geoIpUploads }));
