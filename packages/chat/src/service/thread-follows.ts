import { sql } from "@k2b/cloud";
import { err, fail, ok } from "@k2b/cloud/server";
import { type ChatContext, messages, requireConversation, subjectPrincipal } from "./access";
import { ThreadIdSchema } from "./contracts";
import { record } from "./conversations";
import { chatLive } from "./live";
import { publishNotificationPreferences } from "./live-updates";
import { findThread, threadNotFound } from "./threads";

const set = async (input: ChatContext & { conversationId: string; threadId: string; following: boolean }) => {
  const scopes = input.credentialScopes ?? (input.actor.kind === "service_account" ? input.actor.scopes : undefined);
  if (scopes && !scopes.some((scope) => scope === "write" || scope === "admin")) return fail(err.forbidden(messages(input).forbidden));

  if (!ThreadIdSchema.safeParse(input.threadId).success) return fail(err.badInput(messages(input).invalidInput));
  const result = await sql.begin(async (db) => {
    await db`SELECT id FROM chat.conversations WHERE short_id = ${input.conversationId} FOR UPDATE`;
    const allowed = await requireConversation({ ...input, required: "read" }, db);
    if (!allowed.ok) return allowed;
    const thread = await findThread(db, allowed.data.id, input.threadId, input);
    if (!thread || allowed.data.kind !== "system" || thread.resource_type === null) return threadNotFound(input);
    const self = subjectPrincipal(input.accessSubject);
    const [participant] = await db`SELECT 1 FROM chat.participants WHERE conversation_id = ${allowed.data.id}::uuid
      AND principal_type = ${self.type} AND principal_id = ${self.id}::uuid FOR UPDATE`;
    if (!participant) return fail(err.forbidden(messages(input).notificationMembershipRequired));
    if (input.following)
      await db`INSERT INTO chat.thread_follows (principal_type, principal_id, conversation_id, thread_id)
        VALUES (${self.type}, ${self.id}::uuid, ${allowed.data.id}::uuid, ${thread.id}::uuid) ON CONFLICT DO NOTHING`;
    else
      await db`DELETE FROM chat.thread_follows WHERE principal_type = ${self.type} AND principal_id = ${self.id}::uuid
        AND conversation_id = ${allowed.data.id}::uuid AND thread_id = ${thread.id}::uuid`;
    await record(db, input, input.conversationId, "chat.thread.follow", { thread: input.threadId, following: input.following });
    await publishNotificationPreferences(db, input);
    return ok({ following: input.following });
  });
  if (result.ok) chatLive.wake();
  return result;
};
export const threadFollows = { set };
