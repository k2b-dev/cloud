import { createLiveWebSocket } from "@valentinkolb/cloud/browser/live";
import { onCleanup, onMount } from "solid-js";
import {
  parseSpaceLiveServerMessage,
  SPACE_LIVE_WS_TYPE,
  type SpaceLiveClientMessage,
  type SpaceLiveServerMessage,
} from "../../../../live-events";
import { createSpacesLiveCursorQueue, invalidateSpacesData } from "./workspace-events";

type Props = {
  spaceId: string;
  initialCursor: string | null;
};

export default function SpaceLiveEvents(props: Props) {
  onMount(() => {
    let disposed = false;
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
            window.location.reload();
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
      onFatal: () => {
        if (!disposed) window.location.reload();
      },
    });
    const applyCursor = createSpacesLiveCursorQueue({
      invalidate: (domains, cursor, itemId) => (disposed ? Promise.resolve() : invalidateSpacesData(domains, cursor, itemId)),
      markApplied: (cursor) => {
        if (!disposed) connection.markApplied(cursor);
      },
      onFailure: () => {
        if (!disposed) window.location.reload();
      },
    });

    connection.connect();
    onCleanup(() => {
      disposed = true;
      connection.dispose();
    });
  });

  return null;
}
