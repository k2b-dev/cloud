import { ErrorResponseSchema } from "@k2b/cloud/contracts";
import { expectUserBackedActor, jsonResponse, requiresAuth, v } from "@k2b/cloud/server";
import { settingsService } from "@k2b/cloud/services";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import type { MailApiContext } from "./public-resource-boundary";

export const WORKFLOW_AI_BODY_MAX_CHARS_KEY = "mail.workflow_ai_body_max_chars";

const workflowAiSettingsSchema = z.object({
  bodyMaxChars: z.number().describe("Maximum body characters loaded for one AI workflow step"),
  replaceUnreadable: z.boolean().optional().describe("Explicitly replace a stored value this application cannot read"),
});

// Mounted below the Cloud-admin guard of the Mail admin API. The setting declaration validates the value.
export default new Hono<MailApiContext>().put(
  "/admin/workflow-ai",
  describeRoute({
    tags: ["Mail:Admin"],
    summary: "Set the body limit of AI workflow steps",
    description: "Stores `mail.workflow_ai_body_max_chars`. New AI steps use it; a larger body fails visibly instead of being truncated.",
    ...requiresAuth,
    responses: {
      200: jsonResponse(workflowAiSettingsSchema.pick({ bodyMaxChars: true }), "Stored limit"),
      400: jsonResponse(ErrorResponseSchema, "Value outside the declared range"),
      403: jsonResponse(ErrorResponseSchema, "Cloud administration access is required"),
      409: jsonResponse(
        z.object({ code: z.literal("setting_unreadable"), message: z.string() }),
        "Stored value needs explicit replacement",
      ),
    },
  }),
  v("json", workflowAiSettingsSchema),
  async (c) => {
    const { bodyMaxChars, replaceUnreadable } = c.req.valid("json");
    const result = await settingsService.entry.update({
      key: WORKFLOW_AI_BODY_MAX_CHARS_KEY,
      value: bodyMaxChars,
      replaceUnreadable,
      audit: {
        action: "settings.update",
        outcome: "allowed",
        actor: { userId: expectUserBackedActor(c).id },
        target: { type: "setting", id: WORKFLOW_AI_BODY_MAX_CHARS_KEY },
      },
    });
    if (!result.ok) return c.json({ message: result.error.message }, result.error.status === 400 ? 400 : 500);
    return c.json({ bodyMaxChars }, 200);
  },
);
