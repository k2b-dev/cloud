import { createLiveWebSocket } from "@k2b/cloud/browser/live";
import { reloadOnce } from "@k2b/cloud/browser/reload";
import { Button, NoticeCard } from "@k2b/ui";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
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
};

export default function SpaceLiveEvents(props: Props) {
  const t = useSpaceMessages();
  const [unavailable, setUnavailable] = createSignal(false);
  onMount(() => {
    let disposed = false;
    // A condition that persists across loads must not reload the page forever.
    const reload = () => {
      if (!disposed && !reloadOnce(`spaces:live:${props.spaceId}`)) setUnavailable(true);
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
        if (disposed) return;
        if (message.payload.spaceId && message.payload.spaceId !== props.spaceId) return;
        if (message.type === SPACE_LIVE_WS_TYPE.error && message.payload.code === "resync_required") {
          controls.terminate({ code: message.payload.code, message: message.payload.message });
          return;
        }
        if (message.type === SPACE_LIVE_WS_TYPE.ready) {
          void applyCursor(["view", "detail", "wormholes"], message.payload.cursor, null);
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
      invalidate: (domains, cursor, itemId) => (disposed ? Promise.resolve() : invalidateSpacesData(domains, cursor, itemId)),
      markApplied: (cursor) => {
        if (!disposed) connection.markApplied(cursor);
      },
      onFailure: reload,
    });

    connection.connect();
    onCleanup(() => {
      disposed = true;
      connection.dispose();
    });
  });

  return (
    <Show when={unavailable()}>
      <div class="mb-[var(--ui-space-shell)] shrink-0" role="status">
        <NoticeCard tone="neutral" icon="ti ti-refresh" title={t.liveUpdatesUnavailable}>
          <Button variant="secondary" class="mt-3" onClick={() => window.location.reload()}>
            {t.reload}
          </Button>
        </NoticeCard>
      </div>
    </Show>
  );
}
