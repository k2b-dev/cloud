import { IconButton, useLocale } from "@k2b/ui";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { createLiveWebSocket } from "../browser/live-websocket";
import { notificationTargetMatchesLocation } from "../browser/notification-target";
import { browserNotificationClient } from "../browser/notifications";
import {
  NOTIFICATION_LIVE_WS_TYPE,
  type NotificationLiveClientMessage,
  type NotificationLiveEvent,
  NotificationLiveEventSchema,
  type NotificationLiveServerMessage,
  NotificationStreamCursorSchema,
  parseNotificationLiveServerMessage,
} from "../contracts/notification-live";
import { platformMessages } from "./platform-messages";

const cursorStorageKey = (userId: string): string => `cloud.notifications.live-cursor:${userId}`;

const readStoredCursor = (userId: string): string | null => {
  try {
    const cursor = sessionStorage.getItem(cursorStorageKey(userId));
    return NotificationStreamCursorSchema.safeParse(cursor).success ? cursor : null;
  } catch {
    return null;
  }
};

const storeCursor = (userId: string, cursor: string) => {
  try {
    sessionStorage.setItem(cursorStorageKey(userId), cursor);
  } catch {
    // Private or restricted browsing may disable storage; in-memory resume still works.
  }
};

export default function BrowserNotifications(props: { userId: string }) {
  const locale = useLocale();
  const t = () => platformMessages.resolve([locale()]).t;
  const [notification, setNotification] = createSignal<NotificationLiveEvent | null>(null);
  const seen = new Set<string>();

  onMount(() => {
    const receive = (value: NotificationLiveEvent) => {
      if (seen.has(value.eventId)) return true;
      seen.add(value.eventId);
      if (seen.size > 500) seen.delete(seen.values().next().value ?? "");
      if (value.targetHref && notificationTargetMatchesLocation(value.targetHref, window.location.href)) return true;
      setNotification(value);
      return true;
    };

    void browserNotificationClient.refreshExisting().catch((error) => {
      console.warn("[notifications] Failed to refresh the browser endpoint", error);
    });

    const onMessage = (event: MessageEvent<unknown>) => {
      const parsed = NotificationLiveEventSchema.safeParse(event.data);
      if (!parsed.success) return;
      receive(parsed.data);
      event.ports[0]?.postMessage({ received: true });
    };
    navigator.serviceWorker?.addEventListener("message", onMessage);

    const initialCursor = readStoredCursor(props.userId);
    const connection = createLiveWebSocket<NotificationLiveServerMessage>({
      url: "/api/me/notifications/ws",
      initialCursor,
      activity: "visible",
      subscribe: (cursor) =>
        ({
          type: NOTIFICATION_LIVE_WS_TYPE.subscribe,
          payload: { fromCursor: cursor },
        }) satisfies NotificationLiveClientMessage,
      parse: parseNotificationLiveServerMessage,
      onMessage: (message, controls) => {
        if (message.type === NOTIFICATION_LIVE_WS_TYPE.ready) {
          controls.markApplied(message.payload.cursor);
          storeCursor(props.userId, message.payload.cursor);
          return;
        }
        if (message.type === NOTIFICATION_LIVE_WS_TYPE.event) {
          receive(message.payload.event);
          controls.markApplied(message.payload.cursor);
          storeCursor(props.userId, message.payload.cursor);
          return;
        }
        if (message.type === NOTIFICATION_LIVE_WS_TYPE.revoked) {
          controls.terminate({ code: message.payload.code, message: message.payload.message });
        }
      },
      onFatal: (error) => {
        if (error.code === "login_required" || error.code === "access_denied") window.location.reload();
        else console.warn("[notifications] Foreground updates stopped", error);
      },
    });
    connection.connect();

    onCleanup(() => {
      navigator.serviceWorker?.removeEventListener("message", onMessage);
      connection.dispose();
    });
  });

  return (
    <Show when={notification()} keyed>
      {(item) => (
        <aside
          class="paper fixed bottom-3 left-3 right-3 z-40 flex items-start gap-3 p-3 shadow-lg sm:left-auto sm:w-96"
          aria-live="polite"
          aria-label={t().newNotification}
        >
          <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-blue-500/10 text-blue-600 dark:bg-blue-400/15 dark:text-blue-400">
            <i class="ti ti-bell" />
          </span>
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm font-medium text-primary">{item.title}</p>
            <p class="mt-0.5 text-xs text-dimmed">{t().relatedItemReady}</p>
            {item.targetHref && (
              <a
                href={item.targetHref}
                class="mt-2 inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
              >
                {t().open}
                <i class="ti ti-arrow-right" />
              </a>
            )}
          </div>
          <IconButton size="xs" class="shrink-0" label={t().dismissNotification} onClick={() => setNotification(null)}>
            <i class="ti ti-x" />
          </IconButton>
        </aside>
      )}
    </Show>
  );
}
