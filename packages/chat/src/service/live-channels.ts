import type { LiveViewer } from "@k2b/cloud/events";
import { getEffectivePermissions, hasPermission } from "@k2b/cloud/server";
import { sql } from "bun";
import { z } from "zod";
import { boundConversation, capPermission, conversationPermission, readableMemberCondition } from "./access";
import { ShortIdSchema } from "./contracts";

// The platform's per-subscription key limit.
const LIST_KEY_LIMIT = 1_000;

const chatReaders = async (key: string, viewers: readonly LiveViewer[]): Promise<ReadonlySet<string>> => {
  const people = viewers.filter((viewer) => viewer.accessSubject.type === "user");
  const shortId = key.slice(2);
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

const canReadPersonal = (viewer: LiveViewer) => boundConversation(viewer.actor).ok && capPermission("read", viewer.actor) !== "none";

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
      if (viewer.accessSubject.type !== "user" || !bound.ok || capPermission("read", viewer.actor) === "none") return [];
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
    keys: async (_scope: unknown, viewer: LiveViewer) =>
      viewer.accessSubject.type === "user" && canReadPersonal(viewer) ? [`p:${viewer.accessSubject.userId}`] : null,
    authorize: async (key: string, viewers: readonly LiveViewer[]) =>
      new Set(
        viewers
          .filter((viewer) => viewer.accessSubject.type === "user" && canReadPersonal(viewer) && key === `p:${viewer.accessSubject.userId}`)
          .map((viewer) => viewer.id),
      ),
  },
};
