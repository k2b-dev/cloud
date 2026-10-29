import { err, fail, ok } from "@k2b/cloud/server";
import { sql } from "bun";
import { type ChatContext, messages, requireConversation, subjectPrincipal } from "./access";
import { NotificationUpdateSchema } from "./contracts";
import { record } from "./conversations";
import { chatLive } from "./live";
import { publishNotificationPreferences } from "./live-updates";
import { notificationProjection } from "./notification-projection";

const get = async (input: ChatContext & { conversationId: string }) =>
  sql.begin("ISOLATION LEVEL REPEATABLE READ READ ONLY", async (db) => {
    const allowed = await requireConversation({ ...input, required: "read" }, db);
    if (!allowed.ok) return allowed;
    const projection = await notificationProjection(db, input, allowed.data);
    return projection ? ok(projection) : fail(err.forbidden(messages(input).notificationMembershipRequired));
  });
const set = async (input: ChatContext & { conversationId: string; input: unknown }) => {
  const scopes = input.credentialScopes ?? (input.actor.kind === "service_account" ? input.actor.scopes : undefined);
  if (scopes && !scopes.some((scope) => scope === "write" || scope === "admin")) return fail(err.forbidden(messages(input).forbidden));

  const parsed = NotificationUpdateSchema.safeParse(input.input);
  if (!parsed.success) return fail(err.badInput(messages(input).invalidInput));
  const result = await sql.begin(async (db) => {
    // Match message and membership lock order; leaving cannot race a personal write.
    await db`SELECT id FROM chat.conversations WHERE short_id = ${input.conversationId} FOR UPDATE`;
    const allowed = await requireConversation({ ...input, required: "read" }, db);
    if (!allowed.ok) return allowed;
    const self = subjectPrincipal(input.accessSubject);
    const data = parsed.data;
    const seconds = data.level !== "none" || data.for === "forever" ? null : { "1h": 3600, "8h": 28800, "1w": 604800 }[data.for];
    const rows =
      await db`UPDATE chat.participants SET notify = ${data.level}, notify_until = ${seconds === null ? db`NULL` : db`now() + ${seconds} * interval '1 second'`}
      WHERE conversation_id = ${allowed.data.id}::uuid AND principal_type = ${self.type} AND principal_id = ${self.id}::uuid RETURNING conversation_id`;
    if (!rows.length) return fail(err.forbidden(messages(input).notificationMembershipRequired));
    await record(db, input, input.conversationId, "chat.notifications.set", { level: data.level });
    await publishNotificationPreferences(db, input);
    return ok((await notificationProjection(db, input, allowed.data))!);
  });
  if (result.ok) chatLive.wake();
  return result;
};
export const notificationPreferences = { get, set };
