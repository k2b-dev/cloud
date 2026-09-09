import { ErrorResponseSchema } from "@k2b/cloud/contracts";
import { type AuthContext, auth, getLocale, jsonResponse, respond, v } from "@k2b/cloud/server";
import { type Context, Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { PRESENTATION_MODES } from "../lib/presentation-mode";
import { notebooksService } from "../service";
import { notebookApiMessages } from "./messages";
import { ResourceShortIdSchema, toPublicNotebook } from "./public-resources";

const TemplateSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  icon: z.string(),
});

const TemplateListSchema = z.array(TemplateSummarySchema);

const CreatedNotebookSchema = z.object({
  id: ResourceShortIdSchema,
  name: z.string(),
  description: z.string().nullable(),
  icon: z.string().nullable(),
  homepageNoteId: ResourceShortIdSchema.nullable(),
  defaultPresentationMode: z.enum(PRESENTATION_MODES),
  defaultNoteTitleTemplate: z.string(),
  createdBy: z.uuid().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const InstantiateTemplateSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
});

const getUserBackedActor = (c: Context<AuthContext>) => {
  const actor = c.get("actor");
  return actor.kind === "user" ? actor.user : actor.delegatedUser;
};

const app = new Hono<AuthContext>()
  .use(auth.requireRole("authenticated"))

  .get(
    "/",
    describeRoute({
      tags: ["Notebooks:Templates"],
      summary: "List built-in notebook templates",
      responses: { 200: jsonResponse(TemplateListSchema, "Templates") },
    }),
    (c) => c.json(notebooksService.template.list(getLocale(c))),
  )

  .post(
    "/:templateId",
    describeRoute({
      tags: ["Notebooks:Templates"],
      summary: "Create a notebook from a built-in template",
      responses: {
        201: jsonResponse(CreatedNotebookSchema, "Created notebook"),
        400: jsonResponse(ErrorResponseSchema, "Invalid template"),
        404: jsonResponse(ErrorResponseSchema, "Template not found"),
      },
    }),
    v("json", InstantiateTemplateSchema),
    async (c) => {
      const user = getUserBackedActor(c);
      if (!user) return c.json({ message: notebookApiMessages.resolve([getLocale(c)]).t.userRequired, code: "FORBIDDEN" }, 403);
      const body = c.req.valid("json");
      return respond(
        c,
        async () => {
          const result = await notebooksService.template.instantiate(
            c.req.param("templateId")!,
            { name: body.name },
            user.id,
            getLocale(c),
          );
          return result.ok ? { ...result, data: toPublicNotebook(result.data) } : result;
        },
        201,
      );
    },
  );

export default app;
