import { z } from "zod";
import { type IdentityAccessSubject, subscribeIdentityAccessChanged } from "../events/app-access";
import { defineLive, type LiveViewer } from "../events/live";
import { logger } from "../services/logging";
import { AiInvalidationSchema } from "./live-events";

/**
 * Live updates of a user's AI data. Core publishes and serves them at
 * `/api/ai/live`; the AI's database triggers write them, keyed `u:<user ID>`,
 * in the transaction of every change. Other applications, such as Assistant,
 * read `cursor()` before their snapshot.
 */
export const aiLive = defineLive({ appId: "core", event: AiInvalidationSchema });

/** The user an AI request acts for: the user, or the user a credential is delegated by. */
const ownerOf = (viewer: LiveViewer): string | null => (viewer.accessSubject.type === "user" ? viewer.accessSubject.userId : null);

/**
 * `user` follows the viewer's own AI data: conversations, their files, tasks and
 * dictations, and the Projects the viewer can read. Its single key admits only
 * that user; who receives a Project change was decided when it was written.
 */
export const aiLiveChannels = {
  user: {
    eventOnly: true as const,
    scope: z.object({}).strict(),
    keys: async (_scope: unknown, viewer: LiveViewer) => {
      const owner = ownerOf(viewer);
      return owner ? [`u:${owner}`] : null;
    },
    authorize: async (key: string, viewers: readonly LiveViewer[]) =>
      new Set(viewers.filter((viewer) => `u:${ownerOf(viewer)}` === key).map((viewer) => viewer.id)),
  },
};

/** Shared Core followers carry revocation hints; no per-conversation topic or database polling. */
export const subscribeAiConversationAccess = (input: {
  conversationId: string;
  after: string;
  subject: IdentityAccessSubject;
  changed: () => void;
  failed: () => void;
}): (() => void) => {
  const abort = new AbortController();
  const stopIdentity = subscribeIdentityAccessChanged(input.changed, input.subject);
  void (async () => {
    try {
      for await (const event of aiLive.accessChanges({ after: input.after, signal: abort.signal })) {
        if (event.key === `ai.conversation:${input.conversationId}`) input.changed();
      }
      if (!abort.signal.aborted) input.failed();
    } catch (error) {
      if (abort.signal.aborted) return;
      logger("ai:stream").warn("Conversation access follower failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      input.failed();
    }
  })();
  return () => {
    abort.abort();
    stopIdentity();
  };
};
