/**
 * Fleet view over the per-app sync ops surface.
 *
 * `sync.resources()`, dead-letter stores, and `scheduler.list()` are
 * process-local, so every app exposes them under `/_internal/sync` (see
 * `createSyncOpsRoutes` in `@valentinkolb/cloud/services`). This service walks
 * the live app registry, calls that surface on each app's internal base URL
 * through the Core invocation broker, and merges the answers. One
 * unreachable app degrades to a warning row; it never hides the others.
 */

import { err, fail, ok, type Result } from "@k2b/stdlib";
import type { SyncHealth, SyncResourceSummary } from "@k2b/sync";
import type { AppRegistryEntry } from "@valentinkolb/cloud/contracts";
import type { SyncDeadLetterEntry, SyncDeadLetterKind, SyncDeadLetterStoreView, SyncScheduleView } from "@valentinkolb/cloud/services";
import { get } from "@valentinkolb/cloud/services";
import { publicCloudOrigin } from "@valentinkolb/cloud/shared";
import { z } from "zod";

export const SYNC_OPS_PATH = "/_internal/sync";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** Source credentials are sent only to Core, which issues a target-bound invocation. */
export type SyncOpsCredentials = { cookie?: string | null; authorization?: string | null; requestId?: string | null };

export const syncOpsCredentials = (request: Request): SyncOpsCredentials => ({
  cookie: request.headers.get("cookie"),
  authorization: request.headers.get("authorization"),
  requestId: request.headers.get("x-request-id"),
});

export type SyncAppRow = {
  appId: string;
  appName: string;
  appIcon: string;
  status: "ok" | "unavailable";
  error: string | null;
  health: SyncHealth | null;
};

export type SyncDeadLetterRow = SyncDeadLetterEntry & {
  appId: string;
  appName: string;
  store: string;
  kind: SyncDeadLetterKind;
  description: string | null;
};

export type SyncResourceRow = SyncResourceSummary & { appId: string; appName: string; deadLetters: number | null };

export type SyncScheduleRow = SyncScheduleView & { appId: string; appName: string };

export type SyncOverview = {
  apps: SyncAppRow[];
  deadLetters: SyncDeadLetterRow[];
  /** `appId/store` names whose dead-letter page was cut at the limit. */
  truncatedStores: string[];
  resources: SyncResourceRow[];
  schedules: SyncScheduleRow[];
};

type ResourcesPayload = { health: SyncHealth; resources: SyncResourceSummary[] };
type DeadLettersPayload = { stores: SyncDeadLetterStoreView[] };
type SchedulesPayload = { schedules: SyncScheduleView[] };

// An invalid response must degrade only its app, including structurally invalid JSON.
const resourcesPayload: z.ZodType<ResourcesPayload> = z.object({
  health: z.object({
    state: z.enum(["starting", "ready", "degraded", "draining", "stopped"]),
    connection: z.enum(["connected", "reconnecting", "closed"]),
    pendingResources: z.number(),
    driftedResources: z.number(),
    activeWorkers: z.number(),
    activeHandlers: z.number(),
    droppedEvents: z.number(),
  }),
  resources: z.array(
    z.object({
      namespace: z.string(),
      kind: z.string(),
      id: z.string(),
      owner: z.string(),
      state: z.enum(["pending", "ready", "drifted", "failed"]),
      natsNames: z.array(z.string()),
      error: z.string().optional(),
      detail: z.record(z.string(), z.json()).optional(),
    }),
  ),
});
const deadLettersPayload: z.ZodType<DeadLettersPayload> = z.object({
  stores: z.array(
    z.object({
      name: z.string(),
      kind: z.enum(["queue", "job"]),
      description: z.string().nullable(),
      truncated: z.boolean(),
      entries: z.array(
        z.object({
          messageId: z.string(),
          tenantId: z.string(),
          attempts: z.number(),
          failedAt: z.string(),
          reason: z.string(),
          error: z.string().nullable(),
          dataPreview: z.string(),
        }),
      ),
    }),
  ),
});
const schedulesPayload: z.ZodType<SchedulesPayload> = z.object({
  schedules: z.array(
    z.object({
      schedulerId: z.string(),
      id: z.string(),
      cron: z.string(),
      timezone: z.string(),
      misfire: z.enum(["latest", "all"]),
      nextRunAt: z.string(),
      runNumber: z.number(),
      failureCount: z.number(),
      lastError: z.string().nullable(),
      lastRunId: z.string().nullable(),
      lastCompletedAt: z.string().nullable(),
      handlerAvailable: z.boolean(),
      createdAt: z.string(),
      updatedAt: z.string(),
      meta: z.record(z.string(), z.json()).nullable(),
    }),
  ),
});

