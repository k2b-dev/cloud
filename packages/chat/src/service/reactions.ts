import { err, fail, ok, type Result } from "@k2b/cloud/server";
import { sql } from "bun";
import { type ChatContext, messages as catalog, requireConversation, subjectPrincipal } from "./access";
import { EmojiSchema, MessageIdSchema, REACTIONS_PER_MESSAGE, REACTIONS_PER_PERSON } from "./contracts";
import { chatLive } from "./live";
import { reactionGroups } from "./reaction-store";
import { checkWriteRate, type RateLimited } from "./write-rate";

type Input = ChatContext & { conversationId: string; messageId: string };
const notFound = (input: Input) => fail({ code: "NOT_FOUND", status: 404, message: catalog(input).messageNotFound });
const target = async (db: typeof sql, input: Input) => {
  const allowed = await requireConversation({ ...input, required: "read" }, db);
  if (!allowed.ok) return allowed.error.code === "FORBIDDEN" ? notFound(input) : allowed;
  if (!MessageIdSchema.safeParse(input.messageId).success) return fail(err.badInput(catalog(input).invalidInput));
  // Named and archived threads inherit the conversation's read policy, exactly like messages.get.
  const [message] = await db<{ id: string; kind: string }[]>`SELECT id, kind FROM chat.messages
    WHERE conversation_id = ${allowed.data.id}::uuid AND short_id = ${input.messageId}`;
  return message?.kind === "text" ? ok({ conversation: allowed.data, message }) : notFound(input);
};
const list = async (input: Input) =>
  sql.begin("ISOLATION LEVEL REPEATABLE READ READ ONLY", async (db) => {
    const found = await target(db, input);
    if (!found.ok) return found;
    return ok({ items: (await reactionGroups(db, [input.messageId], input.accessSubject, input.locale)).get(input.messageId) ?? [] });
  });
const set = async (input: Input & { emoji: string; on: boolean }): Promise<Result<null> | RateLimited> => {
  if (!EmojiSchema.safeParse(input.emoji).success) return fail(err.badInput(catalog(input).invalidInput));
  const found = await target(sql, input);
  if (!found.ok) return found;
  // A reader writes their own state. A write/admin credential is required even with a read-only resource grant.
  const scopes = input.credentialScopes ?? (input.actor.kind === "service_account" ? input.actor.scopes : undefined);
  if (scopes && !scopes.some((scope) => scope === "write" || scope === "admin")) return fail(err.forbidden(catalog(input).forbidden));
  const limited = await checkWriteRate(input);
  if (limited) return limited;
  const self = subjectPrincipal(input.accessSubject);
  const result = await sql.begin(async (db): Promise<Result<boolean>> => {
    // The same lock serializes sends, access changes and competing reaction budgets.
    await db`SELECT id FROM chat.conversations WHERE short_id = ${input.conversationId} FOR UPDATE`;
    const current = await target(db, input);
    if (!current.ok) return current;
    const messageId = current.data.message.id;
    const [existing] = await db<{ emoji: string }[]>`SELECT emoji FROM chat.message_reactions
      WHERE message_id = ${messageId}::uuid AND principal_type = ${self.type} AND principal_id = ${self.id}::uuid AND emoji = ${input.emoji}`;
    if (!!existing === input.on) return ok(false);
    if (input.on) {
      const [counts] = await db<{ own: number; distinct: number; present: boolean }[]>`SELECT
        count(*) FILTER (WHERE principal_type = ${self.type} AND principal_id = ${self.id}::uuid)::int AS own,
        count(DISTINCT emoji)::int AS distinct, COALESCE(bool_or(emoji = ${input.emoji}), false) AS present
        FROM chat.message_reactions WHERE message_id = ${messageId}::uuid`;
      if (counts!.own >= REACTIONS_PER_PERSON)
        return fail({ code: "REACTION_PERSON_LIMIT", status: 409, message: catalog(input).invalidInput });
      if (!counts!.present && counts!.distinct >= REACTIONS_PER_MESSAGE)
        return fail({ code: "REACTION_MESSAGE_LIMIT", status: 409, message: catalog(input).invalidInput });
      const [snapshot] =
        self.type === "user"
          ? await db<{ name: string | null }[]>`SELECT display_name AS name FROM auth.users WHERE id = ${self.id}::uuid`
          : await db<{ name: string | null }[]>`SELECT name FROM auth.service_accounts WHERE id = ${self.id}::uuid`;
      if (!snapshot) throw new Error("Chat reaction has no principal");
      await db`INSERT INTO chat.message_reactions (message_id, principal_type, principal_id, display_name, emoji)
        VALUES (${messageId}::uuid, ${self.type}, ${self.id}::uuid, ${snapshot.name ?? ""}, ${input.emoji})`;
    } else {
      await db`DELETE FROM chat.message_reactions WHERE message_id = ${messageId}::uuid
        AND principal_type = ${self.type} AND principal_id = ${self.id}::uuid AND emoji = ${input.emoji}`;
    }
    const [head] = await db<{ rev: string | bigint }[]>`UPDATE chat.conversations SET rev = rev + 1
      WHERE id = ${current.data.conversation.id}::uuid RETURNING rev`;
    await db`UPDATE chat.messages SET rev = ${head!.rev} WHERE id = ${messageId}::uuid`;
    await chatLive.publish(db, {
      key: `c:${input.conversationId}`,
      data: { type: "reactions", conversationId: input.conversationId, messageId: input.messageId, rev: Number(head!.rev) },
    });
    return ok(true);
  });
  if (!result.ok) return result;
  if (result.data) chatLive.wake();
  return ok(null);
};
export const reactions = { list, set };
