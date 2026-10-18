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

export const openGeoIpDatabase = (kind: GeoIpKind, bytes: Uint8Array, source: "bundled" | "uploaded" = "bundled") => {
  try {
    // Cache decoded pointer targets by byte offset so shared containers decode once per lookup.
    const cache = new Map<string | number, unknown>();
    // This Buffer is a view: Buffer.from(bytes) would copy the entire mmap.
    const reader = new Reader(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), { cache });
    const metadata = reader.metadata;
    // An IPv4-only tree answers IPv6 lookups with unrelated IPv4 records, so only IPv6 databases qualify.
    if (metadata.ipVersion !== 6 || !metadata.databaseType.toLowerCase().includes(kind)) return null;
    const info: GeoIpDatabaseInfo = { databaseType: metadata.databaseType, buildDate: metadata.buildEpoch, source };
    if (!Number.isFinite(info.buildDate.getTime())) return null;
    return {
      info,
      get(address: string) {
        try {
          return reader.get(address);
        } finally {
          cache.clear();
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
