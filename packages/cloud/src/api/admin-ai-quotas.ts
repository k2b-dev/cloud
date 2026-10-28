import { sql } from "bun";
import { Hono, type MiddlewareHandler } from "hono";
import { AiBackgroundCostError, backgroundCostState, releaseBackgroundCostStop } from "../ai/inference-calls";
import { quotaAdminConfig, quotaReport } from "../ai/quota-report";
import { AiQuotaError, aiQuotas } from "../ai/quotas";
import { readAiSettingsState } from "../ai/settings";
import { type AuthContext, auth, v } from "../server";
import { hasBillableAiPricing } from "../shared/ai-costs";
import {
  AiQuotaConfigSchema,
  AiQuotaIdentitySchema,
  AiQuotaReportQuerySchema,
  AiQuotaResetSchema,
  AiQuotaUsersQuerySchema,
} from "../shared/ai-quotas";

const subject = (p: { type: "user" | "service_account"; id: string }) =>
  p.type === "user" ? { type: "user" as const, userId: p.id } : { type: "service_account" as const, serviceAccountId: p.id };
export const createAdminAiQuotaRoutes = (authenticate: MiddlewareHandler<AuthContext> = auth.requireRole("admin")) =>
  new Hono<AuthContext>()
    .use("*", authenticate)
    .onError(async (error, c) => {
      if (error instanceof AiQuotaError && error.code === "quota_conflict") {
        const current = await quotaAdminConfig();
        const [change] = await sql<
          { id: string | null; name: string | null; changedAt: string }[]
        >`SELECT u.id,COALESCE(NULLIF(u.display_name,''),u.uid) AS name,to_char(c.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "changedAt" FROM ai.cost_changes c LEFT JOIN auth.users u ON u.id=c.actor_id WHERE c.revision=${current.revision} ORDER BY c.created_at DESC LIMIT 1`;
        return c.json(
          {
            code: "conflict",
            current,
            changedBy: change?.id ? { id: change.id, name: change.name ?? change.id } : null,
            changedAt: change?.changedAt ?? new Date(0).toISOString(),
          },
          409,
        );
      }
      if (error instanceof AiQuotaError || error instanceof AiBackgroundCostError)
        return c.json({ error: error.code, message: error.message }, 409);
      throw error;
    })
    .get("/", async (c) => c.json(await quotaAdminConfig()))
    .get("/models", async (c) =>
      c.json({
        unit: (await aiQuotas.config()).unit ?? "EUR",
        models: (await readAiSettingsState()).profiles
          .filter((m, index, profiles) => {
            const representative =
              profiles.find((candidate) => candidate.modelId === m.modelId && hasBillableAiPricing(candidate.pricing)) ??
              profiles.find((candidate) => candidate.modelId === m.modelId);
            return profiles.indexOf(representative!) === index;
          })
          .map((m) => ({
            id: m.modelId,
            label: m.label,
            pricing: m.pricing,
            enabled: m.enabled,
            capabilities: m.capabilities,
          })),
      }),
    )
    .get("/background", async (c) => c.json(await backgroundCostState()))
    .post("/background/release", async (c) => c.json(await releaseBackgroundCostStop(c.get("user")!.id)))
    .get("/report", v("query", AiQuotaReportQuerySchema), async (c) => c.json(await quotaReport(c.req.valid("query"))))
    .put("/", v("json", AiQuotaConfigSchema), async (c) => {
      const config = c.req.valid("json"),
        models = (await readAiSettingsState()).profiles.filter(
          (model) => model.enabled && hasBillableAiPricing(model.pricing) && !model.capabilities.includes("transcription"),
        ),
        previous = await aiQuotas.config();
      if (
        config.rules.some(
          (r) => r.scope !== "*" && !models.some((m) => m.modelId === r.scope) && !previous.rules.some((old) => old.scope === r.scope),
        )
      )
        return c.json({ message: "Select an enabled chat model with nonzero prices or all chat models." }, 400);
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
