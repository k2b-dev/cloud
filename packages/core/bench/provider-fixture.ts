import { spyOn } from "bun:test";
import assert from "node:assert/strict";
import { UniversalSearchInputSchema } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import * as identity from "@k2b/cloud/services/identity";
import { getIdentityRuntimeConfig, invalidateIdentityRuntimeConfig } from "@k2b/cloud/services/identity/runtime-config";
import { redis } from "bun";
import { Hono } from "hono";
import { z } from "zod";
import { requireInvocation } from "../../cloud/src/server/middleware/invocation";

const Configuration = z.object({
  userId: z.string().uuid(),
  latencyMs: z.number().nonnegative(),
  targets: z.array(z.object({ appId: z.string(), schemaHash: z.string().nullable() })).max(30),
});
export const ProviderStats = z.object({
  targetVerification: z.number().nonnegative(),
  targetActor: z.number().nonnegative(),
  requests: z.number().int().nonnegative(),
  redis: z.record(z.string(), z.number().int().nonnegative()),
});
const emptyStats = (): z.infer<typeof ProviderStats> => ({ targetVerification: 0, targetActor: 0, requests: 0, redis: {} });
export const providerResult = (appId: string) => ({
  data: [{ ref: { type: `${appId}.item`, id: "fixture" }, title: appId, links: [{ rel: "open", href: `/app/${appId}/fixture` }] }],
});

// Identical handlers in both topologies. Control requests are loopback-only,
// outside measured requests, in the runner's disposable offline namespace.
export const createProviderFixture = (observeRedis: boolean) => {
  let stats = emptyStats();
  let targets = new Map<string, Hono<AuthContext>>();
  const increment = (key: string) => {
    stats.redis[key] = (stats.redis[key] ?? 0) + 1;
  };
  const rawGet = redis.get.bind(redis);
  const rawSend = redis.send.bind(redis);
  const getSpy = observeRedis
    ? spyOn(redis, "get").mockImplementation((key) => {
        increment(String(key).startsWith("session:") ? "redis.session_get" : "redis.other_get");
        return rawGet(key);
      })
    : undefined;
  const sendSpy = observeRedis
    ? spyOn(redis, "send").mockImplementation((command, args) => {
        increment(`redis.${command.toLowerCase()}`);
        return rawSend(command, args);
      })
    : undefined;
  return {
    dispose: () => {
      getSpy?.mockRestore();
      sendSpy?.mockRestore();
    },
    fetch: async (request: Request): Promise<Response> => {
      const path = new URL(request.url).pathname;
      if (request.method === "POST" && path === "/_bench/configure") {
        const config = Configuration.parse(await request.json());
        targets = new Map(
          config.targets.map(({ appId, schemaHash }) => [
            appId,
            new Hono<AuthContext>()
              .use(
                requireInvocation(() => ({ targetAppId: appId, operation: "search.query", schemaHash }), {
                  verify: async (...args) => {
                    const start = performance.now();
                    try {
                      return await identity.verifyInvocationToken(...args);
                    } finally {
                      stats.targetVerification += performance.now() - start;
                    }
                  },
                  resolve: async (...args) => {
                    const start = performance.now();
                    try {
                      return await identity.resolveInvocationAuthority(...args);
                    } finally {
                      stats.targetActor += performance.now() - start;
                    }
                  },
                }),
              )
              .post("*", async (c) => {
                assert.equal(c.get("user").id, config.userId);
                const body = UniversalSearchInputSchema.parse((await c.req.json()).input);
                assert.equal(body.query, "needle");
                stats.requests += 1;
                await Bun.sleep(config.latencyMs);
                return c.json(providerResult(appId));
              }),
          ]),
        );
        return Response.json({ ok: true });
      }
      if (request.method === "POST" && path === "/_bench/reset") {
        stats = emptyStats();
        return Response.json({ ok: true });
      }
      if (request.method === "POST" && path === "/_bench/warm") {
        invalidateIdentityRuntimeConfig();
        await getIdentityRuntimeConfig();
        return Response.json({ ok: true });
      }
      if (request.method === "GET" && path === "/_bench/stats") return Response.json(stats);
      const target = targets.get(path.split("/")[1]!);
      return target ? target.fetch(request) : new Response("Unknown benchmark provider", { status: 404 });
    },
  };
};
