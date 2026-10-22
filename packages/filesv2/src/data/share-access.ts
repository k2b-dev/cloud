import { isIP } from "node:net";
import { sql } from "bun";

export const SHARE_ACCESS_CLIENTS = ["firefox", "chrome", "safari", "edge", "samsung", "opera", "other", "unknown"] as const;
export type ShareAccessClient = (typeof SHARE_ACCESS_CLIENTS)[number];
export type ShareAccessContext = { network: string; client: ShareAccessClient };
export type ShareAccessEvent = "page" | "download" | "password_failed";

/** Also accepts our already masked context; raw addresses never reach SQL, including lock keys. */
export function maskShareAccessNetwork(input?: string): string {
  if (!input || input.length > 64) return "unknown";
  const [address = "", prefix, extra] = input.trim().split("/");
  if (extra !== undefined || !/^[\da-f:.]+$/i.test(address)) return "unknown";
  const family = isIP(address);
  if (!family) return "unknown";
  if (family === 4) {
    if (prefix !== undefined && prefix !== "24") return "unknown";
    return `${address.split(".").slice(0, 3).join(".")}.0/24`;
  }
  if (prefix !== undefined && prefix !== "48") return "unknown";
  // isIP validated the whole address. Expand only its bounded eight words.
  const hex = address.replace(
    /(\d+)\.(\d+)\.(\d+)\.(\d+)$/,
    (_, a, b, c, d) => `${((Number(a) << 8) | Number(b)).toString(16)}:${((Number(c) << 8) | Number(d)).toString(16)}`,
  );
  const [left = "", right] = hex.split("::");
  const head = left ? left.split(":") : [];
  const tail = right ? right.split(":") : [];
  const words = (right === undefined ? head : [...head, ...Array<string>(8 - head.length - tail.length).fill("0"), ...tail]).map((word) =>
    Number.parseInt(word, 16),
  );
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff)
    return `${words[6]! >> 8}.${words[6]! & 255}.${words[7]! >> 8}.0/24`;
  // Canonicalize through URL's IPv6 serializer, including runs of zero words.
  const network = `${words
    .slice(0, 3)
    .map((word) => word.toString(16))
    .join(":")}::`;
  return `${new URL(`http://[${network}]/`).hostname.slice(1, -1)}/48`;
}

/** Internal clock override is for deterministic fixtures; HTTP callers supply only the context. */
export async function recordShareAccess(
  shareId: string,
  event: ShareAccessEvent,
  context?: ShareAccessContext,
  options: { now?: Date } = {},
): Promise<void> {
  if (!["page", "download", "password_failed"].includes(event)) throw new TypeError("Invalid share access event");
  const hour = new Date(options.now?.getTime() ?? Date.now());
  hour.setUTCMinutes(0, 0, 0);
  const network = maskShareAccessNetwork(context?.network);
  const client = SHARE_ACCESS_CLIENTS.find((value) => value === context?.client) ?? "unknown";
  await sql.begin(async (tx) => {
    // Canonical UUID and UTC hour: alternate UUID spellings must not bypass the shared lock.
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('filesv2.share-access:' || ${shareId}::uuid::text || ':' || ${hour.toISOString()}, 0))`;
    const [slot] = await tx<{ known: boolean; networks: number }[]>`SELECT
      EXISTS(SELECT 1 FROM filesv2.share_access WHERE share_id=${shareId}::uuid AND hour=${hour} AND network=${network}) AS known,
      (SELECT count(DISTINCT network)::int FROM filesv2.share_access WHERE share_id=${shareId}::uuid AND hour=${hour} AND network<>'*') AS networks`;
    const bucket = slot!.known || slot!.networks < 100 ? network : "*";
    await tx`INSERT INTO filesv2.share_access(share_id,hour,network,client,pages,downloads,password_failed)
      VALUES(${shareId}::uuid,${hour},${bucket},${client},${event === "page" ? 1 : 0},${event === "download" ? 1 : 0},${event === "password_failed" ? 1 : 0})
      ON CONFLICT(share_id,hour,network,client) DO UPDATE SET
        pages=share_access.pages+EXCLUDED.pages,
        downloads=share_access.downloads+EXCLUDED.downloads,
        password_failed=share_access.password_failed+EXCLUDED.password_failed`;
  });
}

/** At most 10,000 source rows per call, across rollup and daily retention together. */
export async function maintainShareAccess(input: { retentionDays: number; now?: Date }): Promise<{ rolledUp: number; purged: number }> {
  if (!Number.isInteger(input.retentionDays) || input.retentionDays < 30 || input.retentionDays > 3650)
    throw new RangeError("Share access retention must be between 30 and 3650 days");
  const now = input.now ?? new Date();
  const rollupBefore = new Date(now.getTime() - 30 * 86_400_000);
  const purgeBefore = new Date(now.getTime() - input.retentionDays * 86_400_000).toISOString().slice(0, 10);
  return sql.begin(async (tx) => {
    // One bounded maintenance transaction at a time. Concurrent workers return and retry next tick,
    // avoiding lock-order cycles between a daily upsert and retention of that same day.
    const [lock] = await tx<
      { acquired: boolean }[]
    >`SELECT pg_try_advisory_xact_lock(hashtextextended('filesv2.share-access-maintenance', 0)) AS acquired`;
    if (!lock!.acquired) return { rolledUp: 0, purged: 0 };
    const [rolled] = await tx<{ count: number }[]>`WITH candidates AS (
      SELECT share_id,hour,network,client FROM filesv2.share_access
      WHERE hour<${rollupBefore}
      ORDER BY hour,share_id,network,client LIMIT 10000 FOR UPDATE SKIP LOCKED
    ), removed AS (
      DELETE FROM filesv2.share_access a USING candidates c
      WHERE (a.share_id,a.hour,a.network,a.client)=(c.share_id,c.hour,c.network,c.client)
      RETURNING a.*
    ), daily AS (
      INSERT INTO filesv2.share_access_daily(share_id,day,pages,downloads,password_failed)
      SELECT share_id,(hour AT TIME ZONE 'UTC')::date,sum(pages)::bigint,sum(downloads)::bigint,sum(password_failed)::bigint
      FROM removed GROUP BY share_id,(hour AT TIME ZONE 'UTC')::date ORDER BY share_id,(hour AT TIME ZONE 'UTC')::date
      ON CONFLICT(share_id,day) DO UPDATE SET
        pages=share_access_daily.pages+EXCLUDED.pages,
        downloads=share_access_daily.downloads+EXCLUDED.downloads,
        password_failed=share_access_daily.password_failed+EXCLUDED.password_failed
      RETURNING share_id
    ) SELECT count(*)::int AS count FROM removed`;
    const purged = await tx`DELETE FROM filesv2.share_access_daily d USING (
      SELECT share_id,day FROM filesv2.share_access_daily
      WHERE day<${purgeBefore}::date
      ORDER BY day,share_id LIMIT ${10000 - rolled!.count} FOR UPDATE SKIP LOCKED
    ) c WHERE (d.share_id,d.day)=(c.share_id,c.day) RETURNING d.share_id`;
    return { rolledUp: rolled!.count, purged: purged.length };
  });
}
