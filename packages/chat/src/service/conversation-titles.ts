import { toPgUuidArray } from "@k2b/cloud/services";
import type { sql } from "bun";
import { type ChatContext, type ConversationRow, subjectPrincipal } from "./access";
import { deriveTitle, TITLE_NAME_LIMIT } from "./titles";

/** One bounded query for titles across the page, including the creation transaction's own grants. */
export const titles = async (rows: ConversationRow[], context: ChatContext, db: typeof sql) => {
  const self = subjectPrincipal(context.accessSubject);
  const others = rows.length
    ? await db<{ conversation_id: string; display_name: string; given_name: string; former: boolean; group: boolean }[]>`
    SELECT c.id AS conversation_id, names.* FROM chat.conversations c
    CROSS JOIN LATERAL (
      SELECT display_name, given_name, former, "group" FROM (
        SELECT COALESCE(NULLIF(u.display_name, ''), u.uid) AS display_name, COALESCE(u.given_name, '') AS given_name,
          false AS former, false AS "group", 0 AS section, ca.added_at AS added_at, 0::bigint AS joined_seq, ca.access_id AS order_id
        FROM chat.conversation_access ca JOIN auth.access a ON a.id = ca.access_id JOIN auth.users u ON u.id = a.user_id
        WHERE ca.conversation_id = c.id AND ca.role = 'member' AND a.permission IN ('read', 'write', 'admin')
          AND NOT (${self.type} = 'user' AND a.user_id = ${self.id}::uuid)
        UNION ALL
        SELECT sa.name, '', false, false, 0, ca.added_at, 0::bigint, ca.access_id
        FROM chat.conversation_access ca JOIN auth.access a ON a.id = ca.access_id JOIN auth.service_accounts sa ON sa.id = a.service_account_id
        WHERE ca.conversation_id = c.id AND ca.role = 'member' AND a.permission IN ('read', 'write', 'admin')
          AND NOT (${self.type} = 'service_account' AND sa.id = ${self.id}::uuid)
        UNION ALL
        SELECT '', '', true, false, 1, NULL::timestamptz, p.joined_seq, p.principal_id FROM chat.participants p
        WHERE p.conversation_id = c.id AND p.origin = 'direct'
          AND ((p.principal_type = 'user' AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p.principal_id))
            OR (p.principal_type = 'service_account' AND NOT EXISTS (SELECT 1 FROM auth.service_accounts sa WHERE sa.id = p.principal_id)))
        UNION ALL
        SELECT COALESCE(NULLIF(g.name, ''), g.cn), '', false, true, 2, ca.added_at, 0::bigint, ca.access_id
        FROM chat.conversation_access ca JOIN auth.access a ON a.id = ca.access_id JOIN auth.groups g ON g.id = a.group_id
        WHERE ca.conversation_id = c.id AND ca.role = 'member' AND a.group_id IS NOT NULL AND a.permission IN ('read', 'write', 'admin')
      ) entries ORDER BY section, added_at, joined_seq, order_id LIMIT ${TITLE_NAME_LIMIT + 1}
    ) names WHERE c.id = ANY(${toPgUuidArray(rows.map((row) => row.id))}::uuid[])
  `
    : [];
  return new Map(
    rows.map((row) => [
      row.id,
      deriveTitle(
        row.name,
        others
          .filter((other) => other.conversation_id === row.id)
          .map((other) => ({ displayName: other.display_name, givenName: other.given_name, former: other.former, group: other.group })),
        context.locale,
      ),
    ]),
  );
};
