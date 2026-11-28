import { type AuthContext, auth, getLocale, rateLimit, respond } from "@k2b/cloud/server";
import { fail, ok } from "@k2b/stdlib";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { isInfrastructureBackend, readInfraSection } from "./sections";

/** One backend's section of the infrastructure overview, for a section that missed the page's first picture. */
const infrastructureApiRoutes = new Hono<AuthContext>()
  .use(rateLimit())
  .use(auth.requireRole("admin"))
  .use(auth.requireOAuthScope("read", "admin"))
  .get(
    "/:backend",
    describeRoute({
      tags: ["Infrastructure"],
      summary: "Read one backend's infrastructure summary",
      description:
        "Key numbers and notices of Postgres, Valkey or NATS as the infrastructure overview shows them. Read-only; no data, keys or messages are returned.",
    }),
    async (c) => {
      const backend = c.req.param("backend");
      if (!isInfrastructureBackend(backend)) return respond(c, fail({ code: "NOT_FOUND", message: "Unknown backend", status: 404 }));
      return respond(c, ok({ section: await readInfraSection(backend, getLocale(c)) }));
    },
  );

export type InfrastructureApiType = typeof infrastructureApiRoutes;
export default infrastructureApiRoutes;
