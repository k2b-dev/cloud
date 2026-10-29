import { err, fail, ok } from "@k2b/cloud/server";
import { crypto } from "@k2b/stdlib";
import { sql } from "bun";
import { z } from "zod";
import { boundConversation, type ChatContext, type ConversationRow, capPermission, messages, subjectPrincipal } from "./access";
import { SystemChatParamSchema, SystemChatQuerySchema } from "./contracts";
import { conversations } from "./conversations";
import { discussionRead, providerFor } from "./discussion-read";
import { openParticipant } from "./read-state";
import { readContainers, readResource } from "./resource-access";

const open = async (input: ChatContext & { resourceType: string; resourceId: string }) => {
  const parsed = SystemChatParamSchema.safeParse(input);
  if (!parsed.success) return fail(err.badInput(messages(input).invalidInput));
  const ref = { type: parsed.data.resourceType, id: parsed.data.resourceId };
  const resource = (await providerFor(input, ref.type, "container")) ? await readResource(input, ref) : null;
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
        VALUES (${crypto.common.readableId(6)}, 'system', ${ref.type}, ${ref.id}, ${Array.from(resource.title).slice(0, 80).join("")},
          ${resource.context == null ? null : Array.from(resource.context).slice(0, 300).join("")}, ${self.type}, ${self.id}::uuid)
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
  if (!bound.ok || capPermission("read", input.actor) === "none" || !input.caller) return ok({ items: [], cursors: {}, skipped: [] });
  const session = discussionRead(input);
  const providers = await session.catalog().catch(() => null);
  if (!providers) return fail({ code: "PROVIDER_UNAVAILABLE", status: 500, message: messages(input).systemChatsFailed });
  const incoming = parsed.data.cursors ?? {};
  // Object order carries the rotation: unvisited providers lead the next page.
  const types = [...new Set([...Object.keys(incoming), ...providers.map((provider) => provider.containerType)])].filter((type) =>
    providers.some((provider) => provider.containerType === type),
  );
  const cursors: Record<string, string> = {};
  const skipped: string[] = [];
  const entries = [];
  const visited: [string, string][] = [];
  for (const [index, type] of types.entries()) {
    if (incoming[type] === "") {
      visited.push([type, ""]);
      continue;
    }
    const start = incoming[type] ?? "{}";
    let cursor: string | undefined;
    try {
      cursor = z
        .object({ cursor: z.string().max(2048).optional() })
        .strict()
        .parse(JSON.parse(start)).cursor;
    } catch {
      return fail(err.badInput(messages(input).invalidInput));
    }
    if (session.remaining < 2) {
      cursors[type] = start;
      if (!skipped.includes(type)) skipped.push(type);
      continue;
    }
    try {
      const active = types.slice(index).filter((candidate) => incoming[candidate] !== "").length;
      // Split the available work fairly; reserve list + reader calls and room for summaries.
      const limit = Math.max(1, Math.min(100, Math.floor((session.remaining / active - 1) / 2)));
      const page = await readContainers(input, type, cursor, undefined, undefined, limit);
      for (const entry of page.items) {
        let unavailable = false;
        const resource = await readResource(input, entry.ref, undefined, () => {
          unavailable = true;
        });
        // A broken individual reader must not pin the provider to this page forever.
        // Budget/deadline failures throw instead and preserve the provider's old cursor.
        if (unavailable && !skipped.includes(type)) skipped.push(type);
        if (resource && capPermission(resource.permission, input.actor) !== "none") entries.push({ entry, resource });
      }
      visited.push([type, page.nextCursor === null ? "" : JSON.stringify({ cursor: page.nextCursor })]);
    } catch {
      input.caller.signal?.throwIfAborted();
      cursors[type] = start;
      if (!skipped.includes(type)) skipped.push(type);
    }
  }
  for (const [type, cursor] of visited) cursors[type] = cursor;
  const visible = [];
  const retry = new Set<string>();
  for (const [index, { entry, resource }] of entries.entries()) {
    input.caller.signal?.throwIfAborted();
    const [row] = await sql<{ short_id: string }[]>`SELECT short_id FROM chat.conversations
      WHERE kind = 'system' AND resource_type = ${entry.ref.type} AND resource_id = ${entry.ref.id}`;
    if (bound.data !== null && row?.short_id !== bound.data) continue;
    const threadBudget = { remaining: Math.max(0, Math.floor(session.remaining / (entries.length - index))) };
    try {
      const conversation = row ? await conversations.get({ ...input, conversationId: row.short_id, threadBudget }) : null;
      if (conversation && !conversation.ok) continue;
      visible.push({ ...entry, name: resource.title, conversation: conversation?.data ?? null });
    } catch {
      input.caller.signal?.throwIfAborted();
      // Summary reads share the same budget. Keep a failed summary's provider
      // resumable instead of losing its entry or failing the other providers.
      retry.add(entry.ref.type);
    }
  }
  for (const type of retry) {
    cursors[type] = incoming[type] ?? "{}";
    if (!skipped.includes(type)) skipped.push(type);
  }
  const continued = Object.fromEntries([
    ...[...retry].map((type) => [type, cursors[type]]),
    ...Object.entries(cursors).filter(([type]) => !retry.has(type)),
  ]);
  return ok({ items: visible, cursors: continued, skipped });
};
export const systemChats = { open, list };
