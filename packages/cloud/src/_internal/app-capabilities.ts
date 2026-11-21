import { Hono } from "hono";
import { capabilityInvocationBody, normalizeCapabilityCall } from "../capabilities/calls";
import { CAPABILITY_MAX_REQUEST_BYTES, CapabilityInvocationBodySchema } from "../contracts/capabilities";
import { resolveLocale } from "../server/locale";
import { getActiveAppKey } from "../services/app-keys";
import { verifyAppCapabilityInvocation } from "../services/identity/invocation-token";
import { get } from "../services/settings";
import { readBoundedJson } from "./bounded-json";
import { type CompiledCapabilities, invokeCompiledCapability, serializeCapabilityProviderResult } from "./capabilities";
import { withCapabilityRequestTimeout } from "./capability-timeout";

/** Separate from ordinary auth: application authority never becomes a grant-bearing person. */
export const createAppCapabilityRoutes = (compiled: CompiledCapabilities) => {
  const router = new Hono();
  for (const kind of ["query", "action"] as const) {
    router.post(`/${kind === "query" ? "queries" : "actions"}/:capabilityId`, (c) =>
      withCapabilityRequestTimeout(c, kind, async () => {
        const operation = (kind === "query" ? compiled.queries : compiled.actions).get(c.req.param("capabilityId"));
        const deny = () => c.json({ code: "FORBIDDEN", message: "A permitted signed app capability invocation is required" }, 403);
        if (!operation?.manifest.appPermission || operation.manifest.stream) return deny();
        const rawBody = await readBoundedJson(c.req.raw, CAPABILITY_MAX_REQUEST_BYTES);
        const body = CapabilityInvocationBodySchema.safeParse(rawBody.ok ? rawBody.data : undefined);
        if (!body.success) return c.json({ code: "VALIDATION_FAILED", message: "Expected a bounded capability call" }, 400);
        let call: ReturnType<typeof normalizeCapabilityCall>;
        try {
          call = normalizeCapabilityCall(compiled.manifest.appId, operation.manifest, body.data);
        } catch {
          return c.json({ code: "VALIDATION_FAILED", message: "Invalid capability target" }, 400);
        }
        const boundCall = operation.manifest.target !== undefined || operation.manifest.refs !== undefined;
        const token = c.req.header("authorization")?.match(/^Bearer (\S+)$/)?.[1];
        if (!token) return deny();
        try {
          const claims = await verifyAppCapabilityInvocation(token, {
            appId: compiled.manifest.appId,
            kind,
            capabilityId: operation.manifest.localId,
            schemaHash: operation.manifest.schemaHash,
            permission: operation.manifest.appPermission,
            input: boundCall ? call : body.data.input,
          });
          if (!claims) return deny();
          const locale = resolveLocale(c.req.raw.headers, await get<string>("app.locale"));
          if (!(await getActiveAppKey({ appId: claims.sub, keyId: claims.key_id }))) return deny();
          const result = await invokeCompiledCapability({
            compiled,
            kind,
            localId: operation.manifest.localId,
            ...capabilityInvocationBody(call),
            expectedSchemaHash: claims.schema_hash,
            context: {
              actor: { kind: "app", appId: claims.sub, keyId: claims.key_id },
              accessSubject: { type: "none" },
              user: null,
              locale,
              requestId: claims.request_id,
              origin: "app",
              signal: c.req.raw.signal,
              ...(c.req.header("idempotency-key") ? { idempotencyKey: c.req.header("idempotency-key") } : {}),
            },
          });
          const response = serializeCapabilityProviderResult(result);
          return new Response(response.body, {
            status: response.status,
            headers: { "content-type": "application/json", "cache-control": "no-store" },
          });
        } catch {
          return c.json({ code: "APP_UNAVAILABLE", message: "App invocation verification unavailable" }, 503);
        }
      }),
    );
  }
  return router;
};
