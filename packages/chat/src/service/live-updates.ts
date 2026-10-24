import type { z } from "zod";
import type { ChatLiveEventSchema, MessageSchema } from "./contracts";

type Update = { key: string; data: z.infer<typeof ChatLiveEventSchema>; access?: true };

/** Message and sidebar updates precede each affected person's membership hint. */
export const chatLiveUpdates = (
  conversationId: string,
  message: z.infer<typeof MessageSchema>,
  preview: string | null,
  affected: readonly string[],
): Update[] => {
  const access = affected.length > 0 || message.system?.code === "groups_added" || message.system?.code === "group_removed";
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
        mention: false,
      },
      ...(access ? { access: true } : {}),
    },
    ...affected.map((id): Update => ({ key: `p:${id}`, data: { type: "membership", conversationId } })),
  ];
};
