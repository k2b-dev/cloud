import { accounts, logger, notifications, settings } from "@k2b/cloud/services";
import { createPgOutbox } from "@k2b/cloud/services/outbox";
import { sql } from "bun";
import { app } from "../config";
import { requireBaseAccess } from "./access-control";
import type { BaseNotice } from "./base-notifications";

const log = logger("pulse:store-health");
type Notice =
  | { kind: "storageThresholdReached"; data: { baseName: string; threshold: number } }
  | { kind: "storeDiskLow"; data: { freePercent: number } }
  | { kind: "storeUnavailable"; data: Record<string, never> };
type NoticeRow = (Notice | BaseNotice) & { id: string; attempts: number; user_id: string; locale: string; base_id: string | null };
export const notificationOutbox = createPgOutbox<NoticeRow>({
  table: "pulse.notification_outbox",
  name: "pulse:notifications",
  orderBy: "user_id",
  sequence: "seq",
  where: { dispatch_kind: "delivery" },
  reconcileIntervalMs: 10_000,
  publish: async (row) => {
    if (
      (row.kind === "alert" || row.kind === "source_stale") &&
      (!row.base_id || !(await requireBaseAccess(row.base_id, { id: row.user_id }, "admin")).ok)
    )
      return;
    const options = { recipient: { userId: row.user_id }, idempotencyKey: row.id, locale: row.locale };
    switch (row.kind) {
      case "alert":
        await notifications.send(app.notifications.alert, { ...options, data: row.data });
        break;
      case "source_stale":
        await notifications.send(app.notifications.sourceStale, { ...options, data: row.data });
        break;
      case "storageThresholdReached":
        await notifications.send(app.notifications.storageThresholdReached, { ...options, data: row.data });
        break;
      case "storeDiskLow":
        await notifications.send(app.notifications.storeDiskLow, { ...options, data: row.data });
        break;
      case "storeUnavailable":
        await notifications.send(app.notifications.storeUnavailable, { ...options, data: row.data });
        break;
      default:
        throw new Error("Unknown Pulse notification");
    }
  },
});

// The account service resolves effective roles for both local and IPA users.
const cloudAdmins = async (): Promise<string[]> => {
  const ids: string[] = [];
  for (let page = 1; ; page++) {
    const result = await accounts.users.list({ profile: "user", page, perPage: 500 });
    ids.push(...result.users.filter((u) => u.roles.includes("admin")).map((u) => u.id));
    if (!result.pagination.has_next) return ids;
  }
};
export const notificationLocale = (locale?: string): Promise<string> =>
  locale ? Promise.resolve(locale) : settings.get<string>("app.locale");
const enqueue = async (db: typeof sql, ids: string[], notice: Notice, locale: string) => {
  if (!ids.length) return;
  for (const id of ids)
    await db`INSERT INTO pulse.notification_outbox(kind,user_id,data,locale)
    VALUES(${notice.kind},${id}::uuid,(${JSON.stringify(notice.data)}::jsonb #>> '{}')::jsonb,${locale})`;
};

/** Called only after the failed store transaction has rolled back. The singleton row serializes replicas. */
export const recordStoreOutage = async (now: Date, database = sql, locale?: string) => {
  // During an ongoing outage every failed write lands here: answer from the open outage without scanning users.
  const [open] = await database`SELECT 1 FROM pulse.store_instance WHERE singleton AND outage_started_at IS NOT NULL`;
  if (open) return;
  const language = await notificationLocale(locale);
  const admins = await cloudAdmins();
  return database.begin(async (tx) => {
    const opened = await tx`INSERT INTO pulse.store_instance(singleton,outage_started_at) VALUES(true,${now})
    ON CONFLICT(singleton) DO UPDATE SET outage_started_at=EXCLUDED.outage_started_at
    WHERE pulse.store_instance.outage_started_at IS NULL RETURNING singleton`;
    if (opened.length) await enqueue(tx, admins, { kind: "storeUnavailable", data: {} }, language);
  });
};

export const recordInstanceDisk = async (free: number, total: number, now: Date, database = sql, locale?: string) => {
  const language = await notificationLocale(locale);
  // Recipients are only needed for a new crossing; a disk that stays low keeps its first notification.
  const [prior] = await database<{ disk_low_at: Date | null }[]>`SELECT disk_low_at FROM pulse.store_instance WHERE singleton`;
  const admins = total > 0 && free / total < 0.1 && !prior?.disk_low_at ? await cloudAdmins() : [];
  const recovered = await database.begin(async (tx) => {
    await tx`INSERT INTO pulse.store_instance(singleton) VALUES(true) ON CONFLICT DO NOTHING`;
    const [prior] = await tx<
      { disk_low_at: Date | null; outage_started_at: Date | null }[]
    >`SELECT disk_low_at,outage_started_at FROM pulse.store_instance WHERE singleton FOR UPDATE`;
    const low = total > 0 && free / total < 0.1;
    await tx`UPDATE pulse.store_instance SET free_bytes=${free},total_bytes=${total},measured_at=${now},
      disk_low_at=CASE WHEN ${low} THEN coalesce(disk_low_at,${now}) ELSE NULL END,
      last_outage_ended_at=CASE WHEN outage_started_at IS NOT NULL THEN ${now} ELSE last_outage_ended_at END,outage_started_at=NULL WHERE singleton`;
    if (low && !prior?.disk_low_at)
      await enqueue(tx, admins, { kind: "storeDiskLow", data: { freePercent: (free / total) * 100 } }, language);
    return Boolean(prior?.outage_started_at);
  });
  if (recovered) log.info("Pulse data store recovered");
};

/** Runs within the usage measurement's locked base-store transaction. */
export const recordStorageThreshold = async (baseId: string, usage: number, now: Date, db: typeof sql, locale: string) => {
  const [prior] = await db<{ storage_bytes: string; storage_exceeded_at: Date | null; name: string }[]>`
    SELECT s.storage_bytes,s.storage_exceeded_at,b.name FROM pulse.base_stores s JOIN pulse.bases b ON b.id=s.base_id WHERE s.base_id=${baseId}::uuid FOR UPDATE OF s`;
  if (!prior) return;
  const exceeded = usage >= Number(prior.storage_bytes);
  await db`UPDATE pulse.base_stores SET storage_exceeded_at=CASE WHEN ${exceeded} THEN coalesce(storage_exceeded_at,${now}) ELSE NULL END WHERE base_id=${baseId}::uuid`;
  if (exceeded && !prior.storage_exceeded_at) {
    // Pulse has no group-expansion helper. Notify direct user administrators only.
    const admins = await db<
      { user_id: string }[]
    >`SELECT DISTINCT a.user_id FROM pulse.base_access ba JOIN auth.access a ON a.id=ba.access_id WHERE ba.base_id=${baseId}::uuid AND a.permission='admin' AND a.user_id IS NOT NULL`;
    await enqueue(
      db,
      admins.map((a) => a.user_id),
      { kind: "storageThresholdReached", data: { baseName: prior.name, threshold: Number(prior.storage_bytes) } },
      locale,
    );
  }
};
