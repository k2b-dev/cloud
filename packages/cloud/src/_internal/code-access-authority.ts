import { Hono } from "hono";
import { z } from "zod";
import { codeAccessBindings, listCodeAccess, removeCodeAccess } from "../code/access";
import { verifyCodeAccessCleanup, verifyCodeAccessList } from "../code/access-proof";
import type { CapabilityDefinitions } from "../contracts/capabilities";
import { CAPABILITY_MAX_REQUEST_BYTES, CloudResourceRefSchema } from "../contracts/capabilities";
import { CodeAccessListInputSchema, CodeAccessRemoveInputSchema } from "../contracts/code-access";
import { sql } from "../runtime/clients";
import { normalizeInvocationRequestId } from "../services/identity/invocation-token";
import { readBoundedJson } from "./bounded-json";
import { withCapabilityRequestTimeout } from "./capability-timeout";

/** Narrow Core transports for account inspection and cleanup, never person or app credentials. */
export const createCodeAccessAuthorityRoutes = (appId: string, definitions: CapabilityDefinitions) => {
  const bindings = codeAccessBindings(appId, definitions);
  const router = new Hono();
  router.post("/queries/code.owner.title", (c) =>
    withCapabilityRequestTimeout(c, "query", async () => {
      const token = c.req.header("authorization")?.match(/^Bearer (\S+)$/)?.[1];
      const claims = token && (await verifyCodeAccessList(token, appId));
      if (!claims) return c.json({ code: "FORBIDDEN" }, 403);
      const body = await readBoundedJson(c.req.raw, CAPABILITY_MAX_REQUEST_BYTES);
      const parsed = CloudResourceRefSchema.safeParse(body.ok ? body.data : undefined);
      if (!parsed.success || !parsed.data.type.startsWith(`${appId}.`)) return c.json({ code: "FORBIDDEN" }, 403);
      const ref = parsed.data,
        localType = ref.type.slice(appId.length + 1);
      const type = definitions.types?.[localType];
      const reader = type?.reader && definitions.queries?.[type.reader];
      if (!definitions.code?.owners?.includes(localType) || !reader || !reader.codeResourceTitle)
        return c.json({ code: "OWNER_READER_UNAVAILABLE" }, 503);
      try {
        const title = await sql.begin(async (tx) => {
          await tx`SET TRANSACTION READ ONLY`;
          const [account] = await tx`SELECT id FROM auth.service_accounts WHERE id=${claims.principal}::uuid
          AND kind='code' AND status='active' AND name=${`code:${ref.type}:${ref.id}`}`;
          if (!account) return undefined;
          return z
            .string()
            .min(1)
            .max(500)
            .nullable()
            .parse(await reader.codeResourceTitle!(tx, ref.id));
        });
        return title === undefined ? c.json({ code: "FORBIDDEN" }, 403) : c.json({ data: { title } });
      } catch {
        return c.json({ code: "OWNER_READER_UNAVAILABLE" }, 503);
      }
    }),
  );
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
  return router;
};
