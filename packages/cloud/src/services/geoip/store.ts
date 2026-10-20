import { sql } from "bun";
import { GEOIP_MAX_DATABASE_BYTES, type GeoIpKind } from "../../contracts/geoip";
import type { GeoIpUploads } from "../../server/request-context/geoip";

const SLICE_BYTES = 8 * 1024 * 1024;
export const createGeoIpUploads = (db: typeof sql = sql): GeoIpUploads => ({
  async versions() {
    const rows = await db<{ kind: GeoIpKind; sha256: string }[]>`SELECT kind, sha256 FROM geoip.databases`;
    return Object.fromEntries(rows.map((row) => [row.kind, row.sha256]));
  },
  async read(kind, sha256) {
    const [row] = await db<{ size: number }[]>`
      SELECT octet_length(data) AS size FROM geoip.databases WHERE kind = ${kind} AND sha256 = ${sha256}`;
    if (!row) return null;
    if (row.size < 1 || row.size > GEOIP_MAX_DATABASE_BYTES) throw new Error("Invalid GeoIP database size");
    const bytes = Buffer.allocUnsafe(row.size);
    for (let offset = 0; offset < bytes.length; offset += SLICE_BYTES) {
      const length = Math.min(SLICE_BYTES, bytes.length - offset);
      const [slice] = await db<{ data: Uint8Array }[]>`
        SELECT substring(data FROM ${offset + 1} FOR ${length}) AS data
        FROM geoip.databases WHERE kind = ${kind} AND sha256 = ${sha256}`;
      if (!slice) return null;
      if (slice.data.byteLength !== length) throw new Error("Incomplete GeoIP database slice");
      bytes.set(slice.data, offset);
    }
    return bytes;
  },
});

export const geoIpUploads = createGeoIpUploads();
