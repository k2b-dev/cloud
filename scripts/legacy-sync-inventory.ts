import { RedisClient, SQL } from "bun";

const DEFAULT_MAX_SYNC_KEYS = 10_000;
const LEGACY_CLOUD_SYNC_PREFIXES = [
  "cloud:contacts:events",
  "cloud:grids:events",
  "cloud:grids:workflow-events",
  "cloud:grids:workflow-runs",
  "cloud:grids:workflows",
  "cloud:gateway:telemetry",
  "cloud:mail:events",
  "cloud:notebooks",
  "cloud:notifications:live",
  "cloud:spaces:events",
] as const;

export type SyncKeyInventory = {
  currentDurable: string[];
  legacyDurable: string[];
  preservedScheduler: string[];
  nonDurable: string[];
  other: string[];
};

export const classifySyncKeys = (keys: readonly string[]): SyncKeyInventory => {
  const inventory: SyncKeyInventory = {
    currentDurable: [],
    legacyDurable: [],
    preservedScheduler: [],
    nonDurable: [],
    other: [],
  };
  for (const key of [...keys].sort()) {
    if (LEGACY_CLOUD_SYNC_PREFIXES.some((prefix) => key.startsWith(`${prefix}:`))) {
      inventory.legacyDurable.push(key);
    } else if (key.startsWith("sync:e:") || key.startsWith("sync:mutex:") || key.startsWith("sync:ratelimit:")) {
      inventory.nonDurable.push(key);
    } else if (key.startsWith("sync:scheduler:") && !key.startsWith("sync:scheduler:namespace:v4:")) {
      inventory.preservedScheduler.push(key);
    } else if (
      key.startsWith("sync:queue:namespace:v2:") ||
      key.startsWith("sync:topic:namespace:v2:") ||
      key.startsWith("sync:pump:namespace:v2:") ||
      key.startsWith("sync:scheduler:namespace:v4:") ||
      key.startsWith("sync:job:claim:v2:") ||
      key.startsWith("sync:job:enqueue-receipt:v2:") ||
      /^sync:job:.+:seq$/.test(key)
    ) {
      inventory.currentDurable.push(key);
    } else if (
      key.startsWith("sync:queue:") ||
      key.startsWith("sync:topic:") ||
      key.startsWith("sync:pump:") ||
      key.startsWith("sync:job:queue:") ||
      (key.startsWith("sync:job:") && key.includes(":idempotency:")) ||
      key.startsWith("sync:scheduler-control:")
    ) {
      inventory.legacyDurable.push(key);
    } else {
      inventory.other.push(key);
    }
  }
  return inventory;
};

export const scanSyncKeys = async (redis: RedisClient, maxKeys = DEFAULT_MAX_SYNC_KEYS): Promise<string[]> => {
  if (!Number.isSafeInteger(maxKeys) || maxKeys < 1) throw new Error("SYNC_INVENTORY_MAX_KEYS must be a positive safe integer");
  const keys = new Set<string>();
  let scans = 0;
  for (const pattern of ["sync:*", ...LEGACY_CLOUD_SYNC_PREFIXES.map((prefix) => `${prefix}:*`)]) {
    let cursor = "0";
    do {
      scans += 1;
      if (scans > 10_000) throw new Error("Redis Sync inventory exceeded the SCAN iteration safety limit");
      const raw = await redis.send("SCAN", [cursor, "MATCH", pattern, "COUNT", "1000"]);
      if (!Array.isArray(raw) || !Array.isArray(raw[1])) throw new Error("Redis returned an invalid SCAN response");
      cursor = String(raw[0]);
      for (const key of raw[1]) keys.add(String(key));
      if (keys.size > maxKeys)
        throw new Error(
          `Redis Sync inventory exceeds the ${maxKeys}-key safety limit; raise SYNC_INVENTORY_MAX_KEYS for the reviewed Redis database size`,
        );
    } while (cursor !== "0");
  }
  return [...keys];
};

export type LegacyYjsNote = { id: string; cursor: string; snapshotBytes: number };
export type LegacyYjsCoverage = {
  noteId: string;
  head: string;
  snapshotCursor: string | null;
  status: "covered" | "snapshot_required" | "deleted_note";
};

export const compareLegacyCursors = (left: string, right: string): number => {
  const parse = (value: string) => {
    if (!/^\d+-\d+$/.test(value)) throw new Error("Invalid legacy Yjs cursor");
    const [ms, seq] = value.split("-").map((part) => BigInt(part));
    return [ms!, seq!] as const;
  };
  const [leftMs, leftSeq] = parse(left);
  const [rightMs, rightSeq] = parse(right);
  return leftMs < rightMs ? -1 : leftMs > rightMs ? 1 : leftSeq < rightSeq ? -1 : leftSeq > rightSeq ? 1 : 0;
};

