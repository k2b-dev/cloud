import type { LiveViewer } from "@k2b/cloud/events";
import { getEffectivePermissions, hasPermission } from "@k2b/cloud/server";
import { toPgTextArray } from "@k2b/cloud/services";
import { sql } from "bun";
import { z } from "zod";
import { boundConversation, capPermission, conversationPermission, readableMemberCondition, subjectPrincipal } from "./access";
import { ShortIdSchema } from "./contracts";
import { cachedResource, readerBatch } from "./resource-access";

// The platform's per-subscription key limit.
const LIST_KEY_LIMIT = 1_000;
const chatReaders = async (key: string, viewers: readonly LiveViewer[]): Promise<ReadonlySet<string>> => {
  const [, shortId, threadId] = key.split(":");
  if (!shortId) return new Set();
  const [conversation] = await sql<
    { kind: string; resource_type: string; resource_id: string }[]
  >`SELECT kind, resource_type, resource_id FROM chat.conversations WHERE short_id = ${shortId}`;
  if (conversation?.kind === "system") {
    const [thread] = threadId
      ? await sql<{ resource_type: string; resource_id: string }[]>`SELECT t.resource_type, t.resource_id
      FROM chat.threads t JOIN chat.conversations c ON c.id = t.conversation_id WHERE c.short_id = ${shortId} AND t.short_id = ${threadId}`
      : [];
    if (threadId && !thread) return new Set();
    const decisions = await readerBatch(viewers, async (viewer) => {
      const container = await cachedResource(viewer.id, { type: conversation.resource_type, id: conversation.resource_id });
      if (!container || !hasPermission(conversationPermission(shortId, container.permission, viewer.actor), "read")) return null;
      if (thread && !(await cachedResource(viewer.id, { type: thread.resource_type, id: thread.resource_id }))) return null;
      return viewer.id;
    });
    return new Set(decisions.filter((id): id is string => id !== null));
  }
  const people = viewers.filter((viewer) => viewer.accessSubject.type === "user");
  const permissions = await getEffectivePermissions({
    accessIds: sql`SELECT ca.access_id FROM chat.conversation_access ca JOIN chat.conversations c ON c.id = ca.conversation_id WHERE c.short_id = ${shortId}`,
    subjects: people.map((viewer) => viewer.accessSubject),
  });
  return new Set(
    people
      .filter((viewer, i) => hasPermission(conversationPermission(shortId, permissions[i] ?? "none", viewer.actor), "read"))
      .map((viewer) => viewer.id),
  );
};
const conversationKeys = async (conversation: string, prefix: "c" | "l") => {
  const rows = await sql<{ short_id: string }[]>`SELECT t.short_id FROM chat.threads t JOIN chat.conversations c ON c.id = t.conversation_id
    WHERE c.short_id = ${conversation} AND c.kind = 'system' ORDER BY t.last_activity_at DESC, t.short_id LIMIT ${LIST_KEY_LIMIT - 1}`;
  return [`${prefix}:${conversation}`, ...rows.map((row) => `${prefix === "c" ? "t" : "s"}:${conversation}:${row.short_id}`)];
};
export const chatLiveChannels = {
  conversation: {
    collection: true as const,
    scope: z.object({ conversation: ShortIdSchema }).strict(),
    keys: async ({ conversation }: { conversation: string }) => conversationKeys(conversation, "c"),
    authorize: chatReaders,
  },
  list: {
    collection: true as const,
    scope: z.object({}).strict(),
    keys: async (_scope: unknown, viewer: LiveViewer) => {
      const bound = boundConversation(viewer.actor);
      if (!bound.ok || capPermission("read", viewer.actor) === "none") return [];
      const self = subjectPrincipal(viewer.accessSubject);
      const rows = await sql<{ short_id: string }[]>`
        SELECT c.short_id, c.last_activity_at FROM chat.conversations c
        WHERE ${bound.data ? sql`c.short_id = ${bound.data}` : sql`true`} AND (
          EXISTS (SELECT 1 FROM chat.conversation_access ca JOIN auth.access a ON a.id = ca.access_id
            WHERE ca.conversation_id = c.id AND ${readableMemberCondition(viewer.accessSubject, bound.data)})
          OR (c.kind = 'system' AND EXISTS (SELECT 1 FROM chat.participants p WHERE p.conversation_id = c.id
            AND p.principal_type = ${self.type} AND p.principal_id = ${self.id}::uuid)))
        ORDER BY c.last_activity_at DESC, c.short_id DESC LIMIT ${LIST_KEY_LIMIT}
      `;
      // Preserve the container keys before spending the remaining subscription budget on items.
      const keys = rows.map((row) => `l:${row.short_id}`);
      if (keys.length && keys.length < LIST_KEY_LIMIT) {
        const items = await sql<{ conversation: string; thread: string }[]>`SELECT c.short_id AS conversation, t.short_id AS thread
          FROM chat.threads t JOIN chat.conversations c ON c.id = t.conversation_id
          WHERE c.kind = 'system' AND c.short_id = ANY(${toPgTextArray(rows.map((row) => row.short_id))}::text[])
          ORDER BY t.last_activity_at DESC, t.short_id LIMIT ${LIST_KEY_LIMIT - keys.length}`;
        keys.push(...items.map((item) => `s:${item.conversation}:${item.thread}`));
      }
      return keys;
    },
    authorize: chatReaders,
  },
  me: {
    scope: z.object({}).strict(),
    keys: async (_scope: unknown, viewer: LiveViewer) =>
      viewer.accessSubject.type === "user" ? [`p:${viewer.accessSubject.userId}`] : null,
    authorize: async (key: string, viewers: readonly LiveViewer[]) =>
      new Set(
        viewers
          .filter((viewer) => viewer.accessSubject.type === "user" && key === `p:${viewer.accessSubject.userId}`)
          .map((viewer) => viewer.id),
      ),
  },
};
