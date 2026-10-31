import { Hono, type MiddlewareHandler } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { type AuthContext, auth, respond, v } from "../server";
import { noTransform } from "../server/middleware/no-transform";
import { appDomains } from "../services/app-domains";
import { logger } from "../services/logging";

const appParams = z.object({ appId: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/) });
const domainParams = appParams.extend({ host: z.string().max(1024) });
const host = z.string().max(1024);
const addInput = z.object({ host, redirectTo: host.optional() }).strict();
const setInput = z.object({ redirectTo: host.nullable() }).strict();
const describe = (summary: string) => describeRoute({ tags: ["App domains"], summary });

export const createAdminAppDomainRoutes = (
  authenticate: MiddlewareHandler<AuthContext> = auth.requireRole("admin"),
  service: typeof appDomains = appDomains,
) =>
  new Hono<AuthContext>()
    .use("/:appId/domains/*", noTransform())
    .use("/:appId/domains/*", authenticate)
    .use("/:appId/domains/*", async (c, next) => {
      c.header("Cache-Control", "no-store");
      if (c.req.method !== "GET") return auth.requireOAuthScope("admin")(c, next);
      return next();
    })
    .get("/:appId/domains", describe("List assigned domains and their last check"), v("param", appParams), (c) =>
      respond(c, () => service.list({ actor: c.get("user"), ...c.req.valid("param") })),
    )
    .post(
      "/:appId/domains",
      describe("Assign a domain and start its first check in the background"),
      v("param", appParams),
      v("json", addInput),
      async (c) => {
        const input = { actor: c.get("user"), ...c.req.valid("param"), ...c.req.valid("json") };
        const result = await service.add(input);
        if (result.ok)
          void service.check({ ...input, host: result.data.host }).catch((error: unknown) => {
            logger("core:app-domains").error("Initial domain check failed; retry through the domain check endpoint", {
              host: result.data.host,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        return respond(c, result, 201);
      },
    )
    .patch("/:appId/domains/:host", describe("Change or clear the domain redirect"), v("param", domainParams), v("json", setInput), (c) =>
      respond(c, () => service.set({ actor: c.get("user"), ...c.req.valid("param"), ...c.req.valid("json") })),
    )
    .delete("/:appId/domains/:host", describe("Remove an unreferenced domain assignment"), v("param", domainParams), (c) =>
      respond(c, () => service.remove({ actor: c.get("user"), ...c.req.valid("param") })),
    )
    .post(
      "/:appId/domains/:host/check",
      describe("Check DNS, certificate and gateway reachability, at most once per 60 seconds"),
      v("param", domainParams),
      (c) => respond(c, () => service.check({ actor: c.get("user"), ...c.req.valid("param") })),
    );

export default createAdminAppDomainRoutes();
