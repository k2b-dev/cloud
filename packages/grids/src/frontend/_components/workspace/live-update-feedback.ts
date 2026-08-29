import { toast } from "@k2b/ui";
import { workspaceMessages } from "./messages";

const NOTIFICATION_COOLDOWN_MS = 10_000;
let lastNotificationAt = 0;

export const notifyWorkspaceLiveUpdateFailure = (scope: string, error: unknown) => {
  console.warn(`Grids ${scope} live updates stopped`, error);

  const now = Date.now();
  if (now - lastNotificationAt < NOTIFICATION_COOLDOWN_MS) return;
  lastNotificationAt = now;

  const { t } = workspaceMessages.resolve([document.documentElement.lang]);
  toast.error(t.liveUpdatesStoppedDetail, {
    title: t.liveUpdatesStopped,
    duration: 0,
    action: { label: t.reload, href: window.location.href },
  });
};
