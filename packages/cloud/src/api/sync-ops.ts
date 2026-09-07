import { Hono, type MiddlewareHandler } from "hono";
import { readBoundedJson } from "../_internal/bounded-json";
import { getApp, listApps } from "../_internal/registry";
import { type AuthContext, auth, rejectReservedWorkloadCredential } from "../server";
import { invocationAuthorityFromRequest } from "../services/identity/invocation-authority";
import { syncInvocationOperation } from "../services/identity/invocation-operations";
import { normalizeInvocationRequestId, signInvocationToken } from "../services/identity/invocation-token";
import { withActiveIdentitySigner } from "../services/identity/key-ring";

type Dependencies = {
  getApp?: typeof getApp;
  listApps?: typeof listApps;
  authenticate?: MiddlewareHandler<AuthContext>;
  fetch?: (input: URL, init: RequestInit) => Promise<Response>;
  signInvocation?: typeof signInvocationToken;
  withActiveSigner?: typeof withActiveIdentitySigner;
};

/** Core owns the credential-bearing hop; targets receive only an operation-bound invocation. */
export const createSyncOpsProxyRoutes = (dependencies: Dependencies = {}) =>
  new Hono<AuthContext>()
    .use(dependencies.authenticate ?? auth.requireRole("admin"))
    .use(rejectReservedWorkloadCredential)
    .use(auth.requireOAuthScope("admin"))
    .get("/", async (c) => c.json({ apps: await (dependencies.listApps ?? listApps)() }, 200, { "cache-control": "no-store" }))
    .all("/:appId/*", async (c) => {
      const path = new URL(c.req.url).pathname.split(`/sync/${c.req.param("appId")}`)[1] ?? "";
      const method = c.req.method;
      const allowed =
        method === "GET"
          ? /^\/(resources|dead-letters|schedules)$/.test(path) || /^\/schedules\/[^/]+\/[^/]+\/runs\/[^/]+$/.test(path)
          : method === "POST"
            ? /^\/dead-letters\/[^/]+\/requeue$/.test(path) || /^\/schedules\/[^/]+\/[^/]+\/run-now$/.test(path)
            : method === "DELETE" && /^\/dead-letters\/[^/]+\/[^/]+$/.test(path);
      if (!allowed) return c.notFound();
      const app = await (dependencies.getApp ?? getApp)(c.req.param("appId"));
      if (!app) return c.json({ message: "App not found" }, 404);
      const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(35_000)]);
      const operation = syncInvocationOperation(method, path);
      const requestId = normalizeInvocationRequestId(c.req.header("x-request-id"));
      let body: string | undefined;
      if (method === "POST") {
        const parsed = await readBoundedJson(c.req.raw, 16_384);
        if (!parsed.ok) return c.json({ message: "Invalid request body" }, 400);
        body = JSON.stringify(parsed.data);
      }
      try {
        const signed = await (dependencies.withActiveSigner ?? withActiveIdentitySigner)(
          "invocation",
          (signer) =>
            (dependencies.signInvocation ?? signInvocationToken)({
              targetAppId: app.id,
              callingAppId: "core",
              operation,
              schemaHash: null,
              authority: invocationAuthorityFromRequest(auth.getAuthority(c)),
              requestId,
              signer,
              issuer: signer.issuer,
            }),
          { signal, timeoutMs: 5_000 },
        );
        const headers = new Headers({ authorization: `Bearer ${signed.token}`, accept: "application/json" });
        if (body !== undefined) headers.set("content-type", "application/json");
        if (requestId) headers.set("x-request-id", requestId);
        const target = new URL(`/_internal/sync${path}`, app.baseUrl);
        target.search = new URL(c.req.url).search;
        const response = await (dependencies.fetch ?? fetch)(target, { method, headers, body, signal, redirect: "manual" });
        const result = await readBoundedJson(response, 4 * 1024 * 1024);
        if (!result.ok) return c.json({ message: "Invalid Sync operations response" }, 502);
        return Response.json(result.data, { status: response.status, headers: { "cache-control": "no-store" } });
      } catch {
        return c.json({ message: "Sync operations unavailable" }, 502);
      }
    });
