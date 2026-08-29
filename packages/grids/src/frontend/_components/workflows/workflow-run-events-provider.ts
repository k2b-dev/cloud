import { createLiveWebSocket } from "@valentinkolb/cloud/browser/live";
import { gridsWorkspace, isGridsStreamCursor } from "../../../lib/workspace-events";
import { workflowMessages } from "./messages";
import type { PublicWorkflowRunEvent } from "./workflow-run-public-event";

type ProviderError = { code: string; message: string };

type WorkflowRunEventsProviderOptions = {
  workflowId: string;
  locale?: string;
  onReady?: () => void;
  onEvent?: (event: PublicWorkflowRunEvent, cursor: string | null) => void;
  onError?: (error: ProviderError) => void;
  onRevoked?: (error: ProviderError) => void;
  onFatal?: (error: ProviderError) => void;
};

type ProviderMessage = {
  type?: unknown;
  payload?: unknown;
};

const TERMINAL_ERROR_CODES = new Set(["login_required", "access_denied", "not_found"]);

export const isTerminalWorkflowRunLiveErrorCode = (code: unknown): code is string =>
  typeof code === "string" && TERMINAL_ERROR_CODES.has(code);

const parseMessage = (raw: string): ProviderMessage | null => {
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === "object" ? (value as ProviderMessage) : null;
  } catch {
    return null;
  }
};

const parseError = (payload: unknown, fallback: ProviderError): ProviderError => {
  if (!payload || typeof payload !== "object") return fallback;
  const value = payload as { code?: unknown; message?: unknown };
  return {
    code: typeof value.code === "string" ? value.code : fallback.code,
    message: typeof value.message === "string" ? value.message : fallback.message,
  };
};

export const createWorkflowRunEventsProvider = (options: WorkflowRunEventsProviderOptions) => {
  const t = workflowMessages.resolve([options.locale ?? "en"]).t;
  let revoked = false;

  return createLiveWebSocket<ProviderMessage>({
    url: "/api/grids/ws",
    activity: "visible",
    subscribe: (cursor) => ({
      type: gridsWorkspace.wsType.workflowRunsSubscribe,
      payload: {
        workflowId: options.workflowId,
        fromCursor: cursor,
      },
    }),
    parse: parseMessage,
    onMessage: (message, controls) => {
      if (message.type === gridsWorkspace.wsType.workflowRunsReady) {
        const payload = message.payload as { workflowId?: unknown; cursor?: unknown } | undefined;
        if (payload?.workflowId !== options.workflowId) return;
        options.onReady?.();
        controls.markApplied(isGridsStreamCursor(payload.cursor) ? payload.cursor : null);
        return;
      }
      if (message.type === gridsWorkspace.wsType.workflowRunsRevoked) {
        const error = parseError(message.payload, { code: "access_denied", message: t.workflowAccessRevoked });
        revoked = true;
        try {
          options.onRevoked?.(error);
        } finally {
          controls.terminate(error);
        }
        return;
      }
      if (message.type === gridsWorkspace.wsType.workflowRunsError) {
        const error = parseError(message.payload, { code: "stream_failed", message: t.workflowUpdatesFailed });
        if (isTerminalWorkflowRunLiveErrorCode(error.code)) controls.terminate(error);
        else options.onError?.(error);
        return;
      }
      if (message.type !== gridsWorkspace.wsType.workflowRunsEvent || !message.payload || typeof message.payload !== "object") return;
      const payload = message.payload as { cursor?: unknown; event?: unknown };
      if (!payload.event || typeof payload.event !== "object") return;
      const event = payload.event as PublicWorkflowRunEvent;
      if (event.v !== 1 || event.workflowId !== options.workflowId || !event.run || event.run.workflowId !== options.workflowId) return;
      const cursor = isGridsStreamCursor(payload.cursor) ? payload.cursor : null;
      options.onEvent?.(event, cursor);
      controls.markApplied(cursor);
    },
    onFatal: (error) => {
      if (!revoked) options.onFatal?.(error);
    },
  });
};
