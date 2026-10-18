import { sql } from "bun";
import { HTTPException } from "hono/http-exception";
import {
  DBIP_ATTRIBUTION,
  GEOIP_MAX_DATABASE_BYTES,
  GEOIP_MAX_REQUEST_BYTES,
  type GeoIpAdminDatabase,
  type GeoIpAdminStatus,
  type GeoIpKind,
} from "../../contracts/geoip";
import { createGeoIp, type GeoIp, type GeoIpDatabaseInfo, getGeoIp } from "../../server/request-context/geoip";
import { audit } from "../audit";
import { GeoIpError, parseGeoIpUpload, readGeoIpUpload } from "./upload";

export { GEOIP_MAX_DATABASE_BYTES, GEOIP_MAX_REQUEST_BYTES } from "../../contracts/geoip";
export { GeoIpError } from "./upload";

type Actor = { id: string; roles: readonly string[]; uid?: string; provider?: string };
export type GeoIpUploadInfo = {
  kind: GeoIpKind;
  sha256: string;
  size: number;
  database_type: string;
  build_epoch: Date;
  description: string | null;
  uploaded_at: Date;
  uploaded_by: string | null;
  uploader_name: string | null;
};
const requireAdmin = (actor: Actor) => {
  if (!actor.roles.includes("admin")) throw new HTTPException(403, { message: "Administrator access required." });
};
let bundledInfo: ReturnType<GeoIp["status"]> | undefined;
const getBundledInfo = () => (bundledInfo ??= createGeoIp().status());
const isDbIp = (value: string) => /db[\s-]?ip/i.test(value);

export const geoIpAdminStatus = (
  rows: GeoIpUploadInfo[],
  bundled: { city: GeoIpDatabaseInfo | null; asn: GeoIpDatabaseInfo | null },
  now: number,
): GeoIpAdminStatus => {
  const database = (kind: GeoIpKind): GeoIpAdminDatabase => {
    const row = rows.find((row) => row.kind === kind);
    const info = bundled[kind];
    const buildDate = row?.build_epoch ?? info?.buildDate;
    return {
      kind,
      source: row ? "uploaded" : (info?.source ?? null),
      bundled: info !== null,
      databaseType: row?.database_type ?? info?.databaseType ?? null,
      buildDate: buildDate?.toISOString() ?? null,
      stale: buildDate !== undefined && now - buildDate.getTime() > 183 * 24 * 60 * 60 * 1000,
      dbIp: row ? isDbIp(`${row.database_type} ${row.description ?? ""}`) : info !== null,
      upload: row
        ? {
            sha256: row.sha256,
            size: row.size,
            uploadedAt: row.uploaded_at.toISOString(),
            uploadedBy: row.uploaded_by ? { id: row.uploaded_by, name: row.uploader_name ?? row.uploaded_by } : null,
          }
        : null,
    };
  };
  const databases: GeoIpAdminStatus["databases"] = [database("city"), database("asn")];
  return {
    databases,
    attribution: databases.some((item) => item.dbIp) ? DBIP_ATTRIBUTION : null,
    limits: { maxDatabaseBytes: GEOIP_MAX_DATABASE_BYTES, maxRequestBytes: GEOIP_MAX_REQUEST_BYTES },
  };
};

let uploading = false;
export const createGeoIpService = (options: { db?: typeof sql; reader?: GeoIp; bundled?: () => ReturnType<GeoIp["status"]> } = {}) => {
  const db = options.db ?? sql;
  const reader = () => options.reader ?? getGeoIp();
  const status = async (actor: Actor, config: { now?: () => number } = {}): Promise<GeoIpAdminStatus> => {
    requireAdmin(actor);
    const rows = await db<GeoIpUploadInfo[]>`
      SELECT d.kind, d.sha256, (d.metadata->>'size')::int AS size, d.database_type, d.build_epoch,
        d.metadata->'description'->>'en' AS description, d.uploaded_at, d.uploaded_by,
        COALESCE(u.display_name, u.uid) AS uploader_name
      FROM geoip.databases d LEFT JOIN auth.users u ON u.id = d.uploaded_by`;
    return geoIpAdminStatus(rows, (options.bundled ?? getBundledInfo)(), (config.now ?? Date.now)());
  };
  return {
    status,
    async upload(actor: Actor, body: ReadableStream<Uint8Array>, config: { contentLength?: number }) {
      requireAdmin(actor);
      if (uploading) throw new GeoIpError("geoip_upload_busy");
      uploading = true;
      try {
        const bytes = await readGeoIpUpload(body, config.contentLength);
        const { kind, database, metadata } = parseGeoIpUpload(bytes);
        const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
        database.info.sha256 = sha256;
        await db.begin(async (tx) => {
          await tx`
            INSERT INTO geoip.databases (kind, data, sha256, database_type, build_epoch, metadata, uploaded_by)
            VALUES (${kind}, ${bytes}, ${sha256}, ${metadata.databaseType}, ${metadata.buildEpoch}::timestamptz,
              ${JSON.stringify(metadata)}::jsonb, ${actor.id}::uuid)
            ON CONFLICT (kind) DO UPDATE SET data = EXCLUDED.data, sha256 = EXCLUDED.sha256,
              database_type = EXCLUDED.database_type, build_epoch = EXCLUDED.build_epoch, metadata = EXCLUDED.metadata,
              uploaded_by = EXCLUDED.uploaded_by, uploaded_at = now()`;
          await audit.record(
            {
              action: "core.geoip.upload",
              outcome: "allowed",
              actor: { ...actor, userId: actor.id },
              metadata: { kind, databaseType: metadata.databaseType, buildDate: metadata.buildEpoch, sha256, size: bytes.length },
            },
            tx,
          );
        });
        reader().install(kind, database);
        return { ...(await status(actor)), kind };
      } finally {
        uploading = false;
      }
    },
    async reset(actor: Actor, kind: GeoIpKind) {
      requireAdmin(actor);
      const changed = await db.begin(async (tx) => {
        const [row] = await tx<{ sha256: string; database_type: string; build_epoch: Date; size: number }[]>`
          DELETE FROM geoip.databases WHERE kind = ${kind}
          RETURNING sha256, database_type, build_epoch, octet_length(data) AS size`;
        if (!row) return false;
        await audit.record(
          {
            action: "core.geoip.reset",
            outcome: "allowed",
            actor: { ...actor, userId: actor.id },
            metadata: {
              kind,
              databaseType: row.database_type,
              buildDate: row.build_epoch.toISOString(),
              sha256: row.sha256,
              size: row.size,
            },
          },
          tx,
        );
        return true;
      });
      reader().install(kind, null);
      return { ...(await status(actor)), changed };
    },
  };
};
export const geoip = createGeoIpService();