export type SyncOpsServiceDependencies = {
  /** Live app registry; injected so the service stays free of registry runtime imports. */
  listApps: () => Promise<readonly AppRegistryEntry[]>;
  fetch?: (input: URL, init: RequestInit) => Promise<Response>;
  timeoutMs?: number;
  coreOrigin?: () => Promise<string>;
};

type AppRef = Pick<AppRegistryEntry, "id" | "name" | "icon" | "baseUrl">;

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const readJson = async (response: Response): Promise<unknown> => {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Response too large");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Invalid Sync operations response");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "";
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error("Response too large");
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text) as unknown;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
};

/** Keeps the app's own error message and only maps the status class. */
const upstreamFailure = (status: number, body: unknown): Result<never> => {
  const message =
    body && typeof body === "object" && "message" in body && typeof body.message === "string" ? body.message : `Upstream status ${status}`;
  const base =
    status === 404
      ? err.notFound("")
      : status === 400
        ? err.badInput("")
        : status === 401 || status === 403
          ? err.forbidden()
          : err.internal();
  return fail({ ...base, message });
};

export const createSyncOpsService = (dependencies: SyncOpsServiceDependencies) => {
  const doFetch = dependencies.fetch ?? fetch;
  const loadApps = dependencies.listApps;
  const timeoutMs = dependencies.timeoutMs ?? REQUEST_TIMEOUT_MS;

  const call = async <T>(
    app: AppRef,
    path: string,
    credentials: SyncOpsCredentials,
    init: { method?: "GET" | "POST" | "DELETE"; body?: unknown; schema?: z.ZodType<T> } = {},
  ): Promise<Result<T>> => {
    const headers = new Headers({ accept: "application/json" });
    if (credentials.cookie) headers.set("cookie", credentials.cookie);
    if (credentials.authorization) headers.set("authorization", credentials.authorization);
    if (credentials.requestId) headers.set("x-request-id", credentials.requestId);
    if (init.body !== undefined) headers.set("content-type", "application/json");
    try {
      const response = await doFetch(
        new URL(
          `/api/admin/sync/${encodeURIComponent(app.id)}${path}`,
          await (
            dependencies.coreOrigin ??
            (async () => process.env.CLOUD_CORE_INTERNAL_ORIGIN?.trim() || publicCloudOrigin(await get<string>("app.url")))
          )(),
        ),
        {
          method: init.method ?? "GET",
          headers,
          body: init.body === undefined ? undefined : JSON.stringify(init.body),
          signal: AbortSignal.timeout(timeoutMs),
          redirect: "manual",
        },
      );
      const body = await readJson(response).catch((error) => {
        if (response.ok) throw error;
        return null;
      });
      if (!response.ok) return upstreamFailure(response.status, body);
      if (body === null || typeof body !== "object") throw new Error("Invalid Sync operations response");
      if (init.schema) {
        const parsed = init.schema.safeParse(body);
        if (!parsed.success) throw new Error("Invalid Sync operations response");
        return ok(parsed.data);
      }
      return ok(body as T);
    } catch (error) {
      return fail(err.internal(errorMessage(error)));
    }
  };

  const findApp = async (appId: string): Promise<Result<AppRef>> => {
    const app = (await loadApps()).find((entry) => entry.id === appId);
    return app ? ok(app) : fail(err.notFound("App"));
  };

  const overview = async (credentials: SyncOpsCredentials): Promise<SyncOverview> => {
    const apps = await loadApps();
    const result: SyncOverview = { apps: [], deadLetters: [], truncatedStores: [], resources: [], schedules: [] };
    const perApp = await Promise.all(
      apps.map(async (app) => {
        const [resources, deadLetters, schedules] = await Promise.all([
          call(app, "/resources", credentials, { schema: resourcesPayload }),
          call(app, "/dead-letters", credentials, { schema: deadLettersPayload }),
          call(app, "/schedules", credentials, { schema: schedulesPayload }),
        ]);
        return { app, resources, deadLetters, schedules };
      }),
    );
    for (const { app, resources, deadLetters, schedules } of perApp) {
      const failure = [resources, deadLetters, schedules].find((entry) => !entry.ok);
      result.apps.push({
        appId: app.id,
        appName: app.name,
        appIcon: app.icon,
        status: failure ? "unavailable" : "ok",
        error: failure && !failure.ok ? failure.error.message : null,
        health: resources.ok ? resources.data.health : null,
      });
      if (resources.ok) {
        for (const resource of resources.data.resources) {
          const deadLetterDepth = resource.detail?.deadLetters;
          result.resources.push({
            ...resource,
            appId: app.id,
            appName: app.name,
            deadLetters: typeof deadLetterDepth === "number" ? deadLetterDepth : null,
          });
        }
      }
      if (deadLetters.ok) {
        for (const store of deadLetters.data.stores) {
          if (store.truncated) result.truncatedStores.push(`${app.id}/${store.name}`);
          for (const entry of store.entries) {
            result.deadLetters.push({
              ...entry,
              appId: app.id,
              appName: app.name,
              store: store.name,
              kind: store.kind,
              description: store.description,
            });
          }
        }
      }
      if (schedules.ok) {
        for (const schedule of schedules.data.schedules) result.schedules.push({ ...schedule, appId: app.id, appName: app.name });
      }
    }
    result.deadLetters.sort((left, right) => right.failedAt.localeCompare(left.failedAt));
    result.schedules.sort((left, right) => left.nextRunAt.localeCompare(right.nextRunAt));
    return result;
  };

  const withApp = async <T>(appId: string, run: (app: AppRef) => Promise<Result<T>>): Promise<Result<T>> => {
    const app = await findApp(appId);
    return app.ok ? run(app.data) : app;
  };

  return {
    overview,
    requeueDeadLetter: (input: { appId: string; store: string; messageId: string }, credentials: SyncOpsCredentials) =>
      withApp(input.appId, (app) =>
        call<{ receipt: { messageId: string; streamSequence: number; duplicate: boolean }; idempotencyKey: string }>(
          app,
          `/dead-letters/${encodeURIComponent(input.store)}/requeue`,
          credentials,
          { method: "POST", body: { messageId: input.messageId } },
        ),
      ),
    deleteDeadLetter: (input: { appId: string; store: string; messageId: string }, credentials: SyncOpsCredentials) =>
      withApp(input.appId, (app) =>
        call<{ deleted: boolean }>(
          app,
          `/dead-letters/${encodeURIComponent(input.store)}/${encodeURIComponent(input.messageId)}`,
          credentials,
          { method: "DELETE" },
        ),
      ),
    runScheduleNow: (
      input: { appId: string; schedulerId: string; scheduleId: string; requestId?: string },
      credentials: SyncOpsCredentials,
    ) =>
      withApp(input.appId, (app) =>
        call<{ runId: string; requestId: string }>(
          app,
          `/schedules/${encodeURIComponent(input.schedulerId)}/${encodeURIComponent(input.scheduleId)}/run-now`,
          credentials,
          { method: "POST", body: input.requestId ? { requestId: input.requestId } : {} },
        ),
      ),
    getScheduleRun: (
      input: { appId: string; schedulerId: string; scheduleId: string; runId: string; timeoutMs?: number },
      credentials: SyncOpsCredentials,
    ) =>
      withApp(input.appId, (app) => {
        const query = input.timeoutMs === undefined ? "" : `?timeoutMs=${input.timeoutMs}`;
        return call<{ completed: boolean; error: string | null }>(
          app,
          `/schedules/${encodeURIComponent(input.schedulerId)}/${encodeURIComponent(input.scheduleId)}/runs/${encodeURIComponent(input.runId)}${query}`,
          credentials,
        );
      }),
  };
};

export type SyncOpsService = ReturnType<typeof createSyncOpsService>;

/** Work-carrying kinds stay listed even when healthy; everything else only surfaces when it needs attention. */
const WORK_KINDS = new Set(["queue", "job", "scheduler", "pump"]);

export const needsAttention = (resource: SyncResourceRow): boolean => resource.state !== "ready" || (resource.deadLetters ?? 0) > 0;

export const isListedResource = (resource: SyncResourceRow): boolean => WORK_KINDS.has(resource.kind) || needsAttention(resource);
