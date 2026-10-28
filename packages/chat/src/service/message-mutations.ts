import { err, fail, ok, type Result } from "@k2b/cloud/server";
import { toPgTextArray } from "@k2b/cloud/services";
import { sql } from "bun";
import type { z } from "zod";
import { type ChatContext, messages as catalog, requireConversation, subjectPrincipal } from "./access";
import { DeleteMessageSchema, EditMessageSchema, MessageIdSchema, type MessageViewSchema, withinMessageMutationWindow } from "./contracts";
import { chatLive } from "./live";
import { mentionViews, publishForYou, storeMentions } from "./mention-store";
import { extractMessageLinks } from "./message-links";
import { type MessageRow, messageViews } from "./message-store";
import { canReadThread } from "./thread-access";
import { checkWriteRate, type RateLimited } from "./write-rate";

type Input = ChatContext & { conversationId: string; messageId: string; input: unknown };
/** Shared by HTTP and capability actions; the conversation lock serializes access changes and competing edits. */
export const mutateMessage =
  (operation: "edit" | "delete") =>
  async (input: Input): Promise<Result<z.infer<typeof MessageViewSchema>> | RateLimited> => {
    const parsed = (operation === "edit" ? EditMessageSchema : DeleteMessageSchema).safeParse(input.input);
    const t = catalog(input);
    if (!parsed.success || !MessageIdSchema.safeParse(input.messageId).success) return fail(err.badInput(t.invalidInput));
    const scopes = input.credentialScopes ?? (input.actor.kind === "service_account" ? input.actor.scopes : undefined);
    if (scopes && !scopes.some((scope) => scope === "write" || scope === "admin")) return fail(err.forbidden(t.forbidden));
    const allowed = await requireConversation({ ...input, required: "write" });
    if (!allowed.ok) return allowed;
    const limited = await checkWriteRate(input);
    const self = subjectPrincipal(input.accessSubject);
    const data = parsed.data;
    const body = "body" in data && typeof data.body === "string" ? data.body : null;
    const hash = body === null ? null : new Bun.CryptoHasher("sha256").update(body).digest("hex");
    const result = await sql.begin(async (db): Promise<Result<z.infer<typeof MessageViewSchema>> | RateLimited> => {
      await db`SELECT id FROM chat.conversations WHERE short_id = ${input.conversationId} FOR UPDATE`;
      const current = await requireConversation({ ...input, required: "write" }, db);
      if (!current.ok) return current;
      const [row] = await db<(MessageRow & { id: string; database_now: Date })[]>`SELECT *,
      clock_timestamp() AS database_now
      FROM chat.messages WHERE conversation_id = ${current.data.id}::uuid AND short_id = ${input.messageId}`;
      if (!row || !(await canReadThread(db, input, row.thread_id)))
        return fail({ code: "NOT_FOUND", status: 404, message: t.messageNotFound });
      if (row.kind !== "text" || row.author_type !== self.type || row.author_id !== self.id) return fail(err.forbidden(t.forbidden));
      const [receipt] = await db<{ message_id: string; operation: string; revision: string | bigint; body_hash: string | null }[]>`
      SELECT message_id, operation, revision, body_hash FROM chat.message_mutations WHERE conversation_id = ${current.data.id}::uuid
      AND principal_type = ${self.type} AND principal_id = ${self.id}::uuid AND client_id = ${data.clientId}`;
      if (receipt) {
        if (
          receipt.message_id !== row.id ||
          receipt.operation !== operation ||
          Number(receipt.revision) !== data.revision ||
          receipt.body_hash !== hash
        )
          return fail({ code: "IDEMPOTENCY_CONFLICT", status: 409, message: t.messageChanged });
        return ok((await messageViews(db, [row], input.conversationId, input.accessSubject, input.locale))[0]!);
      }
      if (limited) return limited;
      if (!withinMessageMutationWindow(row.created_at, row.database_now.getTime()) || row.deleted_at)
        return fail({ code: "MESSAGE_MUTATION_EXPIRED", status: 409, message: t.messageMutationExpired });
      if (Number(row.content_rev ?? 0) !== data.revision) return fail({ code: "MESSAGE_CHANGED", status: 409, message: t.messageChanged });
      if (row.thread_id) {
        const [thread] = await db<{ archived_at: Date | null }[]>`SELECT archived_at FROM chat.threads WHERE id = ${row.thread_id}::uuid`;
        if (thread?.archived_at) return fail({ code: "THREAD_ARCHIVED", status: 409, message: t.threadArchived });
      }
      const [head] = await db<{ rev: string | bigint }[]>`UPDATE chat.conversations SET rev = rev + 1, changed_rev = rev + 1
      WHERE id = ${current.data.id}::uuid RETURNING rev`;
      const [changed] = await db<MessageRow[]>`UPDATE chat.messages SET rev = ${head!.rev}, content_rev = content_rev + 1,
      body_md = ${body ?? ""}, links = ${toPgTextArray(body === null ? [] : extractMessageLinks(body))}::text[],
      via = ${operation === "edit" && input.via ? input.via : db`via`},
      edited_at = ${operation === "edit" ? db`clock_timestamp()` : db`edited_at`},
      deleted_at = ${operation === "delete" ? db`clock_timestamp()` : db`NULL`},
      refs = ${operation === "delete" ? db`'[]'::jsonb` : db`refs`}
      WHERE id = ${row.id}::uuid RETURNING *`;
      // Invalidate every previous recipient before removing the old mention offsets.
      await publishForYou(db, input, row.short_id, input.conversationId);
      const mentions = (await mentionViews(db, [row.short_id], input.locale)).get(row.short_id) ?? [];
      await db`DELETE FROM chat.message_mentions WHERE message_id = ${row.id}::uuid`;
      if (body !== null) {
        const before = row.body_md ?? "";
        const after = body;
        await storeMentions(
          db,
          row.short_id,
          mentions.filter(({ start, end }) => before.slice(start, end) === after.slice(start, end)),
        );
      }
      if (operation === "delete") {
        await db`DELETE FROM chat.message_reactions WHERE message_id = ${row.id}::uuid`;
        await db`DELETE FROM chat.attachments WHERE message_id = ${row.id}::uuid`;
      }
      await db`INSERT INTO chat.message_mutations (conversation_id, principal_type, principal_id, client_id, message_id, operation, revision, body_hash)
      VALUES (${current.data.id}::uuid, ${self.type}, ${self.id}::uuid, ${data.clientId}, ${row.id}::uuid, ${operation}, ${data.revision}, ${hash})`;
      const event = { type: "message-changed" as const, conversationId: input.conversationId };
      const [thread] = row.thread_id
        ? await db<{ short_id: string }[]>`SELECT short_id FROM chat.threads WHERE id = ${row.thread_id}::uuid`
        : [];
      const suffix = current.data.kind === "system" && thread ? `${input.conversationId}:${thread.short_id}` : input.conversationId;
      await chatLive.publish(db, { key: `${current.data.kind === "system" && thread ? "t" : "c"}:${suffix}`, data: event });
      await chatLive.publish(db, { key: `${current.data.kind === "system" && thread ? "s" : "l"}:${suffix}`, data: event });
      return ok((await messageViews(db, [changed!], input.conversationId, input.accessSubject, input.locale))[0]!);
    });
    if (result.ok) chatLive.wake();
    return result;
  };
