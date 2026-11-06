import { env } from "../config/env";
import type { CapabilityExecutionContext } from "../contracts/capabilities";
import { capabilityMessages } from "../shared/capability-messages";
import { invokeCapabilityWithDataSchema } from "./server";

/** Framework-owned closure: the invocation credential never becomes handler data. */
export const createNestedCapabilityQuery =
  (source: Request): NonNullable<CapabilityExecutionContext["query"]> =>
  async (invocation, schema) => {
    if (!env.CLOUD_CORE_INTERNAL_ORIGIN)
      return {
        ok: false,
        error: {
          code: "APP_UNAVAILABLE",
          message: capabilityMessages(source.headers.get("x-cloud-locale") ?? undefined).cloudUnavailable,
          status: 503,
        },
      };
    return invokeCapabilityWithDataSchema({ ...invocation, kind: "query" }, schema, {
      signal: source.signal,
      locale: source.headers.get("x-cloud-locale"),
      transport: async (request) => {
        const match = new URL(request.url).pathname.match(/^\/api\/capabilities\/v1\/queries\/([^/]+)\/([^/]+)$/);
        if (!match) throw new Error("Only a nested Query is supported");
        const { input } = await request.json();
        const headers = new Headers({ "content-type": "application/json" });
        const token = source.headers.get("authorization");
        if (!token) throw new Error("A parent invocation is required");
        headers.set("authorization", token);
        for (const name of ["x-cloud-locale", "traceparent", "tracestate"]) {
          const value = source.headers.get(name);
          if (value) headers.set(name, value);
        }
        return fetch(new URL("/api/_internal/identity/v1/invoke-child", request.url), {
          method: "POST",
          headers,
          signal: request.signal,
          redirect: "error",
          body: JSON.stringify({ targetApp: decodeURIComponent(match[1]!), capabilityId: decodeURIComponent(match[2]!), input }),
        });
      },
    });
  };
