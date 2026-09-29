import { reloadOnce } from "@k2b/cloud/browser/reload";
import { toast, useLocale } from "@k2b/ui";
import { onCleanup, onMount } from "solid-js";
import { notebooksWorkspace, type PublicNotebookWorkspaceEvent } from "../../../../lib/workspace-events";
import { RECONNECT_HEALTHY_AFTER_MS, reconnectDelayMs } from "../../../lib/reconnect";
import { notebookWorkspaceMessages } from "../../messages";
import { dispatchWorkspaceEvent } from "./workspace-events";

type Props = {
  notebookId: string;
  appUrl: string;
  initialCursor: string | null;
};

const resolveHttpBaseUrl = (raw: string): URL => {
  const value = raw.trim();
  const browserOrigin = typeof window !== "undefined" && window.location?.origin ? window.location.origin : "http://localhost:3000";
  if (!value) return new URL(browserOrigin);
  if (/^https?:\/\//i.test(value)) return new URL(value);
  if (value.startsWith("/")) return new URL(value, browserOrigin);
  return new URL(`${new URL(browserOrigin).protocol}//${value}`);
};

const SIGN_IN_CODES = new Set(["LOGIN_REQUIRED", "SESSION_EXPIRED"]);
const TERMINAL_CODES = new Set([...SIGN_IN_CODES, "ACCESS_DENIED", "ACCESS_REVOKED", "NOTE_NOT_FOUND"]);

export default function WorkspaceEventBridge(props: Props) {
  const locale = useLocale();
  const t = () => notebookWorkspaceMessages.resolve([locale()]).t;

  onMount(() => {
    let disposed = false;
    let socket: WebSocket | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let failedConnects = 0;
    let lastCursor = props.initialCursor;
    let eventQueue = Promise.resolve();
    let generation = 0;
    let activeWorkspaceId = props.notebookId;

    // Reloading lets the page's route policy send an expired session to
    // sign-in. A failure that survives the reload (for example a live origin
    // that does not receive the session cookie) must not reload in a loop.
    const terminateAndRefresh = (code?: unknown) => {
      if (disposed) return;
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
      if (reloadOnce(`notebooks:live:${props.notebookId}`)) return;
      const returnTo = `${window.location.pathname}${window.location.search}`;
      if (typeof code === "string" && SIGN_IN_CODES.has(code)) {
        toast(t().liveSignInRequired, {
          duration: 0,
          action: { label: t().signIn, href: `/auth/login?redirectTo=${encodeURIComponent(returnTo)}` },
        });
      } else {
        toast(t().liveUpdatesStopped, { duration: 0, action: { label: t().reload, onClick: () => window.location.reload() } });
      }
    };

    const connect = () => {
      if (disposed) return;
      generation += 1;
      const socketGeneration = generation;
      eventQueue = Promise.resolve();
      const wsUrl = new URL("/api/notebooks/ws", resolveHttpBaseUrl(props.appUrl));
      wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(wsUrl.href);
      socket = ws;
      // The server confirms a subscription before it reads the event stream,
      // so only a subscription that stayed up resets the backoff.
      let readyAt: number | undefined;

      ws.onopen = () => {
        ws.send(
          JSON.stringify({
            type: notebooksWorkspace.wsType.subscribe,
            payload: { notebookId: props.notebookId, fromCursor: lastCursor },
          }),
        );
      };

      ws.onmessage = (message) => {
        if (typeof message.data !== "string") return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(message.data);
        } catch {
          return;
        }
        const value = parsed as {
          type?: unknown;
          payload?: { notebookId?: unknown; cursor?: unknown; event?: unknown; code?: unknown };
        };
        if (value.type === notebooksWorkspace.wsType.revoked) {
          terminateAndRefresh(value.payload?.code);
          return;
        }
        if (value.type === notebooksWorkspace.wsType.error) {
          const code = value.payload?.code;
          if (typeof code === "string" && TERMINAL_CODES.has(code)) terminateAndRefresh(code);
          else ws.close();
          return;
        }
        if (value.type === notebooksWorkspace.wsType.ready) {
          readyAt = Date.now();
          if (typeof value.payload?.notebookId === "string") activeWorkspaceId = value.payload.notebookId;
          return;
        }
        if (value.type !== notebooksWorkspace.wsType.event) return;
        if (value.payload?.notebookId !== activeWorkspaceId) return;
        const event = value.payload?.event as PublicNotebookWorkspaceEvent | undefined;
        if (!event || event.v !== 1 || event.notebookId !== activeWorkspaceId) return;
        const cursor = typeof value.payload?.cursor === "string" ? value.payload.cursor : null;
        eventQueue = eventQueue
          .then(async () => {
            if (disposed || socketGeneration !== generation) return;
            await dispatchWorkspaceEvent(event, cursor);
            if (socketGeneration === generation && cursor) lastCursor = cursor;
          })
          .catch(() => {
            if (!disposed && socketGeneration === generation) ws.close();
          });
      };

      ws.onclose = (event) => {
        if (socket === ws) socket = undefined;
        if (disposed) return;
        if (event.code === 1008) {
          terminateAndRefresh(event.reason);
          return;
        }
        if (readyAt !== undefined && Date.now() - readyAt >= RECONNECT_HEALTHY_AFTER_MS) failedConnects = 0;
        reconnectTimer = setTimeout(connect, reconnectDelayMs(failedConnects));
        failedConnects += 1;
      };

      ws.onerror = () => ws.close();
    };

    connect();
    onCleanup(() => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
    });
  });

  return null;
}
