import type { AccessSubject } from "@k2b/cloud/server";
import { toPgUuidArray } from "@k2b/cloud/services";
import type { SQLQuery, sql } from "bun";
import { subjectPrincipal } from "./access";
import { UNREAD_CAP } from "./contracts";

export const threadReadStartSql = (db: typeof sql) =>
  db`LEAST(GREATEST(COALESCE(tr.last_read_seq, 0), p.joined_seq), COALESCE(tr.unread_from_seq - 1, 9223372036854775807))`;
export type ThreadState = {
  id: string | null;
  short_id: string | null;
  last_read_seq: string | bigint | null;
  unread_from_seq: string | bigint | null;
  joined_seq: string | bigint | null;
  unread: number;
  first_unread_seq: string | bigint | null;
};
/** One bounded grouped query for General and every named thread, including archived ones. */
export const threadStates = (db: typeof sql, subject: AccessSubject, conversationId: string | SQLQuery, ids?: string[]) => {
  const self = subjectPrincipal(subject);
  return db<ThreadState[]>`SELECT t.id, t.short_id,
      CASE WHEN t.id IS NULL THEN p.last_read_seq ELSE tr.last_read_seq END AS last_read_seq,
      CASE WHEN t.id IS NULL THEN p.unread_from_seq ELSE tr.unread_from_seq END AS unread_from_seq,
      p.joined_seq, count(unread.seq)::int AS unread, min(unread.seq) AS first_unread_seq
    FROM (SELECT id, short_id FROM chat.threads WHERE conversation_id = ${conversationId}::uuid
      AND ${ids ? db`id = ANY(${toPgUuidArray(ids)}::uuid[])` : db`true`}
      UNION ALL SELECT NULL::uuid, NULL::text) t
    LEFT JOIN chat.participants p ON p.conversation_id = ${conversationId}::uuid
      AND p.principal_type = ${self.type} AND p.principal_id = ${self.id}::uuid
    LEFT JOIN chat.thread_reads tr ON tr.thread_id = t.id AND tr.principal_type = ${self.type} AND tr.principal_id = ${self.id}::uuid
    LEFT JOIN LATERAL (
      (SELECT m.seq FROM chat.messages m WHERE m.conversation_id = ${conversationId}::uuid
        AND m.thread_id = t.id AND p.conversation_id IS NOT NULL AND m.kind = 'text'
        AND NOT (m.author_type = ${self.type} AND m.author_id = ${self.id}::uuid)
        AND m.seq > ${threadReadStartSql(db)} ORDER BY m.seq LIMIT ${UNREAD_CAP})
      UNION ALL
      (SELECT m.seq FROM chat.messages m WHERE m.conversation_id = ${conversationId}::uuid
        AND m.thread_id IS NULL AND t.id IS NULL AND p.conversation_id IS NOT NULL AND m.kind = 'text'
        AND NOT (m.author_type = ${self.type} AND m.author_id = ${self.id}::uuid)
        AND m.seq > LEAST(GREATEST(COALESCE(p.last_read_seq, 0), p.joined_seq), COALESCE(p.unread_from_seq - 1, 9223372036854775807))
        ORDER BY m.seq LIMIT ${UNREAD_CAP})
    ) unread ON true
    GROUP BY t.id, t.short_id, p.last_read_seq, p.unread_from_seq, tr.last_read_seq, tr.unread_from_seq, p.joined_seq`;
};
