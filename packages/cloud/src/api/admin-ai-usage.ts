import { Hono, type MiddlewareHandler } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { aiUsage } from "../ai/usage";
import { AiUsageQuerySchema } from "../shared/ai-usage";
import { auth, type AuthContext, v, respond, ok, fail, err } from "../server";

export const createAdminAiUsageRoutes = (
  authenticate: MiddlewareHandler<AuthContext> = auth.requireRole("admin"),
  service: typeof aiUsage = aiUsage,
) =>
  new Hono<AuthContext>()
    .use("*", authenticate)
    .get(
      "/report",
      describeRoute({ summary: "Explore AI usage, feedback and runs", tags: ["Admin AI usage"] }),
      v("query", AiUsageQuerySchema.strict()),
      async (c) => {
        const q = c.req.valid("query");
        return respond(c, ok(await service.report(q.range, q)));
      },
    )
    .get(
      "/facets",
      describeRoute({ summary: "Find AI usage filter values", tags: ["Admin AI usage"] }),
      v("query", AiUsageQuerySchema.extend({ field: z.enum(["userId", "modelProfileId", "providerModel", "appId", "task"]) }).strict()),
      async (c) => {
        const q = c.req.valid("query");
        return respond(c, ok({ items: await service.facets(q.field, q.search ?? "", q) }));
      },
    )
    .get(
      "/runs/:kind/:id",
      describeRoute({ summary: "Read an AI run and its stored error", tags: ["Admin AI usage"] }),
      v("param", z.object({ kind: z.enum(["chat", "background", "tool"]), id: z.uuid() })),
      async (c) => {
        const { kind, id } = c.req.valid("param");
        const result = await service.detail(kind, id);
        return result ? respond(c, ok(result)) : respond(c, fail(err.notFound("AI run")));
      },
    );
export default createAdminAiUsageRoutes();
