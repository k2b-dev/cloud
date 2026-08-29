import type { User } from "@valentinkolb/cloud/contracts";
import { auth, getLocale } from "@valentinkolb/cloud/server";
import { accounts, logger } from "@valentinkolb/cloud/services";
import type { ServerWebSocket } from "bun";
import { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import { z } from "zod";
import { ShortIdSchema } from "./contracts";
import type { GridsWorkflowRunEvent } from "./lib/workflow-run-events";
import { gridsWorkspace } from "./lib/workspace-events";
import { gridsService } from "./service";
import { latestMetadataEventCursor, liveMetadataEvents, toPublicMetadataEvent } from "./service/metadata-events";
import { projectPublicId, projectPublicIds, resolvePublicId } from "./service/public-resources";
import { latestRecordEventCursor, liveRecordEvents, toPublicRecordEvent } from "./service/record-events";
import { latestWorkflowRunEventCursor, liveWorkflowRunEvents } from "./service/workflow-run-events";
import { gridsWebSocketMessages } from "./ws-messages";

const log = logger("grids:ws");
const WS_TYPE = gridsWorkspace.wsType;
const ACCESS_REFRESH_INTERVAL_MS = 15_000;
const MAX_CLIENT_MESSAGE_LENGTH = 16_000;
const MAX_PENDING_MESSAGES = 8;
const CLOSE_SERVICE_RESTART = 1012;

const SubscribeMessageSchema = z.object({
  type: z.literal(WS_TYPE.recordsSubscribe),
  payload: z.object({
    tableId: ShortIdSchema,
    sessionToken: z.string().min(1).optional(),
    fromCursor: z.string().regex(gridsWorkspace.streamCursorPattern).nullable().optional(),
  }),
});

const SubscribeMetadataMessageSchema = z.object({
  type: z.literal(WS_TYPE.metadataSubscribe),
  payload: z.object({
    baseId: ShortIdSchema,
    sessionToken: z.string().min(1).optional(),
    fromCursor: z.string().regex(gridsWorkspace.streamCursorPattern).nullable().optional(),
  }),
});

const SubscribeWorkflowRunsMessageSchema = z.object({
  type: z.literal(WS_TYPE.workflowRunsSubscribe),
  payload: z.object({
    workflowId: ShortIdSchema,
    sessionToken: z.string().min(1).optional(),
    fromCursor: z.string().regex(gridsWorkspace.streamCursorPattern).nullable().optional(),
  }),
});

const ClientMessageSchema = z.union([SubscribeMessageSchema, SubscribeMetadataMessageSchema, SubscribeWorkflowRunsMessageSchema]);
type WsPhase = "open" | "subscribed" | "closing";
type Subscription =
  | { kind: "records"; baseId: string; tableId: string; publicBaseId: string; publicTableId: string }
  | { kind: "metadata"; baseId: string; publicBaseId: string }
  | { kind: "workflow-runs"; baseId: string; workflowId: string; publicBaseId: string; publicWorkflowId: string };

type WsContext = {
  socket: ServerWebSocket<unknown>;
  phase: WsPhase;
  sessionToken: string | null;
  subscription: Subscription | null;
  streamAbort: AbortController | null;
  accessRefreshTimeout: ReturnType<typeof setTimeout> | null;
  locale: string;
};

type AccessResult =
  | {
      ok: true;
      baseId: string;
      tableId?: string;
      workflowId?: string;
    }
  | { ok: false; code: string; message: string; tableId?: string };

type WorkspaceRuntime = {
  resolvePublicId: typeof resolvePublicId;
  projectPublicId: typeof projectPublicId;
  projectRecordEvent: typeof toPublicRecordEvent;
  projectMetadataEvent: typeof toPublicMetadataEvent;
  projectWorkflowRunEvent: typeof toPublicWorkflowRunEvent;
  evaluateRecordsAccess: (tableId: string, sessionToken: string | null, locale: string) => Promise<AccessResult>;
  evaluateBaseAccess: (baseId: string, sessionToken: string | null, locale: string) => Promise<AccessResult>;
  evaluateWorkflowAccess: (workflowId: string, sessionToken: string | null, locale: string) => Promise<AccessResult>;
  evaluateSubscriptionAccess: (subscription: Subscription, sessionToken: string | null, locale: string) => Promise<AccessResult>;
  latestRecordCursor: typeof latestRecordEventCursor;
  latestMetadataCursor: typeof latestMetadataEventCursor;
  latestWorkflowRunCursor: typeof latestWorkflowRunEventCursor;
  recordEvents: typeof liveRecordEvents;
  metadataEvents: typeof liveMetadataEvents;
  workflowRunEvents: typeof liveWorkflowRunEvents;
  schedule: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  cancel: (timeout: ReturnType<typeof setTimeout>) => void;
};

const createContext = (socket: ServerWebSocket<unknown>, sessionToken: string | null, locale: string): WsContext => ({
  socket,
  phase: "open",
  sessionToken,
  subscription: null,
  streamAbort: null,
  accessRefreshTimeout: null,
  locale,
});

const messages = (locale: string) => gridsWebSocketMessages.resolve([locale]).t;

export const sendWorkspaceMessage = (socket: ServerWebSocket<unknown>, type: string, payload?: unknown): boolean => {
  try {
    return socket.send(JSON.stringify({ type, payload })) > 0;
  } catch {
    // Closed sockets are normal during tab/navigation churn.
    return false;
  }
};

const send = sendWorkspaceMessage;

const toPublicWorkflowRunEvent = async (event: GridsWorkflowRunEvent) => {
  const workflowInternalIds = [event.workflowId, event.run.workflowId].filter((id): id is string => Boolean(id));
  const launcherInternalIds = event.run.launcherId ? [event.run.launcherId] : [];
  const [bases, workflows, runs, launchers] = await Promise.all([
    projectPublicIds("base", [event.baseId, event.run.baseId]),
    projectPublicIds("workflow", workflowInternalIds),
    projectPublicIds("workflowRun", [event.run.id]),
    projectPublicIds("workflowLauncher", launcherInternalIds),
  ]);
  const required = (ids: ReadonlyMap<string, string>, id: string, resource: string) => {
    const publicId = ids.get(id);
    if (!publicId) throw new Error(`Missing public ID for ${resource}`);
    return publicId;
  };
  const runId = required(runs, event.run.id, "workflow run");
  return {
    ...event,
    baseId: required(bases, event.baseId, "base"),
    workflowId: event.workflowId ? required(workflows, event.workflowId, "workflow") : null,
    run: {
      ...event.run,
      id: runId,
      baseId: required(bases, event.run.baseId, "base"),
      workflowId: event.run.workflowId ? required(workflows, event.run.workflowId, "workflow") : null,
      launcherId: event.run.launcherId ? required(launchers, event.run.launcherId, "workflow launcher") : null,
    },
    steps: event.steps.map((step) => ({ ...step, runId })),
  };
};

const isClosing = (ctx: Pick<WsContext, "phase">): boolean => ctx.phase === "closing";

const errorTypeFor = (ctx: WsContext): string =>
  ctx.subscription?.kind === "metadata"
    ? WS_TYPE.metadataError
    : ctx.subscription?.kind === "workflow-runs"
      ? WS_TYPE.workflowRunsError
      : WS_TYPE.recordsError;

const stopStream = (ctx: WsContext) => {
  if (ctx.streamAbort) ctx.streamAbort.abort();
  ctx.streamAbort = null;
};

const stopAccessRefresh = (ctx: WsContext, runtime: WorkspaceRuntime) => {
  if (ctx.accessRefreshTimeout) runtime.cancel(ctx.accessRefreshTimeout);
  ctx.accessRefreshTimeout = null;
};

const stopSubscription = (ctx: WsContext, runtime: WorkspaceRuntime) => {
  stopAccessRefresh(ctx, runtime);
  stopStream(ctx);
  ctx.subscription = null;
};

export const isWorkspaceAccessRefreshCurrent = (
  ctx: Pick<WsContext, "phase" | "sessionToken" | "subscription">,
  subscription: Subscription,
  sessionToken: string,
): boolean => ctx.phase === "subscribed" && ctx.subscription === subscription && ctx.sessionToken === sessionToken;

export const workspaceCloseCodeForError = (code: string): number => {
  if (code === "internal_error") return 1011;
  if (code === "backpressure" || code === "stream_failed" || code === "stream_ended") return CLOSE_SERVICE_RESTART;
  return 1008;
};

const closeWithError = (
  ctx: WsContext,
  runtime: WorkspaceRuntime,
  code: string,
  message: string,
  tableId?: string,
  errorType = errorTypeFor(ctx),
) => {
  if (ctx.phase === "closing") return;
  const publicTableId = ctx.subscription?.kind === "records" ? ctx.subscription.publicTableId : tableId;
  ctx.phase = "closing";
  stopSubscription(ctx, runtime);
  send(ctx.socket, errorType, { code, message, tableId: publicTableId });
  ctx.socket.close(workspaceCloseCodeForError(code), code);
};

const revokeAccess = (
  ctx: WsContext,
  runtime: WorkspaceRuntime,
  subscription: Subscription,
  access: Exclude<AccessResult, { ok: true }>,
) => {
  if (isClosing(ctx)) return;
  ctx.phase = "closing";
  stopSubscription(ctx, runtime);
  send(
    ctx.socket,
    subscription.kind === "records"
      ? WS_TYPE.recordsRevoked
      : subscription.kind === "metadata"
        ? WS_TYPE.metadataRevoked
        : WS_TYPE.workflowRunsRevoked,
    {
      code: access.code,
      message: access.code === "access_denied" ? messages(ctx.locale).accessRevoked : access.message,
      baseId: subscription.publicBaseId,
      tableId: subscription.kind === "records" ? subscription.publicTableId : undefined,
    },
  );
  ctx.socket.close(1008, access.code);
};

const resolveSessionUser = async (sessionToken: string | null): Promise<User | null> => {
  if (!sessionToken) return null;
  const session = await auth.session.getData(sessionToken);
  if (!session) return null;
  return accounts.users.get({ id: session.userId });
};

const evaluateTableAccess = async (tableId: string, sessionToken: string | null, locale: string): Promise<AccessResult> => {
  const t = messages(locale);
  const user = await resolveSessionUser(sessionToken);
  if (!user) return { ok: false, code: "login_required", message: t.loginRequired, tableId };

  const table = await gridsService.table.get(tableId);
  if (!table) return { ok: false, code: "not_found", message: t.tableNotFound, tableId };

  const grants = await gridsService.permission.loadBaseGrantsForSubject({
    subject: { type: "user", userId: user.id },
    baseId: table.baseId,
  });
  if (!gridsService.permission.hasAtLeast(gridsService.permission.resolve(grants, { baseId: table.baseId }), "read")) {
    return { ok: false, code: "access_denied", message: t.accessDenied, tableId: table.id };
  }

  return {
    ok: true,
    baseId: table.baseId,
    tableId: table.id,
  };
};

const evaluateBaseAccess = async (baseId: string, sessionToken: string | null, locale: string): Promise<AccessResult> => {
  const t = messages(locale);
  const user = await resolveSessionUser(sessionToken);
  if (!user) return { ok: false, code: "login_required", message: t.loginRequired };

  const base = await gridsService.base.get(baseId);
  if (!base) return { ok: false, code: "not_found", message: t.baseNotFound };

  const grants = await gridsService.permission.loadBaseGrantsForSubject({
    subject: { type: "user", userId: user.id },
    baseId: base.id,
  });
  const level = gridsService.permission.resolve(grants, { baseId: base.id });
  if (!gridsService.permission.hasAtLeast(level, "read")) {
    return { ok: false, code: "access_denied", message: t.accessDenied };
  }

  return { ok: true, baseId: base.id };
};

const evaluateWorkflowAccess = async (workflowId: string, sessionToken: string | null, locale: string): Promise<AccessResult> => {
  const t = messages(locale);
  const user = await resolveSessionUser(sessionToken);
  if (!user) return { ok: false, code: "login_required", message: t.loginRequired };

  const workflow = await gridsService.workflow.get(workflowId);
  if (!workflow) return { ok: false, code: "not_found", message: t.workflowNotFound };

  const grants = await gridsService.permission.loadBaseGrantsForSubject({
    subject: { type: "user", userId: user.id },
    baseId: workflow.baseId,
  });
  const level = gridsService.permission.resolve(grants, { baseId: workflow.baseId });
  if (!gridsService.permission.hasAtLeast(level, "read")) {
    return { ok: false, code: "access_denied", message: t.accessDenied };
  }

  return { ok: true, baseId: workflow.baseId, workflowId: workflow.id };
};

const evaluateSubscriptionAccess = (subscription: Subscription, sessionToken: string | null, locale: string): Promise<AccessResult> =>
  subscription.kind === "records"
    ? evaluateTableAccess(subscription.tableId, sessionToken, locale)
    : subscription.kind === "metadata"
      ? evaluateBaseAccess(subscription.baseId, sessionToken, locale)
      : evaluateWorkflowAccess(subscription.workflowId, sessionToken, locale);

const workspaceRuntime: WorkspaceRuntime = {
  resolvePublicId,
  projectPublicId,
  projectRecordEvent: toPublicRecordEvent,
  projectMetadataEvent: toPublicMetadataEvent,
  projectWorkflowRunEvent: toPublicWorkflowRunEvent,
  evaluateRecordsAccess: evaluateTableAccess,
  evaluateBaseAccess,
  evaluateWorkflowAccess,
  evaluateSubscriptionAccess,
  latestRecordCursor: latestRecordEventCursor,
  latestMetadataCursor: latestMetadataEventCursor,
  latestWorkflowRunCursor: latestWorkflowRunEventCursor,
  recordEvents: liveRecordEvents,
  metadataEvents: liveMetadataEvents,
  workflowRunEvents: liveWorkflowRunEvents,
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  cancel: (timeout) => clearTimeout(timeout),
};

const ensureCurrentAccess = async (
  ctx: WsContext,
  runtime: WorkspaceRuntime,
  subscription: Subscription,
): Promise<Extract<AccessResult, { ok: true }> | null> => {
  const access = await runtime.evaluateSubscriptionAccess(subscription, ctx.sessionToken, ctx.locale);
  if (ctx.phase !== "subscribed" || ctx.subscription !== subscription) return null;
  if (access.ok) return access;
  revokeAccess(ctx, runtime, subscription, access);
  return null;
};

const startStream = (ctx: WsContext, runtime: WorkspaceRuntime, afterCursor: string | null) => {
  stopStream(ctx);
  const subscription = ctx.subscription;
  if (!subscription) return;

  const baseId = subscription.baseId;
  const abort = new AbortController();
  ctx.streamAbort = abort;

  void (async () => {
    try {
      if (subscription.kind === "records") {
        const tableId = subscription.tableId;
        for await (const event of runtime.recordEvents({ baseId, after: afterCursor, signal: abort.signal })) {
          if (abort.signal.aborted || ctx.phase !== "subscribed" || ctx.subscription !== subscription) break;
          if (event.data.tableId !== tableId) continue;
          const access = await ensureCurrentAccess(ctx, runtime, subscription);
          if (!access) break;
          const sent = send(ctx.socket, WS_TYPE.recordsEvent, {
            tableId: subscription.publicTableId,
            cursor: event.cursor,
            event: await runtime.projectRecordEvent(event.data),
          });
          if (!sent) {
            closeWithError(ctx, runtime, "backpressure", messages(ctx.locale).liveCapacityExceeded, tableId);
            break;
          }
        }
      } else if (subscription.kind === "metadata") {
        for await (const event of runtime.metadataEvents({ baseId, after: afterCursor, signal: abort.signal })) {
          if (abort.signal.aborted || ctx.phase !== "subscribed" || ctx.subscription !== subscription) break;
          if (!(await ensureCurrentAccess(ctx, runtime, subscription))) break;
          const sent = send(ctx.socket, WS_TYPE.metadataEvent, {
            baseId: subscription.publicBaseId,
            cursor: event.cursor,
            event: await runtime.projectMetadataEvent(event.data),
          });
          if (!sent) {
            closeWithError(ctx, runtime, "backpressure", messages(ctx.locale).liveCapacityExceeded);
            break;
          }
        }
      } else {
        const workflowId = subscription.workflowId;
        for await (const event of runtime.workflowRunEvents({ baseId, workflowId, after: afterCursor, signal: abort.signal })) {
          if (abort.signal.aborted || ctx.phase !== "subscribed" || ctx.subscription !== subscription) break;
          if (!(await ensureCurrentAccess(ctx, runtime, subscription))) break;
          const sent = send(ctx.socket, WS_TYPE.workflowRunsEvent, {
            workflowId: subscription.publicWorkflowId,
            cursor: event.cursor,
            event: await runtime.projectWorkflowRunEvent(event.data),
          });
          if (!sent) {
            closeWithError(ctx, runtime, "backpressure", messages(ctx.locale).workflowCapacityExceeded);
            break;
          }
        }
      }

      if (!abort.signal.aborted && ctx.phase === "subscribed" && ctx.subscription === subscription) {
        closeWithError(
          ctx,
          runtime,
          "stream_ended",
          subscription.kind === "workflow-runs" ? messages(ctx.locale).workflowStreamEnded : messages(ctx.locale).workspaceStreamEnded,
          subscription.kind === "records" ? subscription.tableId : undefined,
        );
      }
    } catch (error) {
      if (abort.signal.aborted || isClosing(ctx)) return;
      log.error("Workspace event stream failed", {
        baseId,
        kind: subscription.kind,
        error: error instanceof Error ? error.message : String(error),
      });
      closeWithError(
        ctx,
        runtime,
        "stream_failed",
        messages(ctx.locale).workspaceStreamFailed,
        subscription.kind === "records" ? subscription.tableId : undefined,
      );
    } finally {
      if (ctx.streamAbort === abort) ctx.streamAbort = null;
    }
  })();
};

const startAccessRefresh = (ctx: WsContext, runtime: WorkspaceRuntime) => {
  stopAccessRefresh(ctx, runtime);
  if (ctx.phase !== "subscribed" || !ctx.subscription || !ctx.sessionToken) return;

  ctx.accessRefreshTimeout = runtime.schedule(async () => {
    if (ctx.phase !== "subscribed" || !ctx.subscription || !ctx.sessionToken) return;
    const subscription = ctx.subscription;
    const sessionToken = ctx.sessionToken;
    try {
      const access = await runtime.evaluateSubscriptionAccess(subscription, sessionToken, ctx.locale);
      if (!isWorkspaceAccessRefreshCurrent(ctx, subscription, sessionToken)) return;
      if (!access.ok) {
        revokeAccess(ctx, runtime, subscription, access);
        return;
      }
      startAccessRefresh(ctx, runtime);
    } catch (error) {
      if (!isWorkspaceAccessRefreshCurrent(ctx, subscription, sessionToken)) return;
      log.error("Workspace stream access refresh failed", {
        subscription,
        error: error instanceof Error ? error.message : String(error),
      });
      closeWithError(
        ctx,
        runtime,
        "internal_error",
        messages(ctx.locale).accessRefreshFailed,
        subscription.kind === "records" ? subscription.tableId : undefined,
      );
    }
  }, ACCESS_REFRESH_INTERVAL_MS);
};

export const resolveWorkspaceEventCursor = async (
  fromCursor: string | null | undefined,
  latestCursor: () => Promise<string | null>,
): Promise<string> => fromCursor ?? (await latestCursor()) ?? "0-0";

const resolveSubscriptionCursor = async (
  ctx: WsContext,
  runtime: WorkspaceRuntime,
  fromCursor: string | null | undefined,
  latestCursor: () => Promise<string | null>,
): Promise<string | null> => {
  try {
    return await resolveWorkspaceEventCursor(fromCursor, latestCursor);
  } catch (error) {
    if (isClosing(ctx)) return null;
    log.error("Workspace event cursor resolution failed", {
      subscription: ctx.subscription,
      error: error instanceof Error ? error.message : String(error),
    });
    closeWithError(
      ctx,
      runtime,
      "stream_failed",
      messages(ctx.locale).workspaceStreamFailed,
      ctx.subscription?.kind === "records" ? ctx.subscription.tableId : undefined,
    );
    return null;
  }
};

const handleSubscribe = async (
  ctx: WsContext,
  runtime: WorkspaceRuntime,
  payload: z.infer<typeof SubscribeMessageSchema.shape.payload>,
) => {
  if (isClosing(ctx)) return;
  const sessionToken = payload.sessionToken ?? ctx.sessionToken;
  const tableId = await runtime.resolvePublicId("table", payload.tableId);
  if (!tableId) {
    closeWithError(ctx, runtime, "not_found", messages(ctx.locale).tableNotFound, payload.tableId);
    return;
  }
  const access = await runtime.evaluateRecordsAccess(tableId, sessionToken, ctx.locale);
  if (isClosing(ctx)) return;
  if (!access.ok || !access.tableId) {
    if (access.ok) {
      closeWithError(ctx, runtime, "not_found", messages(ctx.locale).tableNotFound, payload.tableId);
      return;
    }
    closeWithError(ctx, runtime, access.code, access.message, payload.tableId);
    return;
  }

  const publicBaseId = await runtime.projectPublicId("base", access.baseId);
  if (!publicBaseId) {
    closeWithError(ctx, runtime, "not_found", messages(ctx.locale).baseNotFound, payload.tableId);
    return;
  }

  const subscription: Subscription = {
    kind: "records",
    baseId: access.baseId,
    tableId: access.tableId,
    publicBaseId,
    publicTableId: payload.tableId,
  };
  stopSubscription(ctx, runtime);
  ctx.phase = "subscribed";
  ctx.sessionToken = sessionToken;
  ctx.subscription = subscription;
  const baselineCursor = await resolveSubscriptionCursor(ctx, runtime, payload.fromCursor, () => runtime.latestRecordCursor(access.baseId));
  if (!baselineCursor) return;
  if (isClosing(ctx) || ctx.subscription !== subscription) return;
  if (!send(ctx.socket, WS_TYPE.recordsReady, { tableId: payload.tableId, cursor: baselineCursor })) {
    closeWithError(ctx, runtime, "backpressure", messages(ctx.locale).liveCapacityExceeded, access.tableId);
    return;
  }
  startStream(ctx, runtime, baselineCursor);
  startAccessRefresh(ctx, runtime);
};

const handleMetadataSubscribe = async (
  ctx: WsContext,
  runtime: WorkspaceRuntime,
  payload: z.infer<typeof SubscribeMetadataMessageSchema.shape.payload>,
) => {
  if (isClosing(ctx)) return;
  const sessionToken = payload.sessionToken ?? ctx.sessionToken;
  const baseId = await runtime.resolvePublicId("base", payload.baseId);
  if (!baseId) {
    closeWithError(ctx, runtime, "not_found", messages(ctx.locale).baseNotFound, undefined, WS_TYPE.metadataError);
    return;
  }
  const access = await runtime.evaluateBaseAccess(baseId, sessionToken, ctx.locale);
  if (isClosing(ctx)) return;
  if (!access.ok) {
    closeWithError(ctx, runtime, access.code, access.message, undefined, WS_TYPE.metadataError);
    return;
  }

  const subscription: Subscription = { kind: "metadata", baseId: access.baseId, publicBaseId: payload.baseId };
  stopSubscription(ctx, runtime);
  ctx.phase = "subscribed";
  ctx.sessionToken = sessionToken;
  ctx.subscription = subscription;
  const baselineCursor = await resolveSubscriptionCursor(ctx, runtime, payload.fromCursor, () =>
    runtime.latestMetadataCursor(access.baseId),
  );
  if (!baselineCursor) return;
  if (isClosing(ctx) || ctx.subscription !== subscription) return;
  if (!send(ctx.socket, WS_TYPE.metadataReady, { baseId: payload.baseId, cursor: baselineCursor })) {
    closeWithError(ctx, runtime, "backpressure", messages(ctx.locale).liveCapacityExceeded);
    return;
  }
  startStream(ctx, runtime, baselineCursor);
  startAccessRefresh(ctx, runtime);
};

const handleWorkflowRunsSubscribe = async (
  ctx: WsContext,
  runtime: WorkspaceRuntime,
  payload: z.infer<typeof SubscribeWorkflowRunsMessageSchema>["payload"],
) => {
  if (isClosing(ctx)) return;
  const sessionToken = payload.sessionToken ?? ctx.sessionToken;
  const workflowId = await runtime.resolvePublicId("workflow", payload.workflowId);
  if (!workflowId) {
    closeWithError(ctx, runtime, "not_found", messages(ctx.locale).workflowNotFound, undefined, WS_TYPE.workflowRunsError);
    return;
  }
  const access = await runtime.evaluateWorkflowAccess(workflowId, sessionToken, ctx.locale);
  if (isClosing(ctx)) return;
  if (!access.ok || !access.workflowId) {
    closeWithError(
      ctx,
      runtime,
      access.ok ? "not_found" : access.code,
      access.ok ? messages(ctx.locale).workflowNotFound : access.message,
      undefined,
      WS_TYPE.workflowRunsError,
    );
    return;
  }

  const publicBaseId = await runtime.projectPublicId("base", access.baseId);
  if (!publicBaseId) {
    closeWithError(ctx, runtime, "not_found", messages(ctx.locale).baseNotFound, undefined, WS_TYPE.workflowRunsError);
    return;
  }

  const subscription: Subscription = {
    kind: "workflow-runs",
    baseId: access.baseId,
    workflowId: access.workflowId,
    publicBaseId,
    publicWorkflowId: payload.workflowId,
  };
  stopSubscription(ctx, runtime);
  ctx.phase = "subscribed";
  ctx.sessionToken = sessionToken;
  ctx.subscription = subscription;
  const internalWorkflowId = access.workflowId;
  const baselineCursor = await resolveSubscriptionCursor(ctx, runtime, payload.fromCursor, () =>
    runtime.latestWorkflowRunCursor(access.baseId, internalWorkflowId),
  );
  if (!baselineCursor) return;
  if (isClosing(ctx) || ctx.subscription !== subscription) return;
  if (!send(ctx.socket, WS_TYPE.workflowRunsReady, { workflowId: payload.workflowId, cursor: baselineCursor })) {
    closeWithError(ctx, runtime, "backpressure", messages(ctx.locale).workflowCapacityExceeded);
    return;
  }
  startStream(ctx, runtime, baselineCursor);
  startAccessRefresh(ctx, runtime);
};

const handleClientMessage = async (ctx: WsContext, runtime: WorkspaceRuntime, raw: string): Promise<void> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    closeWithError(
      ctx,
      runtime,
      "invalid_json",
      messages(ctx.locale).invalidJson,
      ctx.subscription?.kind === "records" ? ctx.subscription.tableId : undefined,
    );
    return;
  }

  const message = ClientMessageSchema.safeParse(parsed);
  if (!message.success) {
    closeWithError(
      ctx,
      runtime,
      "invalid_message",
      messages(ctx.locale).invalidMessage,
      ctx.subscription?.kind === "records" ? ctx.subscription.tableId : undefined,
    );
    return;
  }

  if (message.data.type === WS_TYPE.recordsSubscribe) {
    await handleSubscribe(ctx, runtime, message.data.payload);
  } else if (message.data.type === WS_TYPE.metadataSubscribe) {
    await handleMetadataSubscribe(ctx, runtime, message.data.payload);
  } else if (message.data.type === WS_TYPE.workflowRunsSubscribe) {
    await handleWorkflowRunsSubscribe(ctx, runtime, message.data.payload);
  }
};

