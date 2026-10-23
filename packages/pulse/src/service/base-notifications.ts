import { listUsersWithAccess } from "@k2b/cloud/server";
import { settings } from "@k2b/cloud/services";
import { sql } from "bun";
import type { AlertSeverity, AlertStateName } from "../alert-contracts";

export type BaseNotice =
  | { kind: "storageThresholdReached"; data: { baseName: string; threshold: number } }
  | { kind: "storeUnavailable"; data: Record<string, never> }
  | {
      kind: "alert";
      data: {
        baseId: string;
        baseName: string;
        ruleId: string;
        ruleName: string;
        key: string | null;
        state: AlertStateName;
        severity: AlertSeverity | null;
        value: number | null;
        error: string | null;
      };
    }
  | {
      kind: "source_stale";
      data: { baseId: string; baseName: string; sourceId: string; sourceName: string; stale: boolean; newestDataAt: string | null };
    };

/** Read only the event language; importing this helper must not initialize the outbox. */
export const notificationLocale = (locale?: string): Promise<string> =>
  locale ? Promise.resolve(locale) : settings.get<string>("app.locale");

/** Inserted in the state transaction. Fanout is durable and bounded; no admin is
 * silently dropped by the public membership API's 500-user page limit. */
export const enqueueBaseNotice = async (db: typeof sql, baseId: string, notice: BaseNotice, locale: string): Promise<void> => {
  const eventId = crypto.randomUUID();
  await db`INSERT INTO pulse.notification_outbox(id,event_id,kind,base_id,user_id,data,locale,dispatch_kind)
    VALUES(${eventId}::uuid,${eventId}::uuid,${notice.kind},${baseId}::uuid,NULL,
      (${JSON.stringify(notice.data)}::jsonb #>> '{}')::jsonb,${locale},'fanout')`;
};

/** One page, one transaction. Keep an event ahead of later events for its base
 * until every user page is resolved; two replicas cannot fan out it twice. */
export const fanoutBaseNotices = async (database = sql): Promise<number | null> =>
  database.begin(async (tx) => {
    await tx`SET LOCAL statement_timeout='10s'`.simple();
    const [event] = await tx<
      {
        id: string;
        event_id: string;
        base_id: string;
        kind: BaseNotice["kind"];
        data: BaseNotice["data"];
        locale: string;
        recipient_after: string | null;
      }[]
    >`
    SELECT current.* FROM pulse.notification_outbox current WHERE current.dispatch_kind='fanout'
      AND NOT EXISTS (SELECT 1 FROM pulse.notification_outbox earlier WHERE earlier.dispatch_kind='fanout'
        AND earlier.base_id=current.base_id AND earlier.seq<current.seq)
    ORDER BY current.seq LIMIT 1 FOR UPDATE OF current SKIP LOCKED`;
    if (!event) return null;
    const candidates = await tx<{ id: string }[]>`SELECT id FROM auth.users
    WHERE (${event.recipient_after}::uuid IS NULL OR id>${event.recipient_after}::uuid) ORDER BY id LIMIT 500`;
    const access = await tx<{ access_id: string; all_users_admin: boolean }[]>`
      SELECT ba.access_id,(a.permission='admin' AND a.user_id IS NULL AND a.group_id IS NULL AND a.service_account_id IS NULL) AS all_users_admin
      FROM pulse.base_access ba JOIN auth.access a ON a.id=ba.access_id WHERE ba.base_id=${event.base_id}::uuid`;
    // Concrete-user expansion intentionally omits authenticated/public grants.
    // For either admin grant every authenticated candidate already qualifies;
    // keep the same bounded page and the independent delivery-time rights check.
    const admins = access.some((grant) => grant.all_users_admin)
      ? candidates
      : candidates.length
        ? await listUsersWithAccess({
            accessIds: access.map((row) => row.access_id),
            userIds: candidates.map((row) => row.id),
            minimumPermission: "admin",
            limit: 500,
            db: tx,
          })
        : [];
    for (const admin of admins) {
      await tx`INSERT INTO pulse.notification_outbox(event_id,kind,base_id,user_id,data,locale)
      VALUES(${event.event_id}::uuid,${event.kind},${event.base_id}::uuid,${admin.id}::uuid,
        (${JSON.stringify(event.data)}::jsonb #>> '{}')::jsonb,${event.locale}) ON CONFLICT(event_id,user_id) DO NOTHING`;
    }
    if (candidates.length < 500) await tx`DELETE FROM pulse.notification_outbox WHERE id=${event.id}::uuid`;
    else await tx`UPDATE pulse.notification_outbox SET recipient_after=${candidates.at(-1)!.id}::uuid WHERE id=${event.id}::uuid`;
    return admins.length;
  });
