import type { sql } from "bun";
import { type AuthorizedConversation, type ChatContext, subjectPrincipal } from "./access";
import { type NotificationChoice, resolveNotifications } from "./notification-levels";
import { threadResource } from "./thread-access";

export const notificationProjection = async (db: typeof sql, context: ChatContext, conversation: AuthorizedConversation) => {
  const self = subjectPrincipal(context.accessSubject);
  const [row] = await db<{ notify: NotificationChoice; notify_until: Date | null; channel: boolean; now: Date }[]>`
    SELECT p.notify, p.notify_until, now() AS now,
      EXISTS(SELECT 1 FROM chat.conversation_access ca WHERE ca.conversation_id = p.conversation_id AND ca.role = 'discoverable') AS channel
    FROM chat.participants p WHERE p.principal_type = ${self.type} AND p.principal_id = ${self.id}::uuid AND p.conversation_id = ${conversation.id}::uuid`;
  if (!row) return null;
  let following: { count: number; first: { id: string; name: string } | null } | null = null;
  if (conversation.kind === "system") {
    const [count] = await db<{ count: number }[]>`SELECT count(*)::int AS count FROM chat.thread_follows
      WHERE principal_type = ${self.type} AND principal_id = ${self.id}::uuid AND conversation_id = ${conversation.id}::uuid`;
    const [first] = await db<{ id: string; short_id: string; resource_type: string | null; resource_id: string | null }[]>`
      SELECT t.id, t.short_id, t.resource_type, t.resource_id FROM chat.thread_follows f JOIN chat.threads t ON t.id = f.thread_id
      WHERE f.principal_type = ${self.type} AND f.principal_id = ${self.id}::uuid AND f.conversation_id = ${conversation.id}::uuid
      ORDER BY f.since DESC, f.thread_id LIMIT 1`;
    const resource = first
      ? await threadResource(context, { ...first, container_type: conversation.resource_type, container_id: conversation.resource_id })
      : null;
    following = { count: count!.count, first: first && resource ? { id: first.short_id, name: resource.title } : null };
  }
  return {
    ...resolveNotifications(
      {
        kind: conversation.kind,
        channel: row.channel,
        permission: conversation.permission,
        memberCount: conversation.member_count,
        notify: row.notify,
        notifyUntil: row.notify_until,
      },
      row.now,
    ),
    following,
  };
};
