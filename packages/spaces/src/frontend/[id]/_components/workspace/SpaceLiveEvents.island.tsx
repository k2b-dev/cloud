import { createLiveWebSocket } from "@k2b/cloud/browser/live";
import { reloadOnce } from "@k2b/cloud/browser/reload";
import { type DateContext, dates } from "@k2b/stdlib";
import { type ToastHandle, toast } from "@k2b/ui";
import { onCleanup, onMount } from "solid-js";
import {
  parseSpaceLiveServerMessage,
  SPACE_LIVE_WS_TYPE,
  type SpaceLiveClientMessage,
  type SpaceLiveServerMessage,
} from "../../../../live-events";
import { useSpaceMessages } from "../../messages";
import { createSpacesLiveCursorQueue, invalidateSpacesData } from "./workspace-events";

type Props = {
  spaceId: string;
  initialCursor: string | null;
  dateConfig?: DateContext;
};

export default function SpaceLiveEvents(props: Props) {
  const t = useSpaceMessages();
  onMount(() => {
    const lifecycle = new AbortController();
    let unavailable: ToastHandle | null = null;
    // Deadline views (overdue, today, this week) depend on the current day, and no event announces a new day.
    const today = () => dates.formatDateKey(new Date(), props.dateConfig);
    let snapshotDay = today();
    // A condition that persists across loads must not reload the page forever.
    const reload = () => {
      if (lifecycle.signal.aborted || unavailable || reloadOnce(`spaces:live:${props.spaceId}`)) return;
      unavailable = toast(t.liveUpdatesUnavailable, { duration: 0, action: { label: t.reload, onClick: () => window.location.reload() } });
    };
    const connection = createLiveWebSocket<SpaceLiveServerMessage>({
      url: "/api/spaces/ws",
      initialCursor: props.initialCursor,
      activity: "visible",
      subscribe: (cursor) =>
        ({
          type: SPACE_LIVE_WS_TYPE.subscribe,
          payload: { spaceId: props.spaceId, fromCursor: cursor },
        }) satisfies SpaceLiveClientMessage,
      parse: parseSpaceLiveServerMessage,
      onMessage: (message, controls) => {
        if (lifecycle.signal.aborted) return;
        if (message.payload.spaceId && message.payload.spaceId !== props.spaceId) return;
        if (message.type === SPACE_LIVE_WS_TYPE.error && message.payload.code === "resync_required") {
          controls.terminate({ code: message.payload.code, message: message.payload.message });
          return;
        }
        if (message.type === SPACE_LIVE_WS_TYPE.ready) {
          // A ready that confirms the subscribed cursor resumes the stream after it, as when a tab returns on the
          // same day. Any other cursor skipped events, and a new day moves deadline views, so the snapshot refreshes.
          const day = today();
          if (message.payload.cursor !== controls.subscribedCursor() || day !== snapshotDay) {
            snapshotDay = day;
            void applyCursor(["view", "detail", "wormholes"], message.payload.cursor, null);
          }
          return;
        }
        if (message.type === SPACE_LIVE_WS_TYPE.event) {
          const eventType = message.payload.event.type;
          if (eventType.startsWith("space.") || eventType === "access.changed") {
            reload();
            return;
          }
          const domains = eventType.startsWith("item.") ? (["view", "detail"] as const) : (["view", "wormholes"] as const);
          void applyCursor([...domains], message.payload.cursor, "itemId" in message.payload.event ? message.payload.event.itemId : null);
          return;
        }
        if (message.type === SPACE_LIVE_WS_TYPE.revoked) {
          controls.terminate({ code: message.payload.code, message: message.payload.message });
        }
      },
      onFatal: reload,
    });
    const applyCursor = createSpacesLiveCursorQueue({
      invalidate: invalidateSpacesData,
      markApplied: (cursor) => {
        if (!lifecycle.signal.aborted) connection.markApplied(cursor);
      },
      onFailure: reload,
      signal: lifecycle.signal,
    });

    connection.connect();
    onCleanup(() => {
      lifecycle.abort();
      connection.dispose();
      unavailable?.dismiss();
    });
  });

  return null;
}
