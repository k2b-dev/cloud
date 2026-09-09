import { createLiveWebSocket } from "@k2b/cloud/browser/live";
import { gridsWorkspace, isGridsStreamCursor } from "../../../lib/workspace-events";
import type { LiveRecordEvent } from "./live-refresh";
import { isLiveRecordEventForTable, isTerminalLiveErrorCode } from "./live-refresh";
import { recordsViewMessages } from "./messages";

type LiveProviderError = {
  code: string;
  message: string;
};

type GridsRecordEventsProviderOptions = {
  tableId: string;
  initialCursor?: string | null;
  locale?: string;
  onReady?: () => void;
  onEvent?: (event: LiveRecordEvent | null, cursor: string | null) => void;
  onError?: (error: LiveProviderError) => void;
  onRevoked?: (error: LiveProviderError) => void;
  onFatal?: (error: LiveProviderError) => void;
};

type ProviderMessage = {
  type?: unknown;
  payload?: unknown;
};

const parseJsonMessage = (raw: string): ProviderMessage | null => {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as ProviderMessage) : null;
  } catch {
    return null;
  }
};

const errorFromPayload = (payload: unknown, fallback: LiveProviderError): LiveProviderError => {
  if (!payload || typeof payload !== "object") return fallback;
  const value = payload as { code?: unknown; message?: unknown };
  return {
    code: typeof value.code === "string" ? value.code : fallback.code,
    message: typeof value.message === "string" ? value.message : fallback.message,
  };
};

export const createGridsRecordEventsProvider = (opts: GridsRecordEventsProviderOptions) => {
  const { t } = recordsViewMessages.resolve([opts.locale ?? "en"]);
  let revoked = false;

  return createLiveWebSocket<ProviderMessage>({
    url: "/api/grids/ws",
    initialCursor: isGridsStreamCursor(opts.initialCursor) ? opts.initialCursor : null,
    activity: "visible",
    subscribe: (cursor) => ({
      type: gridsWorkspace.wsType.recordsSubscribe,
      payload: {
        tableId: opts.tableId,
        fromCursor: cursor,
      },
    }),
    parse: parseJsonMessage,
    onMessage: (message, controls) => {
      if (message.type === gridsWorkspace.wsType.recordsReady) {
        const payload = message.payload as { tableId?: unknown; cursor?: unknown } | undefined;
        if (payload?.tableId !== opts.tableId) return;
        opts.onReady?.();
        controls.markApplied(isGridsStreamCursor(payload.cursor) ? payload.cursor : null);
        return;
      }

      if (message.type === gridsWorkspace.wsType.recordsRevoked) {
        const error = errorFromPayload(message.payload, { code: "access_denied", message: t.accessChanged });
        revoked = true;
        try {
          opts.onRevoked?.(error);
        } finally {
          controls.terminate(error);
        }
        return;
      }

      if (message.type === gridsWorkspace.wsType.recordsError) {
        const error = errorFromPayload(message.payload, { code: "internal_error", message: t.liveUnavailable });
        if (error.code === "resync_required") controls.resetCursor();
        if (isTerminalLiveErrorCode(error.code)) controls.terminate(error);
        else opts.onError?.(error);
        return;
      }

      if (message.type !== gridsWorkspace.wsType.recordsEvent || !message.payload || typeof message.payload !== "object") return;
      const payload = message.payload as { tableId?: unknown; cursor?: unknown; event?: unknown };
      const cursor = isGridsStreamCursor(payload.cursor) ? payload.cursor : null;
      if (payload.tableId === opts.tableId && payload.event === undefined) {
        opts.onEvent?.(null, cursor);
        return;
      }
      if (!isLiveRecordEventForTable(payload.event, opts.tableId)) return;
      opts.onEvent?.(payload.event, cursor);
    },
    onFatal: (error) => {
      if (!revoked) opts.onFatal?.(error);
    },
  });
};
