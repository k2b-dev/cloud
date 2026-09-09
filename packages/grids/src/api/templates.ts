import { ErrorResponseSchema } from "@k2b/cloud/contracts";
import { type AuthContext, auth, getLocale, jsonResponse, respond } from "@k2b/cloud/server";
import { Hono, type MiddlewareHandler } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { gridsService } from "../service";
import { apiMessages } from "./messages";
import { currentActorUser, gateCredentialScope } from "./permissions";
import { PublicBaseSchema, toPublicBase } from "./public-dto";
import { v } from "./validator";

const TemplateSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  highlights: z.tuple([z.string(), z.string(), z.string()]),
  icon: z.string(),
});

const TemplateListSchema = z.array(TemplateSummarySchema);

const InstantiateTemplateSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  withSampleData: z.boolean().optional(),
});

export const createTemplatesApi = (deps: { requireAuthenticated?: MiddlewareHandler<AuthContext> } = {}) =>
  new Hono<AuthContext>()
    .use(deps.requireAuthenticated ?? auth.requireRole("authenticated"))

    .get(
      "/",
      describeRoute({
        tags: ["Grids:Templates"],
        summary: "List built-in base templates",
        responses: { 200: jsonResponse(TemplateListSchema, "Templates") },
      }),
      (c) => c.json(gridsService.template.list(getLocale(c))),
    )

    .post(
      "/:templateId",
      describeRoute({
        tags: ["Grids:Templates"],
        summary: "Create a base from a built-in template",
        responses: {
          201: jsonResponse(PublicBaseSchema, "Created base"),
          400: jsonResponse(ErrorResponseSchema, "Invalid template"),
          404: jsonResponse(ErrorResponseSchema, "Template not found"),
        },
      }),
      v("json", InstantiateTemplateSchema),
      async (c) => {
        const scopeGate = await gateCredentialScope(c, "write", { allowResourceBound: false });
        if (!scopeGate.ok) return respond(c, () => Promise.resolve(scopeGate));
        const user = currentActorUser(c);
        if (!user) return c.json({ message: apiMessages(c).signInToCreateBaseFromTemplate }, 403);
        const body = c.req.valid("json");
        const result = await gridsService.template.instantiate(
          c.req.param("templateId")!,
          { name: body.name, withSampleData: body.withSampleData },
          user.id,
          getLocale(c),
        );
        return result.ok ? c.json(toPublicBase(result.data), 201) : c.json({ message: result.error.message }, result.error.status);
      },
    );

export default createTemplatesApi();