export const legacyYjsNoteId = (key: string): string | null => {
  const prefix = "sync:topic:namespace:v2:";
  if (!key.startsWith(prefix) || !key.endsWith(":stream")) return null;
  try {
    const identity: unknown = JSON.parse(decodeURIComponent(key.slice(prefix.length, -":stream".length)));
    if (!Array.isArray(identity) || identity.length !== 3 || identity[0] !== "cloud:notebooks:yjs") return null;
    return typeof identity[2] === "string" ? identity[2] : null;
  } catch {
    throw new Error(`Invalid legacy topic identity: ${key}`);
  }
};

export const assessLegacyYjsCoverage = (noteId: string, head: string, note?: LegacyYjsNote): LegacyYjsCoverage => ({
  noteId,
  head,
  snapshotCursor: note?.cursor ?? null,
  status: !note ? "deleted_note" : note.snapshotBytes > 0 && compareLegacyCursors(note.cursor, head) >= 0 ? "covered" : "snapshot_required",
});

export const legacyYjsHighWater = (raw: unknown): string => {
  let head: unknown;
  if (Array.isArray(raw)) {
    const index = raw.indexOf("last-generated-id");
    if (index >= 0) head = raw[index + 1];
  } else if (raw && typeof raw === "object") {
    head = Object.entries(raw).find(([key]) => key === "last-generated-id")?.[1];
  }
  if (typeof head !== "string" || !/^\d+-\d+$/.test(head)) throw new Error("Invalid legacy Yjs stream high-water response");
  return head;
};

export const inspectLegacyYjs = async (redis: RedisClient, db: SQL, keys: readonly string[]): Promise<LegacyYjsCoverage[]> => {
  const noteIds = [...new Set(keys.map(legacyYjsNoteId).filter((id): id is string => id !== null))];
  if (noteIds.length === 0) return [];
  const rows = await db<{ id: string; cursor: string; snapshot_bytes: number }[]>`
    SELECT id::text, yjs_stream_ms::text || '-' || yjs_stream_seq::text AS cursor,
           COALESCE(octet_length(yjs_snapshot), 0) AS snapshot_bytes
    FROM notebooks.notes
    WHERE id IN (SELECT jsonb_array_elements_text(${JSON.stringify(noteIds)}::text::jsonb)::uuid)
  `;
  const notes = new Map(rows.map((row) => [row.id, { id: row.id, cursor: row.cursor, snapshotBytes: row.snapshot_bytes }]));
  const result: LegacyYjsCoverage[] = [];
  for (const key of keys) {
    const noteId = legacyYjsNoteId(key);
    if (!noteId) continue;
    const raw = await redis.send("XINFO", ["STREAM", key]);
    result.push(assessLegacyYjsCoverage(noteId, legacyYjsHighWater(raw), notes.get(noteId)));
  }
  return result;
};

/** Read-only v5 cutover evidence. This does not classify old work as disposable. */
export const main = async (): Promise<number> => {
  const redisUrl = process.env.REDIS_URL?.trim();
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!redisUrl || !databaseUrl) {
    console.error("REDIS_URL and DATABASE_URL are required for the read-only v5 inventory and Yjs snapshot check.");
    return 1;
  }
  const redis = new RedisClient(redisUrl);
  const db = new SQL(databaseUrl);
  try {
    const keys = await scanSyncKeys(redis, Number(process.env.SYNC_INVENTORY_MAX_KEYS ?? DEFAULT_MAX_SYNC_KEYS));
    const inventory = classifySyncKeys(keys);
    const yjs = await inspectLegacyYjs(redis, db, keys);
    console.log(
      JSON.stringify(
        {
          observedAt: new Date().toISOString(),
          v5Durable: inventory.currentDurable,
          olderDurable: inventory.legacyDurable,
          legacySchedulers: inventory.preservedScheduler,
          nonDurable: inventory.nonDurable,
          unclassified: inventory.other,
          yjs,
          note: "A covered retained Yjs head is snapshot evidence only. Review other durable keys individually; never bulk-delete this inventory. Recheck after stopping producers. Previously expired history cannot be reconstructed by this report.",
        },
        null,
        2,
      ),
    );
    return yjs.some((entry) => entry.status === "snapshot_required") ? 1 : 0;
  } finally {
    redis.close();
    await db.close();
  }
};

if (import.meta.main) process.exitCode = await main();
