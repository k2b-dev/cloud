import type { LiveViewer } from "@k2b/cloud/events";
import { getEffectivePermissions, hasPermission } from "@k2b/cloud/server";
import { toPgUuidArray } from "@k2b/cloud/services";
import { sql } from "bun";
import { z } from "zod";
import {
  boundConversation,
  capPermission,
  conversationPermission,
  discoveryAllowed,
  personalChannelKey,
  readableMemberCondition,
} from "./access";
import { ShortIdSchema } from "./contracts";

// The platform's per-subscription key limit.
const LIST_KEY_LIMIT = 1_000;

const chatReaders = async (key: string, viewers: readonly LiveViewer[]): Promise<ReadonlySet<string>> => {
  const allow = await discoveryAllowed();
  const shortId = key.slice(2);
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

export const chatLiveChannels = {
  conversation: {
    scope: z.object({ conversation: ShortIdSchema }).strict(),
    keys: async ({ conversation }: { conversation: string }) => [`c:${conversation}`],
    authorize: chatReaders,
  },
  list: {
    collection: true as const,
    scope: z.object({}).strict(),
    keys: async (_scope: unknown, viewer: LiveViewer) => {
      const bound = boundConversation(viewer.actor);
      if (!bound.ok || capPermission("read", viewer.actor) === "none") return [];
      // Directory membership changes are visible on reads but do not publish Chat live hints.
      const rows = await sql<{ short_id: string }[]>`
        SELECT c.short_id FROM chat.conversations c
        JOIN chat.conversation_access ca ON ca.conversation_id = c.id JOIN auth.access a ON a.id = ca.access_id
        WHERE ${readableMemberCondition(viewer.accessSubject, bound.data)}
        GROUP BY c.id ORDER BY c.last_activity_at DESC, c.short_id DESC LIMIT ${LIST_KEY_LIMIT}
      `;
      return rows.map((row) => `l:${row.short_id}`);
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
