import { Hono, type MiddlewareHandler } from "hono";
import { aiQuotas, AiQuotaError } from "../ai/quotas";
import { quotaReport, quotaAdminConfig } from "../ai/quota-report";
import { AiQuotaReportQuerySchema } from "../shared/ai-quotas";
import { AiQuotaConfigSchema, AiQuotaIdentitySchema, AiQuotaResetSchema, AiQuotaUsersQuerySchema } from "../shared/ai-quotas";
import { type AuthContext, auth, v } from "../server";
import { listAiModels } from "../ai/settings";
const subject = (p: { type: "user" | "service_account"; id: string }) =>
  p.type === "user" ? { type: "user" as const, userId: p.id } : { type: "service_account" as const, serviceAccountId: p.id };
export const createAdminAiQuotaRoutes = (authenticate: MiddlewareHandler<AuthContext> = auth.requireRole("admin")) =>
  new Hono<AuthContext>()
    .use("*", authenticate)
    .onError((error, c) => {
      if (error instanceof AiQuotaError) return c.json({ error: error.code, message: error.message }, 409);
      throw error;
    })
    .get("/", async (c) => c.json(await quotaAdminConfig()))
    .get("/models", async (c) => c.json({ models: (await listAiModels()).map((m) => ({ id: m.id, label: m.label })) }))
    .get("/report", v("query", AiQuotaReportQuerySchema), async (c) => c.json(await quotaReport(c.req.valid("query"))))
    .put("/", v("json", AiQuotaConfigSchema), async (c) => {
      const config = c.req.valid("json"),
        models = await listAiModels(),
        previous = await aiQuotas.config();
      if (
        config.rules.some(
          (r) => r.scope !== "*" && !models.some((m) => m.id === r.scope) && !previous.rules.some((old) => old.scope === r.scope),
        )
      )
        return c.json({ message: "Select an available chat model or all chat models." }, 400);
      return c.json(await aiQuotas.save(config, c.get("user")!.id));
    })
    .get("/users", v("query", AiQuotaUsersQuerySchema), async (c) => {
      const q = c.req.valid("query");
      return c.json(await aiQuotas.users(q.search, q.page));
    })
    .get("/balance", v("query", AiQuotaIdentitySchema.strict()), async (c) =>
      c.json(await aiQuotas.snapshot(subject(c.req.valid("query")))),
    )
    .post("/reset", v("json", AiQuotaResetSchema), async (c) => {
      const p = c.req.valid("json");
      if (!(await aiQuotas.config()).rules.some((r) => r.scope === p.scope))
        return c.json({ message: "Quota scope no longer exists." }, 409);
      await aiQuotas.reset(subject(p), p.scope, p.requestId, c.get("user")!.id);
      return c.json(await aiQuotas.snapshot(subject(p)));
    });
export default createAdminAiQuotaRoutes();
