import { ratelimit } from "@k2b/cloud/server";
import { type ChatContext, messages as catalog, subjectPrincipal } from "./access";
import { SEND_CONVERSATION_LIMIT, SEND_CONVERSATION_WINDOW_SECONDS, SEND_LIMIT, SEND_WINDOW_SECONDS } from "./contracts";

const conversationLimit = ratelimit({
  id: "chat.message.send.conversation",
  limit: SEND_CONVERSATION_LIMIT,
  windowSecs: SEND_CONVERSATION_WINDOW_SECONDS,
});
const sendLimit = ratelimit({ id: "chat.message.send", limit: SEND_LIMIT, windowSecs: SEND_WINDOW_SECONDS });
export type RateLimited = { ok: false; error: string; code: "RATE_LIMITED"; status: 429; retryAfter: number };
export const checkWriteRate = async (input: ChatContext & { conversationId: string }): Promise<RateLimited | null> => {
  const author = subjectPrincipal(input.accessSubject);
  const identifier = `${author.type}:${author.id}`;
  // Limits run before the lock: a sender at its limit must not hold up the chat's other writers.
  for (const [limiter, key] of [
    [conversationLimit, `${identifier}:${input.conversationId}`],
    [sendLimit, identifier],
  ] as const) {
    const limited = await limiter.check(key);
    if (limited.limited) {
      return {
        ok: false,
        error: catalog(input).sendRateLimited,
        code: "RATE_LIMITED",
        status: 429,
        retryAfter: Math.max(1, Math.ceil(limited.resetIn / 1000)),
      } satisfies RateLimited;
    }
  }
  return null;
};
