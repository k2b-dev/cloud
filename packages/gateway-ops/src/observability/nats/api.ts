import { ok } from "@k2b/stdlib";
import { type AuthContext, auth, rateLimit, respond, v } from "@k2b/cloud/server";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { NatsQuerySchema, readNatsDiagnostics } from "./diagnostics";

const natsApiRoutes = new Hono<AuthContext>()
  .use(rateLimit())
  .use(auth.requireRole("admin"))
  .use(auth.requireOAuthScope("admin"))
  .get(
    "/",
    describeRoute({
      tags: ["NATS"],
      summary: "Inspect NATS nodes, streams and consumers",
      description:
        "Read-only bounded account inventory. Filters apply before pagination. Partial snapshots never prove absent resources are healthy. No message payloads or credentials are returned.",
    }),
    v("query", NatsQuerySchema),
    async (c) => respond(c, ok(await readNatsDiagnostics(c.req.valid("query")))),
  );

export type NatsApiType = typeof natsApiRoutes;
export default natsApiRoutes;
