import { sql } from "@k2b/cloud";
import { z } from "zod";
import {
  type ChatContext,
  discoveryAllowed,
  discoveryGroupCondition,
  principalCondition,
  requireConversation,
  subjectPrincipal,
} from "./access";
import { FOR_YOU_COUNT_CAP } from "./contracts";
import { forYouUnread } from "./for-you";
import { effectiveNotificationLevelSql } from "./notification-levels";
import { readProjection } from "./read-state";
import { visibleThreadIdPage } from "./thread-access";

export const BadgeSchema = z.object({ count: z.number().int().nonnegative() });
export const participantLevelSql = (db: typeof sql, permission = db`grants.permission`) =>
  effectiveNotificationLevelSql(db, {
    kind: db`c.kind`,
    channel: db`EXISTS(SELECT 1 FROM chat.conversation_access channel WHERE channel.conversation_id = c.id AND channel.role = 'discoverable')`,
    permission,
    memberCount: db`c.member_count`,
    notify: db`COALESCE(p.notify, 'default')`,
    notifyUntil: db`p.notify_until`,
  });
/** Same bounded counter for navigation, the open tab, and push. Each component caps at 99. */
export const badgeCount = async (context: ChatContext, db: typeof sql = sql, readerMode?: "cached"): Promise<number> => {
  if (context.accessSubject.type !== "user") return 0;
  const self = subjectPrincipal(context.accessSubject);
  const allowAuthenticated = await discoveryAllowed();
  let all = 0;
  let cursor: string | null = null;
  for (let batch = 0; batch < 5 && all < FOR_YOU_COUNT_CAP; batch++) {
    const rows: { id: string; short_id: string; kind: string }[] = await db<{ id: string; short_id: string; kind: string }[]>`
      SELECT c.id, c.short_id, c.kind FROM chat.participants p JOIN chat.conversations c ON c.id = p.conversation_id
      CROSS JOIN LATERAL (SELECT CASE max(CASE WHEN ca.role = 'discoverable' THEN 1 ELSE CASE a.permission WHEN 'admin' THEN 3 WHEN 'write' THEN 2 WHEN 'read' THEN 1 ELSE 0 END END)
        WHEN 3 THEN 'admin' WHEN 2 THEN 'write' WHEN 1 THEN 'read' ELSE 'none' END AS permission
        FROM chat.conversation_access ca JOIN auth.access a ON a.id = ca.access_id
        WHERE ca.conversation_id = c.id AND ${principalCondition(context.accessSubject, db)} AND a.permission IN ('read', 'write', 'admin')
          AND (ca.role = 'member' OR (${discoveryGroupCondition(context.accessSubject, db)} AND (NOT a.authenticated_only OR ${allowAuthenticated})))) grants
      WHERE p.principal_type = 'user' AND p.principal_id = ${self.id}::uuid
        AND ${cursor ? db`c.id > ${cursor}::uuid` : db`true`}
        AND (c.kind = 'system' OR grants.permission <> 'none') AND ${participantLevelSql(db)} = 'all'
        AND EXISTS(SELECT 1 FROM chat.messages m LEFT JOIN chat.thread_reads tr ON tr.thread_id = m.thread_id
          AND tr.principal_type = 'user' AND tr.principal_id = p.principal_id
          WHERE m.conversation_id = c.id AND m.kind = 'text' AND NOT (m.author_type = 'user' AND m.author_id = p.principal_id)
            AND m.seq > LEAST(GREATEST(COALESCE(CASE WHEN m.thread_id IS NULL THEN p.last_read_seq ELSE tr.last_read_seq END, 0), p.joined_seq),
              COALESCE((CASE WHEN m.thread_id IS NULL THEN p.unread_from_seq ELSE tr.unread_from_seq END) - 1, 9223372036854775807)))
      ORDER BY c.id LIMIT 100`;
    for (const row of rows) {
      if (row.kind === "chat") all++;
      else {
        const allowed = await requireConversation({ ...context, conversationId: row.short_id, required: "read" }, db);
        if (!allowed.ok) continue;
        const visible = await visibleThreadIdPage(db, context, row.id);
        if ((await readProjection(db, context, row.id, visible.ids)).unread > 0) all++;
      }
      if (all === FOR_YOU_COUNT_CAP) break;
    }
    if (rows.length < 100) break;
    cursor = rows.at(-1)!.id;
  }
  return Math.min(all, FOR_YOU_COUNT_CAP) + (await forYouUnread(context, db, readerMode));
};
