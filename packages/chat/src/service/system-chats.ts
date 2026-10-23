import { err, fail, ok } from "@k2b/cloud/server";
import { crypto } from "@k2b/stdlib";
import { sql } from "bun";
import { boundConversation, type ChatContext, type ConversationRow, capPermission, messages, subjectPrincipal } from "./access";
import { SystemChatParamSchema, SystemChatQuerySchema } from "./contracts";
import { conversations } from "./conversations";
import { openParticipant } from "./read-state";
import { readContainers, readerBatch, readResource } from "./resource-access";
import { SUMMARY_TRAVERSAL_BUDGET } from "./thread-access";

const open = async (input: ChatContext & { resourceType: string; resourceId: string }) => {
  const parsed = SystemChatParamSchema.safeParse(input);
  if (!parsed.success) return fail(err.badInput(messages(input).invalidInput));
  const ref = { type: parsed.data.resourceType, id: parsed.data.resourceId };
  const resource = await readResource(input, ref);
  const bound = boundConversation(input.actor, input.locale);
  if (!resource || capPermission(resource.permission, input.actor) === "none" || !bound.ok)
    return fail({ code: "NOT_FOUND", status: 404, message: messages(input).notFound });
  const result = await sql.begin(async (db) => {
    await db`SELECT pg_advisory_xact_lock(hashtextextended(${`chat.system:${ref.type}:${ref.id}`}, 0))`;
    const [existing] = await db<ConversationRow[]>`SELECT * FROM chat.conversations
      WHERE kind = 'system' AND resource_type = ${ref.type} AND resource_id = ${ref.id}`;
    if (bound.data !== null && existing?.short_id !== bound.data)
      return fail({ code: "NOT_FOUND", status: 404, message: messages(input).notFound });
    if (existing) return ok(existing.short_id);
    const self = subjectPrincipal(input.accessSubject);
    for (let attempt = 0; attempt < 10; attempt++) {
      const [row] = await db<ConversationRow[]>`INSERT INTO chat.conversations
        (short_id, kind, resource_type, resource_id, name, purpose, created_by_type, created_by_id)
        VALUES (${crypto.common.readableId(6)}, 'system', ${ref.type}, ${ref.id}, ${Array.from(resource.name).slice(0, 80).join("")},
          ${resource.description === null ? null : Array.from(resource.description).slice(0, 300).join("")}, ${self.type}, ${self.id}::uuid)
        ON CONFLICT (short_id) DO NOTHING RETURNING *`;
      if (row) return ok(row.short_id);
    }
    throw new Error("Conversation ID could not be allocated");
  });
  if (!result.ok) return result;
  const context = { ...input, conversationId: result.data };
  const opened = await openParticipant(context);
  return opened.ok ? conversations.get(context) : opened;
};
const list = async (input: ChatContext & { query?: unknown }) => {
  const parsed = SystemChatQuerySchema.safeParse(input.query ?? {});
  if (!parsed.success) return fail(err.badInput(messages(input).invalidInput));
  const bound = boundConversation(input.actor, input.locale);
  if (!bound.ok || capPermission("read", input.actor) === "none") return ok({ items: [], spacesCursor: null, notebooksCursor: null });
  const [spaces, notebooks] = await Promise.all([
    readContainers(input, "spaces.space", parsed.data.spacesCursor),
    readContainers(input, "notebooks.notebook", parsed.data.notebooksCursor),
  ]);
  // Sequential container work keeps nested item-reader batches at <= 8 concurrent calls.
  const entries = await readerBatch([...spaces.items, ...notebooks.items], async (entry) => ({
    entry,
    resource: await readResource(input, entry.ref),
  }));
  // Build a typed result without relying on stored conversation titles for authorization.
  const visible = [];
  const threadBudget = { remaining: SUMMARY_TRAVERSAL_BUDGET };
  for (const { entry, resource } of entries) {
    input.caller?.signal?.throwIfAborted();
    if (!resource || capPermission(resource.permission, input.actor) === "none") continue;
    const [row] = await sql<{ short_id: string }[]>`SELECT short_id FROM chat.conversations
      WHERE kind = 'system' AND resource_type = ${entry.ref.type} AND resource_id = ${entry.ref.id}`;
    if (bound.data !== null && row?.short_id !== bound.data) continue;
    const conversation = row ? await conversations.get({ ...input, conversationId: row.short_id, threadBudget }) : null;
    if (conversation && !conversation.ok) continue;
    visible.push({ ref: entry.ref, name: resource.name, conversation: conversation?.data ?? null });
  }
  return ok({ items: visible, spacesCursor: spaces.nextCursor, notebooksCursor: notebooks.nextCursor });
};
export const systemChats = { open, list };
