import { Hono, type MiddlewareHandler } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { AiBackgroundCostError, backgroundCostState, releaseBackgroundCostStop } from "../ai/inference-calls";
import { setAiModelPricing } from "../ai/model-pricing";
import { AiModelRequestSettingsInvalid, getAiModelRequestSettings, setAiModelRequestSettings } from "../ai/model-request-settings";
import { quotaAdminConfig, quotaReport } from "../ai/quota-report";
import { AiQuotaError, aiQuotas } from "../ai/quotas";
import { readAiSettingsState } from "../ai/settings";
import { type AuthContext, auth, jsonResponse, requiresAdmin, v } from "../server";
import { AiModelPricingSchema, hasBillableAiPricing } from "../shared/ai-costs";
import { AiModelRequestSettingsSchema, AiModelRequestSettingsUpdateSchema } from "../shared/ai-model-request-settings";
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
    .onError((error, c) => {
      if (error instanceof AiModelRequestSettingsInvalid) return c.json({ message: error.message }, 400);
      if (error instanceof AiQuotaError || error instanceof AiBackgroundCostError)
        return c.json({ error: error.code, message: error.message }, 409);
      throw error;
    })
    .get("/", async (c) => c.json(await quotaAdminConfig()))
    .get("/models", async (c) =>
      c.json({
        unit: (await aiQuotas.config()).unit ?? "EUR",
        models: (await readAiSettingsState()).profiles.map((m) => ({
          id: m.id,
          label: m.label,
          pricing: m.pricing,
          enabled: m.enabled,
          capabilities: m.capabilities,
        })),
      }),
    )
    .put(
      "/models/:id/pricing",
      v("json", z.object({ pricing: AiModelPricingSchema.nullable(), expected: AiModelPricingSchema.nullable() }).strict()),
      async (c) => {
        const data = c.req.valid("json");
        return c.json(await setAiModelPricing(c.req.param("id")!, data.pricing, data.expected, c.get("user")!.id));
      },
    )
    .get(
      "/models/:id/settings",
      describeRoute({
        tags: ["Administration"],
        summary: "Read masked model request settings",
        ...requiresAdmin,
        responses: { 200: jsonResponse(AiModelRequestSettingsSchema, "Model request settings (header names only)") },
      }),
      async (c) => {
        c.header("Cache-Control", "no-store");
        return c.json(await getAiModelRequestSettings(c.req.param("id")!));
      },
    )
    .put(
      "/models/:id/settings",
      describeRoute({
        tags: ["Administration"],
        summary: "Patch model request settings with a revision guard",
        ...requiresAdmin,
        responses: {
          200: jsonResponse(AiModelRequestSettingsSchema, "Updated model request settings (header names only)"),
          400: jsonResponse(z.object({ message: z.string() }), "Invalid model request settings"),
          409: jsonResponse(z.object({ message: z.string(), error: z.string() }), "Model request settings changed"),
        },
      }),
      v("json", AiModelRequestSettingsUpdateSchema),
      async (c) => {
        c.header("Cache-Control", "no-store");
        return c.json(await setAiModelRequestSettings(c.req.param("id")!, c.req.valid("json"), c.get("user")!.id));
      },
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
          (r) => r.scope !== "*" && !models.some((m) => m.id === r.scope) && !previous.rules.some((old) => old.scope === r.scope),
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
