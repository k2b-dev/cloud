import { parseAiResourceMarker } from "./resource-markers";
import type { AiRecentSentResourceRef } from "./types";

export const RECENT_SENT_REF_LIMIT = 8;
// Look back 25 messages/conversations per displayed ref: useful sparse history without
// scanning the owner's lifetime. insertMessageLocked (used by submitChatTurn and steering)
// bumps conversation.updated_at, so newly sent turns enter this indexed window.
export const RECENT_SENT_MESSAGE_SCAN_LIMIT = RECENT_SENT_REF_LIMIT * 25;
export const RECENT_SENT_CONVERSATION_SCAN_LIMIT = RECENT_SENT_MESSAGE_SCAN_LIMIT;

/**
 * Rows arrive newest first and contain only marker text, never whole message bodies. Forking or copying a chat copies
 * its messages with their short IDs, so a message ID counts once, however many chats hold a copy of it.
 */
export const collectRecentSentResourceRefs = (
  messages: readonly { conversationId: string; messageId: string; lastSentAt: string; markers: readonly string[] }[],
): AiRecentSentResourceRef[] => {
  const refs = new Map<string, AiRecentSentResourceRef>();
  const counted = new Set<string>();
  for (const message of messages) {
    if (counted.has(message.messageId)) continue;
    counted.add(message.messageId);
    const seen = new Set<string>();
    for (const text of message.markers) {
      const marker = parseAiResourceMarker(text);
      if (!marker) continue;
      const key = JSON.stringify([marker.ref.type, marker.ref.id]);
      if (seen.has(key)) continue;
      seen.add(key);
      const existing = refs.get(key);
      if (existing) existing.count++;
      else if (refs.size < RECENT_SENT_REF_LIMIT) {
        refs.set(key, { ref: marker.ref, count: 1, lastSentAt: message.lastSentAt, conversationId: message.conversationId });
      }
    }
  }
  return [...refs.values()];
};
