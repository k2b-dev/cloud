import { createAccess, deleteAccess, err, fail, ok } from "@k2b/cloud/server";
import { toPgUuidArray } from "@k2b/cloud/services";
import type { sql } from "bun";
import type { z } from "zod";
import { actingPrincipal, type ChatContext, type ConversationRow, discoveryAllowed, messages } from "./access";
import type { DiscoveryEntrySchema } from "./contracts";
import { value } from "./transaction-failure";

type Entry = z.infer<typeof DiscoveryEntrySchema>;
/** Who may discover a chat: shared by creating a chat and changing a channel's audience. */
export const validateDiscovery = async (db: typeof sql, entries: Entry[], context: ChatContext) => {
  const t = messages(context);
  if (entries.some((entry) => entry.principal.type === "authenticated") && !(await discoveryAllowed()))
    return fail(err.badInput(t.authenticatedDiscoveryDisabled));
  const groupIds = entries.flatMap((entry) => (entry.principal.type === "group" ? [entry.principal.groupId] : []));
  if (groupIds.length) {
    const [caller] =
      context.accessSubject.type === "user"
        ? await db<{ profile: string }[]>`SELECT profile FROM auth.users WHERE id = ${context.accessSubject.userId}::uuid`
        : [];
    if (caller?.profile === "guest") return fail(err.badInput(t.fullAccountGroups));
    const rows = await db<{ id: string }[]>`SELECT id FROM auth.groups WHERE id = ANY(${toPgUuidArray(groupIds)}::uuid[]) FOR SHARE`;
    if (rows.length !== groupIds.length) return fail(err.badInput(t.groupUnavailable));
  }
  return ok();
};
export const writeDiscovery = async (db: typeof sql, row: ConversationRow, entries: Entry[], context: ChatContext) => {
  const previous = await db<
    { access_id: string }[]
  >`SELECT access_id FROM chat.conversation_access WHERE conversation_id = ${row.id}::uuid AND role = 'discoverable'`;
  for (const entry of previous) value(await deleteAccess({ id: entry.access_id }, db));
  const actor = actingPrincipal(context.actor);
  for (const entry of entries) {
    const access = value(await createAccess({ principal: entry.principal, permission: entry.permission }, db));
    await db`INSERT INTO chat.conversation_access (conversation_id, access_id, role, added_by_type, added_by_id)
      VALUES (${row.id}::uuid, ${access.id}::uuid, 'discoverable', ${actor.type}, ${actor.id}::uuid)`;
  }
};
