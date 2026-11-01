import type { z } from "zod";
import type { ConversationSchema } from "../service/contracts";

type Row = Pick<z.infer<typeof ConversationSchema>, "id" | "unread" | "mentionsUnread" | "summaryCursor">;

/** Chat's badge route; the same count the rail, the phone bar, and a push carry. */
export const CHAT_BADGE_PATH = "/api/chat/badge";
/** Several reads in a row settle before the badge is read again. */
const BADGE_SETTLE_MS = 1_000;

/** What the cleanup reaches outside Chat; tests pass their own. */
export type NotificationCleanupDependencies = {
  notifications: () => Promise<{ closeGroup(appId: string, group: string): Promise<void>; setBadge(count: number): Promise<void> }>;
  refreshAppBadges: () => Promise<void>;
  fetch: (input: string, init: RequestInit) => Promise<Response>;
};
const browserDependencies: NotificationCleanupDependencies = {
  notifications: () => import("@k2b/cloud/browser/notifications").then((module) => module.browserNotificationClient),
  refreshAppBadges: () => import("@k2b/cloud/browser/app-badges").then((module) => module.refreshAppBadges()),
  fetch: (input, init) => fetch(input, init),
};

/**
 * Keeps this device in step with what the person read anywhere. A chat without unread messages closes its
 * notification here, at start for every listed chat and later for each chat that becomes read; then the app badge,
 * the rail, and the phone bar read the count again. Web Push cannot remove a notification from another device, so
 * every device cleans up when Chat opens on it. Returns a function that takes the current rows; call it whenever they
 * change, and `dispose` when the list goes away.
 */
export const createNotificationCleanup = (dependencies: NotificationCleanupDependencies = browserDependencies) => {
  const closed = new Set<string>();
  let signature: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  // Only the latest badge read may set the badge; an older answer arriving late is dropped.
  let generation = 0;
  const client = dependencies.notifications;

  const refreshBadge = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (disposed) return;
      const mine = ++generation;
      try {
        await dependencies.refreshAppBadges();
        const response = await dependencies.fetch(CHAT_BADGE_PATH, { credentials: "same-origin", headers: { accept: "application/json" } });
        if (!response.ok) return void (await response.body?.cancel());
        const body: unknown = await response.json();
        const count = typeof body === "object" && body !== null && "count" in body ? body.count : null;
        if (typeof count === "number" && Number.isSafeInteger(count) && count >= 0 && !disposed && mine === generation)
          await (await client()).setBadge(count);
      } catch {
        // The badge is a hint; the next read or push sets it again.
      }
    }, BADGE_SETTLE_MS);
  };

  const update = (rows: readonly Row[]) => {
    if (disposed) return;
    for (const row of rows) {
      // A partial summary is a lower bound: zero there does not mean the chat is read.
      if (row.unread > 0 || row.mentionsUnread > 0 || row.summaryCursor != null) {
        closed.delete(row.id);
        continue;
      }
      if (closed.has(row.id)) continue;
      closed.add(row.id);
      void client()
        .then((notifications) => notifications.closeGroup("chat", row.id))
        .catch(() => {});
    }
    const next = rows.map((row) => `${row.id}:${row.unread}:${row.mentionsUnread}`).join(",");
    if (next !== signature) {
      signature = next;
      refreshBadge();
    }
  };
  update.dispose = () => {
    disposed = true;
    clearTimeout(timer);
  };
  return update;
};
