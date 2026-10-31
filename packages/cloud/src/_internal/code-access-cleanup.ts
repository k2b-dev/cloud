import { Hono } from "hono";
import { codeAccessBindings, removeCodeAccess } from "../code/access";
import { verifyCodeAccessCleanup } from "../code/access-proof";
import type { CapabilityDefinitions } from "../contracts/capabilities";
import { CAPABILITY_MAX_REQUEST_BYTES } from "../contracts/capabilities";
import { CodeAccessRemoveInputSchema } from "../contracts/code-access";
import { readBoundedJson } from "./bounded-json";
import { withCapabilityRequestTimeout } from "./capability-timeout";

/** Narrow alternate transport for the same rm operation, never a person or an app credential. */
export const createCodeAccessCleanupRoutes = (appId: string, definitions: CapabilityDefinitions) => {
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
          requestId: crypto.randomUUID(),
        });
        return c.json({ data: { removed }, receipt: { text: removed ? "Code access removed" : "Code access could not be removed" } });
      } catch {
        return c.json({ code: "APP_UNAVAILABLE", message: "Code access cleanup failed; retry this grant" }, 503);
      }
    }),
  );
  return router;
};
