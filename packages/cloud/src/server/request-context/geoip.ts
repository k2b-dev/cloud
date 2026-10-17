import { Reader } from "mmdb-lib";
import { logger } from "../../services/logging";
import { publicClientAddress } from "./address";

export const BUNDLED_GEOIP_PATHS = {
  cityPath: "/app/geoip/dbip-city-lite.mmdb",
  asnPath: "/app/geoip/dbip-asn-lite.mmdb",
} as const;
export const DBIP_ATTRIBUTION = {
  text: "IP Geolocation by DB-IP",
  url: "https://db-ip.com",
  license: "CC BY 4.0",
  licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
} as const;

// Both names fit the 512-byte request context budget of the later slice.
const NAME_MAX_BYTES = 96;
export type GeoIpDatabaseInfo = { databaseType: string; buildDate: Date; source: "bundled" };

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

export const openGeoIpDatabase = (kind: "city" | "asn", bytes: Uint8Array, source: "bundled" = "bundled") => {
  try {
    // This Buffer is a view: Buffer.from(bytes) would copy the entire mmap.
    const reader = new Reader(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    const metadata = reader.metadata;
    if ((metadata.ipVersion !== 4 && metadata.ipVersion !== 6) || !metadata.databaseType.toLowerCase().includes(kind)) return null;
    const info: GeoIpDatabaseInfo = { databaseType: metadata.databaseType, buildDate: metadata.buildEpoch, source };
    if (!Number.isFinite(info.buildDate.getTime())) return null;
    return { reader, info };
  } catch {
    return null;
  }
};

type Database = NonNullable<ReturnType<typeof openGeoIpDatabase>>;
export type GeoIpLookup = {
  cityDatabase: boolean;
  asnDatabase: boolean;
  country: string | null;
  city: string | null;
  network: string | null;
};
export type GeoIp = {
  lookup(address: string | null, locale?: string): GeoIpLookup;
  status(): { city: GeoIpDatabaseInfo | null; asn: GeoIpDatabaseInfo | null };
};

export const createGeoIp = (paths: { cityPath: string; asnPath: string } = BUNDLED_GEOIP_PATHS): GeoIp => {
  let loaded = false;
  let city: Database | null = null;
  let asn: Database | null = null;
  const logged = new Set<string>();
  const logOnce = (key: string, message: string) => {
    if (logged.has(key)) return;
    logged.add(key);
    // Logging failure must never prevent a sign-in. Do not include lookup addresses or decoder errors.
    try {
      logger("request-context").warn(message);
    } catch {}
  };
  const open = (kind: "city" | "asn", path: string): Database | null => {
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
  const load = () => {
    if (loaded) return;
    loaded = true;
    city = open("city", paths.cityPath);
    asn = open("asn", paths.asnPath);
  };
  const read = (kind: "city" | "asn", database: Database | null, address: string) => {
    try {
      return record(database?.reader.get(address));
    } catch {
      logOnce(`${kind}-lookup`, `GeoIP ${kind} lookup failed; sign-in details are unavailable for this request`);
      return {};
    }
  };
  return {
    status() {
      load();
      const info = (database: Database | null): GeoIpDatabaseInfo | null =>
        database ? { ...database.info, buildDate: new Date(database.info.buildDate.getTime()) } : null;
      return { city: info(city), asn: info(asn) };
    },
    lookup(address, locale = "en") {
      load();
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

let bundled: GeoIp | undefined;
export const getGeoIp = (): GeoIp => (bundled ??= createGeoIp());
