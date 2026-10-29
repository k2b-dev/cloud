import { sql } from "bun";
import { Hono } from "hono";
import { CAPABILITY_MAX_REQUEST_BYTES } from "../contracts/capabilities";
import { resolveLocale } from "../server/locale";
import { verifyAppQueryInvocation } from "../services/identity/invocation-token";
import { get } from "../services/settings";
import { readBoundedJson } from "./bounded-json";
import { type CompiledCapabilities, invokeCompiledCapability, serializeCapabilityProviderResult } from "./capabilities";
import { withCapabilityRequestTimeout } from "./capability-timeout";

/** Framework-only route: never installs an app actor in the ordinary auth middleware. */
export const createAppQueryRoutes = (compiled: CompiledCapabilities) =>
  new Hono().post("/:capabilityId", (c) =>
    withCapabilityRequestTimeout(c, "query", async () => {
      const operation = compiled.queries.get(c.req.param("capabilityId"));
      const deny = () => c.json({ code: "FORBIDDEN", message: "A permitted app query invocation is required" }, 403);
      if (operation?.manifest.appOnly !== true || operation.manifest.stream) return deny();
      const parsed = await readBoundedJson(c.req.raw, CAPABILITY_MAX_REQUEST_BYTES);
      if (
        !parsed.ok ||
        !parsed.data ||
        typeof parsed.data !== "object" ||
        Array.isArray(parsed.data) ||
        Object.keys(parsed.data).length !== 1 ||
        !("input" in parsed.data)
      )
        return c.json({ code: "VALIDATION_FAILED", message: "Expected a bounded input object" }, 400);
      const token = c.req.header("authorization")?.match(/^Bearer (\S+)$/)?.[1];
      if (!token) return deny();
      let claims: Awaited<ReturnType<typeof verifyAppQueryInvocation>>;
      try {
        claims = await verifyAppQueryInvocation(token, {
          appId: compiled.manifest.appId,
          capabilityId: operation.manifest.localId,
          schemaHash: operation.manifest.schemaHash,
          input: parsed.data.input,
        });
      } catch {
        return c.json({ code: "APP_UNAVAILABLE", message: "Invocation verification unavailable" }, 503);
      }
      if (!claims) return deny();
      // Revoking/expiring the workload credential also invalidates already-issued query tokens.
      const [active] = await sql<{ id: string }[]>`
    SELECT c.id FROM auth.service_account_credentials c JOIN auth.service_accounts sa ON sa.id = c.service_account_id
    WHERE c.id = ${claims.credential_id}::uuid AND sa.id = ${claims.service_account_id}::uuid
      AND c.kind = 'api_token' AND c.status = 'active' AND (c.expires_at IS NULL OR c.expires_at > now())
      AND 'identity:invoke' = ANY(c.scopes) AND sa.status = 'active' AND sa.kind = 'resource_bound'
      AND sa.delegated_user_id IS NULL AND sa.app_id = ${claims.sub} AND sa.resource_type = 'cloud.app' AND sa.resource_id = ${claims.sub}
  `;
      if (!active) return deny();
      const result = await invokeCompiledCapability({
        compiled,
        kind: "query",
        localId: operation.manifest.localId,
        input: parsed.data.input,
        expectedSchemaHash: claims.schema_hash,
        context: {
          actor: { kind: "app", appId: claims.sub },
          accessSubject: { type: "none" },
          user: null,
          locale: resolveLocale(c.req.raw.headers, await get<string>("app.locale")),
          requestId: claims.request_id,
          origin: "app",
          signal: c.req.raw.signal,
        },
      });
      const response = serializeCapabilityProviderResult(result);
      return new Response(response.body, {
        status: response.status,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    }),
  );
