import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { readBoundedJson } from "../_internal/bounded-json";
import { getApp, listApps } from "../_internal/registry";
import { AdminSettingsCatalogSchema } from "../contracts/admin-settings";
import { EnvSettingStatusSchema, type EnvSettingsProcessSchema, EnvSettingsStatusSchema } from "../contracts/settings-env";
import { type AuthContext, auth, jsonResponse, requiresAdmin, setRequestTimeout, v } from "../server";
import { listGatewayRouteSnapshots } from "../services/gateway";
import { invocationAuthorityFromRequest } from "../services/identity/invocation-authority";
import { issueInvocationToken } from "../services/identity/issue-invocation";
import { withActiveIdentitySigner } from "../services/identity/key-ring";
import { readAdminSettingsCatalog } from "../services/settings/admin-catalog";
import { CORE_SETTINGS } from "../services/settings/core-settings";
import { readEnvSettingsStatus } from "../services/settings/env-status";
import { settingsInvocationOperation } from "./settings-ops";

const reply = z.object({ settings: z.array(EnvSettingStatusSchema) });
export const adminSettingsEnvRoutes = new Hono<AuthContext>()
  .use("*", auth.requireRole("admin"))
  .use("*", (c, next) =>
    auth.requireOAuthScope(...(c.req.method === "GET" || c.req.method === "HEAD" ? ["read", "admin"] : ["write", "admin"]))(c, next),
  )
  .get("/catalog", v("query", z.object({ app: z.string().min(1).max(80).optional() })), async (c) => {
    c.header("Cache-Control", "no-store");
    const appId = c.req.valid("query").app;
    if (!appId || appId === "core")
      return c.json(AdminSettingsCatalogSchema.parse({ settings: await readAdminSettingsCatalog(Object.keys(CORE_SETTINGS)) }));
    const app = await getApp(appId);
    if (!app) return c.json({ message: "App is not registered" }, 404);
    try {
      const response = await requestSettings(app, "GET", "catalog", auth.getAuthority(c), undefined, c.req.raw.signal);
      const body = await readBoundedJson(response, 4 * 1024 * 1024);
      if (!response.ok || !body.ok) throw new Error("Unavailable");
      return c.json(AdminSettingsCatalogSchema.parse(body.data));
    } catch {
      return c.json({ message: "Application settings unavailable" }, 502);
    }
  })
  .get(
    "/status",
    describeRoute({
      tags: ["Administration"],
      summary: "Check environment-backed settings without returning values",
      ...requiresAdmin,
      responses: { 200: jsonResponse(EnvSettingsStatusSchema, "Migration status") },
    }),
    async (c) => {
      setRequestTimeout(c, 240);
      const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(230_000)]);
      try {
        const processes: z.infer<typeof EnvSettingsProcessSchema>[] = [
          { appId: "core", status: "ok", settings: await readEnvSettingsStatus() },
        ];
        for (const app of await listApps()) {
          if (app.id === "core") continue;
          try {
            const response = await requestSettings(app, "GET", "env", auth.getAuthority(c), undefined, signal);
            const data = await readBoundedJson(response, 4 * 1024 * 1024);
            if (!response.ok || !data.ok) throw new Error("Unavailable");
            processes.push({ appId: app.id, status: "ok", settings: reply.parse(data.data).settings });
          } catch {
            processes.push({ appId: app.id, status: "unavailable", settings: [] });
          }
        }
        const gateways = await listGatewayRouteSnapshots();
        if (!gateways.length) processes.push({ appId: "gateway", status: "unavailable", settings: [] });
        for (const gateway of gateways) {
          const parsed = z.array(EnvSettingStatusSchema).safeParse(gateway.envSettings);
          processes.push({
            appId: "gateway",
            instanceId: gateway.instanceId,
            sampledAt: gateway.updatedAt,
            status: parsed.success ? "ok" : "unavailable",
            settings: parsed.success ? parsed.data : [],
          });
        }
        return c.json(
          { needsAttention: processes.some((p) => p.status !== "ok" || p.settings.some((s) => s.needsAttention)), processes },
          200,
          { "cache-control": "no-store" },
        );
      } finally {
        setRequestTimeout(c, 10);
      }
    },
  )
  .put("/:appId/:key", v("json", z.object({ value: z.unknown(), replaceUnreadable: z.boolean().optional() })), async (c) => {
    const app = await getApp(c.req.param("appId") ?? "");
    if (!app) return c.json({ message: "App is not registered; start it before changing its settings" }, 404);
    try {
      const response = await requestSettings(
        app,
        "PUT",
        c.req.param("key") ?? "",
        auth.getAuthority(c),
        c.req.valid("json"),
        c.req.raw.signal,
      );
      const body = await readBoundedJson(response, 4 * 1024 * 1024);
      if (!body.ok) throw new Error("Unavailable");
      return Response.json(body.data, { status: response.status, headers: { "cache-control": "no-store" } });
    } catch {
      return c.json({ message: "Application settings unavailable" }, 502);
    }
  });

const requestSettings = async (
  app: { id: string; baseUrl: string },
  method: "GET" | "PUT",
  key: string,
  authority: Parameters<typeof invocationAuthorityFromRequest>[0],
  body: unknown,
  parentSignal: AbortSignal,
) => {
  const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(5_000)]);
  const signed = await withActiveIdentitySigner(
    "invocation",
    (signer, db) =>
      issueInvocationToken(
        {
          targetAppId: app.id,
          callingAppId: "core",
          operation: settingsInvocationOperation(method, key),
          schemaHash: null,
          authority: invocationAuthorityFromRequest(authority),
          signer,
          issuer: signer.issuer,
        },
        { db, groupsAdmin: signer.groupsAdmin, signal },
      ),
    { signal, timeoutMs: 5_000 },
  );
  return fetch(new URL(`/_internal/settings/${encodeURIComponent(key)}`, app.baseUrl), {
    method,
    headers: { authorization: `Bearer ${signed.token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
    redirect: "manual",
  });
};
