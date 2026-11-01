import { Hono } from "hono";
import { codeAccessBindings, listCodeAccess, readCodeAccessManagers, removeCodeAccess } from "../code/access";
import { verifyCodeAccessCleanup, verifyCodeAccessList, verifyCodeAccessNotifications } from "../code/access-proof";
import type { CapabilityDefinitions } from "../contracts/capabilities";
import { CAPABILITY_MAX_REQUEST_BYTES, CAPABILITY_MAX_RESULT_BYTES } from "../contracts/capabilities";
import { CodeAccessListInputSchema, CodeAccessRemoveInputSchema } from "../contracts/code-access";
import { normalizeInvocationRequestId } from "../services/identity/invocation-token";
import { readBoundedJson } from "./bounded-json";
import { withCapabilityRequestTimeout } from "./capability-timeout";
import { codeAccessOperationsAllowed } from "./code-access";

/** Narrow Core transports for account inspection and cleanup, never person or app credentials. */
export const createCodeAccessAuthorityRoutes = (appId: string, definitions: CapabilityDefinitions) => {
  const bindings = codeAccessBindings(appId, definitions);
  const router = new Hono();
  router.post("/actions/code.access.rm", (c) =>
    withCapabilityRequestTimeout(c, "action", async () => {
      const token = c.req.header("authorization")?.match(/^Bearer (\S+)$/)?.[1];
      const claims = token && (await verifyCodeAccessCleanup(token, appId));
      if (!claims) return c.json({ code: "FORBIDDEN", message: "Core Code-account cleanup authority required" }, 403);
      const body = await readBoundedJson(c.req.raw, CAPABILITY_MAX_REQUEST_BYTES);
      const parsed = CodeAccessRemoveInputSchema.safeParse(body.ok ? body.data : undefined);
      if (!parsed.success) return c.json({ code: "VALIDATION_FAILED", message: "Expected grantId" }, 400);
      try {
        const removed = await removeCodeAccess(appId, bindings, parsed.data.grantId, {
          cleanupPrincipal: claims.principal,
          requestId: normalizeInvocationRequestId(c.req.header("x-request-id")) ?? crypto.randomUUID(),
        });
        return c.json({ data: { removed }, receipt: { text: removed ? "Code access removed" : "Code access could not be removed" } });
      } catch {
        return c.json({ code: "APP_UNAVAILABLE", message: "Code access cleanup failed; retry this grant" }, 503);
      }
    }),
  );
  router.post("/queries/code.access.list", (c) =>
    withCapabilityRequestTimeout(c, "query", async () => {
      const token = c.req.header("authorization")?.match(/^Bearer (\S+)$/)?.[1];
      const claims = token && (await verifyCodeAccessList(token, appId));
      if (!claims) return c.json({ code: "FORBIDDEN", message: "Core Code-account inspection authority required" }, 403);
      const body = await readBoundedJson(c.req.raw, CAPABILITY_MAX_REQUEST_BYTES);
      const parsed = CodeAccessListInputSchema.safeParse(body.ok ? body.data : undefined);
      if (!parsed.success || parsed.data.principal !== claims.principal)
        return c.json({ code: "FORBIDDEN", message: "Inspection is bound to one Code account" }, 403);
      try {
        return c.json({ data: await listCodeAccess(appId, bindings, claims.principal, { listPrincipal: claims.principal }) });
      } catch {
        return c.json({ code: "APP_UNAVAILABLE", message: "Code access inspection failed; retry this account" }, 503);
      }
    }),
  );
  // Separate server-only audience lookup: never returned by an on-behalf-of-person capability.
  router.post("/queries/code.access.notifications", (c) =>
    withCapabilityRequestTimeout(c, "query", async () => {
      const token = c.req.header("authorization")?.match(/^Bearer (\S+)$/)?.[1];
      const claims = token && (await verifyCodeAccessNotifications(token, appId));
      if (!claims || !codeAccessOperationsAllowed(appId, definitions, claims.target, claims.operations))
        return c.json({ code: "FORBIDDEN", message: "Core notification authority required" }, 403);
      try {
        const managerUserIds = await readCodeAccessManagers(appId, bindings, claims);
        if (managerUserIds === null) return c.json({ code: "MANAGERS_UNAVAILABLE", message: "Target must identify its managers" }, 422);
        const data = { data: { managerUserIds } };
        if (new TextEncoder().encode(JSON.stringify(data)).byteLength > CAPABILITY_MAX_RESULT_BYTES)
          return c.json({ code: "CAPACITY_EXCEEDED", message: "Notification audience exceeds the response budget" }, 422);
        return c.json(data);
      } catch {
        return c.json({ code: "APP_UNAVAILABLE", message: "Notification audience unavailable" }, 503);
      }
    }),
  );
  return router;
};
