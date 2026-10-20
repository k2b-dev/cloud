import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { CapabilityAppIdSchema } from "../contracts/capabilities";
import { panelProviderNeedsConsent } from "../contracts/panel-context-plain";
import { type AuthContext, jsonResponse, requiresAuth, v } from "../server";
import { PanelConsentCancelled, panelContextConsent } from "../services/panel-context-consent";
import { getRuntimeContext } from "../ssr/runtime";

const AnswerSchema = z.object({ allowed: z.boolean(), revision: z.number().int().min(0).max(2_147_483_647) }).strict();
const AnswersSchema = z.object({ answers: z.record(CapabilityAppIdSchema, AnswerSchema) }).strict();
const ProviderSchema = z.object({ provider: CapabilityAppIdSchema }).strict();
const SavedSchema = ProviderSchema.extend(AnswerSchema.shape).strict();

/** Mounted below /me's session and user guards. The live request registry owns provider membership. */
export const createMePanelConsentRoutes = (service = panelContextConsent) => {
  const providers = (c: Parameters<typeof getRuntimeContext>[0]) =>
    getRuntimeContext(c)
      .apps.filter((app) => app.panel && panelProviderNeedsConsent(app.id))
      .map((app) => app.id);
  return new Hono<AuthContext>()
    .use("*", async (c, next) => {
      c.header("Cache-Control", "no-store");
      if (!c.get("user")) return c.json({ message: "Authentication required" }, 401);
      await next();
    })
    .get(
      "/panel-consent",
      describeRoute({
        tags: ["Me"],
        summary: "Read personal panel context answers",
        ...requiresAuth,
        responses: { 200: jsonResponse(AnswersSchema, "Answers for registered panel providers") },
      }),
      async (c) => c.json({ answers: await service.list(c.get("user").id, providers(c)) }),
    )
    .put(
      "/panel-consent/:provider",
      describeRoute({
        tags: ["Me"],
        summary: "Save a personal panel context answer",
        ...requiresAuth,
        responses: {
          200: jsonResponse(SavedSchema, "Saved answer"),
          404: { description: "Panel provider not found" },
          409: { description: "Answer changed since it was read" },
        },
      }),
      // The answer and revision fit within 256 bytes, including ordinary JSON whitespace.
      bodyLimit({ maxSize: 256 }),
      v("param", ProviderSchema),
      v("json", AnswerSchema),
      async (c) => {
        const { provider } = c.req.valid("param");
        if (!providers(c).includes(provider)) return c.json({ code: "PANEL_PROVIDER_NOT_FOUND", message: "Panel provider not found" }, 404);
        const { allowed, revision } = c.req.valid("json");
        let saved: Awaited<ReturnType<typeof service.set>>;
        try {
          saved = await service.set(c.get("user").id, provider, allowed, revision, c.req.raw.signal);
        } catch (error) {
          // The browser stopped waiting; the save was rolled back and nobody reads this answer.
          if (error instanceof PanelConsentCancelled) return c.json({ code: "CANCELLED", message: "Request cancelled" }, 503);
          throw error;
        }
        return saved
          ? c.json({ provider, ...saved })
          : c.json({ code: "CONFLICT", message: "Panel consent changed. Read the current answer before saving again." }, 409);
      },
    );
};
