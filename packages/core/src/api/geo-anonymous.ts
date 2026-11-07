import { capabilityValueMeta, recordCapabilityExecution } from "@k2b/cloud/capabilities/store";
import { env } from "@k2b/cloud/config/env";
import { CAPABILITY_MAX_REQUEST_BYTES, geoContract } from "@k2b/cloud/contracts";
import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { coreGeo } from "@k2b/cloud/services";
import { GEO_TIMEOUT_MS } from "@k2b/cloud/services/geo/bucket";
import { GeoError } from "@k2b/cloud/services/geo/errors";
import { Hono } from "hono";
import { runGeoQuery } from "../geo-capability-result";

/** Private network placement and the gateway namespace block enforce access; Host is not authentication. */
export const createAnonymousGeoRoutes = (
  dependencies: { autocomplete?: typeof coreGeo.autocompleteAnonymous; record?: typeof recordCapabilityExecution } = {},
) =>
  new Hono<AuthContext>()
    .use("*", async (c, next) => {
      const internal = env.CLOUD_CORE_INTERNAL_ORIGIN;
      if (!internal || new URL(c.req.url).host !== new URL(internal).host) return c.notFound();
      c.header("Cache-Control", "no-store");
      return next();
    })
    .post("/autocomplete", async (c) => {
      const startedAt = new Date();
      const requestId = crypto.randomUUID();
      const locale = getLocale(c);
      const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(GEO_TIMEOUT_MS.autocomplete)]);
      const result = await runGeoQuery({ locale }, async () => {
        const source = c.req.raw;
        if (Number(source.headers.get("content-length")) > CAPABILITY_MAX_REQUEST_BYTES) throw new GeoError("GEO_UNSUPPORTED_OPTION");
        const reader = source.body?.getReader();
        if (!reader) throw new GeoError("GEO_UNSUPPORTED_OPTION");
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        const cancel = () => {
          void reader.cancel().catch(() => undefined);
        };
        signal.addEventListener("abort", cancel, { once: true });
        let body: unknown;
        try {
          signal.throwIfAborted();
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > CAPABILITY_MAX_REQUEST_BYTES) {
              cancel();
              throw new GeoError("GEO_UNSUPPORTED_OPTION");
            }
            chunks.push(chunk.value);
          }
          signal.throwIfAborted();
          const payload = new Uint8Array(bytes);
          let offset = 0;
          for (const chunk of chunks) {
            payload.set(chunk, offset);
            offset += chunk.byteLength;
          }
          try {
            body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload));
          } catch {
            throw new GeoError("GEO_UNSUPPORTED_OPTION");
          }
        } finally {
          signal.removeEventListener("abort", cancel);
          reader.releaseLock();
        }
        const parsed = geoContract.autocomplete.input.safeParse(body);
        if (!parsed.success) throw new GeoError("GEO_UNSUPPORTED_OPTION");
        return (dependencies.autocomplete ?? coreGeo.autocompleteAnonymous)(parsed.data, { locale, signal, requestId });
      });
      await (dependencies.record ?? recordCapabilityExecution)({
        requestId,
        origin: "app",
        appId: "core",
        capability: "core.address.autocomplete",
        kind: "query",
        destructive: false,
        actorKind: null,
        accessSubject: null,
        status: result.ok ? "succeeded" : "failed",
        errorCode: result.ok ? undefined : result.error.code,
        outputMeta: result.ok ? capabilityValueMeta(result.data.data) : undefined,
        startedAt,
        completedAt: new Date(),
      });
      if (result.ok) return c.json(result.data);
      const retryAfter = result.error.details.retryAfter;
      if (typeof retryAfter === "number") c.header("Retry-After", String(retryAfter));
      return Response.json(result.error, { status: result.error.status, headers: c.res.headers });
    });
