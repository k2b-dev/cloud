import type { LiveViewer } from "@k2b/cloud/events";
import { getEffectivePermissions, hasPermission } from "@k2b/cloud/server";
import { toPgTextArray, toPgUuidArray } from "@k2b/cloud/services";
import { sql } from "bun";
import { z } from "zod";
import {
  boundConversation,
  capPermission,
  conversationPermission,
  discoveryAllowed,
  personalChannelKey,
  readableMemberCondition,
  subjectPrincipal,
} from "./access";

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
  const allow = await discoveryAllowed();
  const userIds = viewers.flatMap((viewer) => (viewer.accessSubject.type === "user" ? [viewer.accessSubject.userId] : []));
  const guests = new Set(
    (await sql<{ id: string }[]>`SELECT id FROM auth.users WHERE id = ANY(${toPgUuidArray(userIds)}::uuid[]) AND profile = 'guest'`).map(
      (row) => row.id,
    ),
  );
  const allowed = new Set<string>();
  for (const guest of [false, true]) {
    const batch = viewers.filter((viewer) => (viewer.accessSubject.type === "user" && guests.has(viewer.accessSubject.userId)) === guest);
    if (!batch.length) continue;
    const permissions = await getEffectivePermissions({
      accessIds: sql`SELECT ca.access_id FROM chat.conversation_access ca JOIN chat.conversations c ON c.id = ca.conversation_id
        JOIN auth.access a ON a.id = ca.access_id WHERE c.short_id = ${shortId}
          AND (ca.role = 'member' OR ((NOT a.authenticated_only OR ${allow}) AND (${!guest} OR a.group_id IS NULL)))`,
      subjects: batch.map((viewer) => viewer.accessSubject),
    });
    for (const [index, viewer] of batch.entries())
      if (hasPermission(conversationPermission(shortId, permissions[index] ?? "none", viewer.actor), "read")) allowed.add(viewer.id);
  }
  return allowed;
};

const canReadPersonal = (viewer: LiveViewer) => {
  const bound = boundConversation(viewer.actor);
  return bound.ok && bound.data === null && capPermission("read", viewer.actor) !== "none";
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
      // Directory membership changes are visible on reads but do not publish Chat live hints.
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
    keys: async (_scope: unknown, viewer: LiveViewer) => (canReadPersonal(viewer) ? [personalChannelKey(viewer.accessSubject)] : []),
    authorize: async (key: string, viewers: readonly LiveViewer[]) =>
      new Set(
        viewers.filter((viewer) => canReadPersonal(viewer) && key === personalChannelKey(viewer.accessSubject)).map((viewer) => viewer.id),
      ),
  },
};
