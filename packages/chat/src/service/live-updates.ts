import type { sql } from "bun";
import type { z } from "zod";
import type { ConversationRow } from "./access";
import type { ChatLiveEventSchema, MessageSchema } from "./contracts";
import { chatLive } from "./live";

type Update = { key: string; data: z.infer<typeof ChatLiveEventSchema>; access?: true };

/** Message and sidebar updates precede each affected person's membership hint. */
export const chatLiveUpdates = (
  conversationId: string,
  message: Omit<z.infer<typeof MessageSchema>, "reactions">,
  preview: string | null,
  affected: readonly string[],
): Update[] => {
  const access =
    affected.length > 0 ||
    message.system?.code === "groups_added" ||
    message.system?.code === "group_removed" ||
    message.system?.code === "discovery_changed";
  return [
    { key: `c:${conversationId}`, data: { type: "message", message }, ...(access ? { access: true } : {}) },
    {
      key: `l:${conversationId}`,
      data: {
        type: "summary",
        thread: message.thread,
        conversationId,
        id: message.id,
        seq: message.seq,
        rev: message.rev,
        kind: message.kind,
        author: message.author,
        createdAt: message.createdAt,
        preview,
        ...(message.attachments.length ? { attachments: message.attachments } : {}),
        mention: false,
      },
      ...(access ? { access: true } : {}),
    },
    ...affected.map((id): Update => ({ key: `p:${id}`, data: { type: "membership", conversationId } })),
  ];
};

/** Membership changes in channels update metadata and access without filling the timeline. */
export const publishMembership = async (db: typeof sql, conversation: ConversationRow, affected: readonly string[]) => {
  const [head] = await db<{ id: string }[]>`UPDATE chat.conversations
    SET rev = rev + 1, changed_rev = rev + 1, updated_at = now() WHERE id = ${conversation.id}::uuid RETURNING id`;
  if (!head) throw new Error("Chat membership has no conversation");
  const data = { type: "membership" as const, conversationId: conversation.short_id };
  for (const key of [`c:${conversation.short_id}`, `l:${conversation.short_id}`]) await chatLive.publish(db, { key, data, access: true });
  for (const id of affected)
    await chatLive.publish(db, { key: `p:${id}`, data: { type: "membership", conversationId: conversation.short_id } });
};