export const createWorkspaceWebSocketSession = (sessionToken: string | null, overrides: Partial<WorkspaceRuntime> = {}, locale = "en") => {
  const runtime = { ...workspaceRuntime, ...overrides };
  let ctx: WsContext | null = null;
  let processing: Promise<void> = Promise.resolve();
  let pendingMessages = 0;

  return {
    open(socket: ServerWebSocket<unknown>): void {
      ctx = createContext(socket, sessionToken, locale);
    },

    message(data: unknown): void {
      if (!ctx || ctx.phase === "closing") return;
      if (typeof data !== "string" || data.length > MAX_CLIENT_MESSAGE_LENGTH) {
        closeWithError(
          ctx,
          runtime,
          "invalid_message",
          messages(ctx.locale).invalidSubscription,
          ctx.subscription?.kind === "records" ? ctx.subscription.tableId : undefined,
        );
        return;
      }
      if (pendingMessages >= MAX_PENDING_MESSAGES) {
        closeWithError(
          ctx,
          runtime,
          "backpressure",
          messages(ctx.locale).tooManyPendingMessages,
          ctx.subscription?.kind === "records" ? ctx.subscription.tableId : undefined,
        );
        return;
      }

      pendingMessages++;
      const currentCtx = ctx;
      processing = processing
        .then(() => handleClientMessage(currentCtx, runtime, data))
        .catch((error) => {
          log.error("Websocket message handling failed", {
            subscription: currentCtx.subscription,
            error: error instanceof Error ? error.message : String(error),
          });
          closeWithError(
            currentCtx,
            runtime,
            "internal_error",
            messages(currentCtx.locale).messageHandlingFailed,
            currentCtx.subscription?.kind === "records" ? currentCtx.subscription.tableId : undefined,
          );
        })
        .finally(() => {
          pendingMessages = Math.max(0, pendingMessages - 1);
        });
    },

    async close(): Promise<void> {
      if (!ctx) return;
      ctx.phase = "closing";
      stopSubscription(ctx, runtime);
      await processing.catch(() => undefined);
    },

    drain(): Promise<void> {
      return processing;
    },
  };
};

const app = new Hono().get(
  "/",
  upgradeWebSocket((c) => {
    const session = createWorkspaceWebSocketSession(auth.session.getToken(c), {}, getLocale(c));

    return {
      onOpen(_, ws) {
        session.open(ws.raw as ServerWebSocket<unknown>);
      },

      onMessage(event) {
        session.message(event.data);
      },

      onClose() {
        return session.close();
      },
    };
  }),
);

export default app;
