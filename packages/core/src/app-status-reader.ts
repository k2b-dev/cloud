import type {
  CapabilityCaller,
  CapabilityCatalogApp,
  CapabilityCatalogClientResult,
  CapabilityClientResult,
  CapabilityInvocation,
} from "@k2b/cloud/capabilities/server";
import {
  type AppStatusDetailData,
  AppStatusDetailDataSchema,
  AppStatusDetailInputSchema,
  AppStatusForgetDataSchema,
  type AppStatusSummaryData,
  AppStatusSummaryDataSchema,
  AppStatusSummaryInputSchema,
  type AppStatusWindow,
  appStatusIssues,
} from "@k2b/cloud/contracts";
import type { RequestAuthority } from "@k2b/cloud/server";
import type { z } from "zod";

export type { AppStatusWindow } from "@k2b/cloud/contracts";
export type ProviderRef = { appId: string; name: string };
export type ProviderFailure = { provider: ProviderRef; reason: "unavailable" | "denied" | "timeout" | "invalid" };
type CommonParams = { authority: RequestAuthority; locale: string; signal?: AbortSignal };
export type AppStatusSummaryParams = CommonParams & { appIds: string[]; window: AppStatusWindow };
export type AppStatusDetailParams = CommonParams & { appId: string; window: AppStatusWindow; cursor?: string; providerAppId?: string };
export type AppStatusSummaries = {
  byApp: Map<
    string,
    Array<{
      provider: ProviderRef;
      traffic: AppStatusSummaryData["apps"][number]["traffic"];
      links: AppStatusSummaryData["apps"][number]["links"];
      lastSeenAt: string | null;
    }>
  >;
  otherApps: Array<{ appId: string; provider: ProviderRef; lastSeenAt: string | null }>;
  failures: ProviderFailure[];
  truncated: string[];
};
export type AppStatusDetails = {
  results: Array<Omit<AppStatusDetailData, "totalFailedRequests"> & { provider: ProviderRef; totalFailedRequests: number | null }>;
  failures: ProviderFailure[];
};
export type AppStatusDependencies = {
  catalog: (options: { cursor?: string; limit: number; caller: CapabilityCaller }) => Promise<CapabilityCatalogClientResult>;
  invoke: (invocation: CapabilityInvocation, caller: CapabilityCaller) => Promise<CapabilityClientResult<unknown>>;
};
type Provider = { ref: ProviderRef; role: NonNullable<CapabilityCatalogApp["manifest"]["appStatus"]> };
const discoveryRef: ProviderRef = { appId: "core", name: "App status discovery" };
const MAX_BYTES = 512 * 1024;
const MAX_PROVIDERS = 8;
const CONCURRENCY = 4;
class ReadFailure extends Error {
  constructor(readonly reason: ProviderFailure["reason"]) {
    super(reason);
  }
}
const failureReason = (error: { code: string; status: number }): ProviderFailure["reason"] => {
  if (error.status === 401 || error.status === 403) return "denied";
  if (error.status === 504 || error.status === 499 || error.code === "DEADLINE_EXCEEDED") return "timeout";
  if (error.code === "INVALID_APP_RESPONSE" || error.code === "VALIDATION_FAILED") return "invalid";
  return "unavailable";
};
const admin = (authority: RequestAuthority) => {
  const user = authority.actor.kind === "user" ? authority.actor.user : authority.actor.delegatedUser;
  return !!user?.roles.includes("admin") && authority.accessSubject.type === "user" && authority.accessSubject.userId === user.id;
};

/** One request-local budget, shared by discovery and every operation of a render. */
export const createAppStatusReader = (dependencies: AppStatusDependencies) => {
  let session:
    | { authority: RequestAuthority; locale: string; signal: AbortSignal; controller: AbortController; deadline: number; bytes: number }
    | undefined;
  let active = 0;
  const waiting: Array<() => void> = [];
  let discovery: Promise<{ providers: Provider[]; failures: ProviderFailure[] }> | undefined;
  const open = (params: CommonParams) => {
    if (!session) {
      const controller = new AbortController();
      session = {
        authority: params.authority,
        locale: params.locale,
        controller,
        signal: AbortSignal.any([controller.signal, ...(params.signal ? [params.signal] : [])]),
        deadline: Date.now() + 1500,
        bytes: 0,
      };
    }
    if (session.authority !== params.authority || session.locale !== params.locale)
      throw new Error("Use one authority and locale per app-status reader");
    return session;
  };
  const read = async <T>(params: CommonParams, run: (caller: CapabilityCaller) => Promise<T>): Promise<T> => {
    const state = open(params);
    if (state.signal.aborted || params.signal?.aborted || Date.now() >= state.deadline) throw new ReadFailure("timeout");
    if (state.bytes >= MAX_BYTES) throw new ReadFailure("unavailable");
    let release: (() => void) | undefined;
    let queued: (() => void) | undefined;
    let observedBytes = false;
    const consume = (bytes: number) => {
      observedBytes = true;
      state.bytes += bytes;
      if (state.bytes > MAX_BYTES) throw new ReadFailure("unavailable");
    };
    let onAbort: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const signal = AbortSignal.any([state.signal, ...(params.signal ? [params.signal] : [])]);
    const cancelled = new Promise<never>((_, reject) => {
      onAbort = () => reject(new ReadFailure("timeout"));
      signal.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(
        () => {
          state.controller.abort();
        },
        Math.max(0, state.deadline - Date.now()),
      );
    });
    try {
      const slot = new Promise<void>((resolve) => {
        const enter = () => {
          active++;
          release = () => {
            active--;
            waiting.shift()?.();
          };
          resolve();
        };
        if (active < CONCURRENCY) enter();
        else {
          queued = enter;
          waiting.push(enter);
        }
      });
      await Promise.race([slot, cancelled]);
      if (signal.aborted || Date.now() >= state.deadline) throw new ReadFailure("timeout");
      if (state.bytes >= MAX_BYTES) throw new ReadFailure("unavailable");
      const value = await Promise.race([
        run({ authority: params.authority, locale: params.locale, signal, consumeResponseBytes: consume }),
        cancelled,
      ]);
      if (signal.aborted || Date.now() >= state.deadline) throw new ReadFailure("timeout");
      if (!observedBytes) consume(new TextEncoder().encode(JSON.stringify(value)).byteLength);
      if (state.bytes > MAX_BYTES) throw new ReadFailure("unavailable");
      return value;
    } finally {
      if (queued) {
        const index = waiting.indexOf(queued);
        if (index >= 0) waiting.splice(index, 1);
      }
      release?.();
      if (timer) clearTimeout(timer);
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  };
  const discover = (params: CommonParams) => {
    open(params);
    discovery ??= (async () => {
      const providers: Provider[] = [];
      const failures: ProviderFailure[] = [];
      if (!admin(params.authority)) return { providers, failures: [{ provider: discoveryRef, reason: "denied" as const }] };
      const seenApps = new Set<string>();
      const cursors = new Set<string>();
      let cursor: string | undefined;
      try {
        for (;;) {
          const page = await read(params, (caller) => dependencies.catalog({ caller, cursor, limit: 25 }));
          if (!page.ok) throw new ReadFailure(failureReason(page.error));
          for (const app of page.data.apps) {
            const role = app.manifest.appStatus;
            if (!role || seenApps.has(app.appId)) continue;
            seenApps.add(app.appId);
            const ref = { appId: app.appId, name: app.appName };
            if (appStatusIssues(app.manifest).length) {
              failures.push({ provider: ref, reason: "invalid" });
              continue;
            }
            if (providers.length >= MAX_PROVIDERS) {
              failures.push({ provider: ref, reason: "unavailable" });
              continue;
            }
            providers.push({ ref, role });
          }
          if (!page.data.page.hasMore) break;
          cursor = page.data.page.nextCursor;
          if (!cursor || cursors.has(cursor)) throw new ReadFailure("invalid");
          cursors.add(cursor);
        }
      } catch (error) {
        failures.push({ provider: discoveryRef, reason: error instanceof ReadFailure ? error.reason : "unavailable" });
      }
      return { providers, failures };
    })();
    return discovery;
  };
  const calls = async <T extends z.ZodType>(
    params: CommonParams,
    providers: Provider[],
    operation: "summary" | "detail" | "forget",
    input: unknown,
    schema: T,
  ) => {
    const results: Array<{ provider: ProviderRef; data: z.output<T> }> = [];
    const failures: ProviderFailure[] = [];
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, providers.length) }, async () => {
        for (;;) {
          const provider = providers[next++];
          if (!provider) return;
          try {
            const response = await read(params, (caller) =>
              dependencies.invoke(
                {
                  appId: provider.ref.appId,
                  capabilityId: provider.role[operation],
                  kind: operation === "forget" ? "action" : "query",
                  input,
                  ...(operation === "forget" ? { idempotencyKey: crypto.randomUUID() } : {}),
                },
                caller,
              ),
            );
            if (!response.ok) throw new ReadFailure(failureReason(response.error));
            const data = schema.safeParse(response.data.data);
            if (!data.success) throw new ReadFailure("invalid");
            results.push({ provider: provider.ref, data: data.data });
          } catch (error) {
            failures.push({ provider: provider.ref, reason: error instanceof ReadFailure ? error.reason : "unavailable" });
          }
        }
      }),
    );
    // Keep the catalog's order when calls complete at different times.
    const order = new Map(providers.map((provider, index) => [provider.ref.appId, index]));
    results.sort((a, b) => (order.get(a.provider.appId) ?? 0) - (order.get(b.provider.appId) ?? 0));
    failures.sort((a, b) => (order.get(a.provider.appId) ?? 0) - (order.get(b.provider.appId) ?? 0));
    return { results, failures };
  };
  return {
    async readAppStatusSummaries(params: AppStatusSummaryParams): Promise<AppStatusSummaries> {
      const ids = [...new Set(params.appIds)];
      const appIds = ids.slice(0, 200);
      const output: AppStatusSummaries = { byApp: new Map(), otherApps: [], failures: [], truncated: ids.slice(200) };
      if (!appIds.length) return output;
      AppStatusSummaryInputSchema.parse({ appIds, window: params.window });
      const found = await discover(params);
      const response = await calls(params, found.providers, "summary", { appIds, window: params.window }, AppStatusSummaryDataSchema);
      output.failures = [...found.failures, ...response.failures];
      const requested = new Set(appIds);
      for (const { provider, data } of response.results) {
        const others = new Set(data.otherApps);
        const rows = new Map(data.apps.map((app) => [app.appId, app]));
        if (
          rows.size !== data.apps.length ||
          others.size !== data.otherApps.length ||
          data.otherApps.some((id) => requested.has(id)) ||
          data.apps.some((app) => !requested.has(app.appId) && !others.has(app.appId))
        ) {
          output.failures.push({ provider, reason: "invalid" });
          continue;
        }
        for (const row of data.apps) {
          const entries = output.byApp.get(row.appId) ?? [];
          entries.push({ provider, traffic: row.traffic, links: row.links, lastSeenAt: row.lastSeenAt ?? null });
          output.byApp.set(row.appId, entries);
        }
        for (const appId of data.otherApps) output.otherApps.push({ appId, provider, lastSeenAt: rows.get(appId)?.lastSeenAt ?? null });
      }
      return output;
    },
    async readAppStatusDetail(params: AppStatusDetailParams): Promise<AppStatusDetails> {
      const input = AppStatusDetailInputSchema.parse({
        appId: params.appId,
        window: params.window,
        ...(params.cursor ? { cursor: params.cursor } : {}),
      });
      const found = await discover(params);
      const providers = found.providers.filter((provider) => !params.providerAppId || provider.ref.appId === params.providerAppId);
      const failures = [...found.failures];
      if (params.providerAppId && !providers.length && !failures.some((failure) => failure.provider.appId === params.providerAppId))
        failures.push({ provider: { appId: params.providerAppId, name: params.providerAppId }, reason: "unavailable" });
      const response = await calls(params, providers, "detail", input, AppStatusDetailDataSchema);
      return {
        results: response.results.map(({ provider, data }) => ({
          provider,
          ...data,
          totalFailedRequests: data.totalFailedRequests ?? null,
        })),
        failures: [...failures, ...response.failures],
      };
    },
    async forgetAppStatus(
      params: CommonParams & { appId: string; requiredProviders?: ProviderRef[] },
    ): Promise<{ failures: ProviderFailure[] }> {
      const found = await discover(params);
      // A summary for the exact target avoids the fifty-other-apps discovery bound.
      const summary = await calls(
        params,
        found.providers,
        "summary",
        { appIds: [params.appId], window: "24h" },
        AppStatusSummaryDataSchema,
      );
      const reporters = new Set(
        summary.results
          .filter(({ data }) => data.apps.some((app) => app.appId === params.appId) || data.otherApps.includes(params.appId))
          .map((result) => result.provider.appId),
      );
      for (const provider of params.requiredProviders ?? []) reporters.add(provider.appId);
      const missing = (params.requiredProviders ?? [])
        .filter((ref) => !found.providers.some((provider) => provider.ref.appId === ref.appId))
        .map((provider) => ({ provider, reason: "unavailable" as const }));
      const response = await calls(
        params,
        found.providers.filter((provider) => reporters.has(provider.ref.appId)),
        "forget",
        { appId: params.appId },
        AppStatusForgetDataSchema,
      );
      return {
        failures: [
          ...found.failures,
          ...missing,
          ...summary.failures,
          ...response.failures,
          ...response.results
            .filter((result) => !result.data.forgotten)
            .map((result) => ({ provider: result.provider, reason: "unavailable" as const })),
        ],
      };
    },
  };
};
