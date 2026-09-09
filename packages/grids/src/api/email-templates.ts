import { ErrorResponseSchema } from "@k2b/cloud/contracts";
import { type AuthContext, auth, getLocale, jsonResponse, respond } from "@k2b/cloud/server";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { CreateEmailTemplateSchema, UpdateEmailTemplateSchema } from "../contracts";
import { gridsService } from "../service";
import { apiMessages } from "./messages";
import { currentActorUserId, gateAt } from "./permissions";
import {
  PublicEmailTemplateDependencyMapSchema,
  PublicEmailTemplateListSchema,
  PublicEmailTemplateSchema,
  toPublicEmailTemplate,
  toPublicEmailTemplateDependencies,
  toPublicEmailTemplates,
} from "./public-email-templates";
import { internalIdParam, requirePublicIdParam, resolvePublicIdParam } from "./route-params";
import { v } from "./validator";

const app = new Hono<AuthContext>()
  .use(auth.requireRole("authenticated"))

  .get(
    "/by-base/:baseId",
    describeRoute({
      tags: ["Grids:EmailTemplates"],
      summary: "List email templates for a base",
      responses: {
        200: jsonResponse(PublicEmailTemplateListSchema, "Email templates"),
        400: jsonResponse(ErrorResponseSchema, "Invalid base id"),
        403: jsonResponse(ErrorResponseSchema, "Forbidden"),
      },
    }),
    async (c) => {
      const baseId = await resolvePublicIdParam(c, "baseId", "base");
      if (!baseId) return c.json({ message: apiMessages(c).invalidBaseId }, 400);
      const gate = await gateAt(c, { baseId }, "admin");
      if (!gate.ok) return respond(c, () => Promise.resolve(gate));
      return c.json(await toPublicEmailTemplates(await gridsService.emailTemplate.listForBase(baseId)));
    },
  )

  .get(
    "/by-base/:baseId/dependencies",
    describeRoute({
      tags: ["Grids:EmailTemplates"],
      summary: "List workflow dependencies for email templates",
      responses: {
        200: jsonResponse(PublicEmailTemplateDependencyMapSchema, "Email template dependencies"),
        400: jsonResponse(ErrorResponseSchema, "Invalid base id"),
        403: jsonResponse(ErrorResponseSchema, "Forbidden"),
      },
    }),
    async (c) => {
      const baseId = await resolvePublicIdParam(c, "baseId", "base");
      if (!baseId) return c.json({ message: apiMessages(c).invalidBaseId }, 400);
      const gate = await gateAt(c, { baseId }, "admin");
      if (!gate.ok) return respond(c, () => Promise.resolve(gate));
      return c.json(await toPublicEmailTemplateDependencies(await gridsService.emailTemplate.listDependenciesForBase(baseId)));
    },
  )

  .post(
    "/by-base/:baseId",
    describeRoute({
      tags: ["Grids:EmailTemplates"],
      summary: "Create an email template",
      responses: {
        201: jsonResponse(PublicEmailTemplateSchema, "Created"),
        400: jsonResponse(ErrorResponseSchema, "Invalid email template"),
        403: jsonResponse(ErrorResponseSchema, "Forbidden"),
      },
    }),
    v("json", CreateEmailTemplateSchema),
    async (c) => {
      const baseId = await resolvePublicIdParam(c, "baseId", "base");
      if (!baseId) return c.json({ message: apiMessages(c).invalidBaseId }, 400);
      const gate = await gateAt(c, { baseId }, "admin");
      if (!gate.ok) return respond(c, () => Promise.resolve(gate));
      const result = await gridsService.emailTemplate.create(baseId, c.req.valid("json"), currentActorUserId(c), getLocale(c));
      if (!result.ok) return respond(c, () => Promise.resolve(result));
      return c.json(await toPublicEmailTemplate(result.data), 201);
    },
  )

  .get(
    "/:templateId",
    requirePublicIdParam("templateId", "emailTemplate", "Email template"),
    describeRoute({
      tags: ["Grids:EmailTemplates"],
      summary: "Get an email template",
      responses: {
        200: jsonResponse(PublicEmailTemplateSchema, "Email template"),
        403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        404: jsonResponse(ErrorResponseSchema, "Not found"),
      },
    }),
    async (c) => {
      const template = await gridsService.emailTemplate.get(internalIdParam(c, "templateId")!);
      if (!template) return c.json({ message: apiMessages(c).emailTemplateNotFound }, 404);
      const gate = await gateAt(c, { baseId: template.baseId }, "admin");
      if (!gate.ok) return respond(c, () => Promise.resolve(gate));
      return c.json(await toPublicEmailTemplate(template));
    },
  )

  .patch(
    "/:templateId",
    requirePublicIdParam("templateId", "emailTemplate", "Email template"),
    describeRoute({
      tags: ["Grids:EmailTemplates"],
      summary: "Update an email template",
      responses: {
        200: jsonResponse(PublicEmailTemplateSchema, "Updated"),
        400: jsonResponse(ErrorResponseSchema, "Invalid email template"),
        403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        404: jsonResponse(ErrorResponseSchema, "Not found"),
      },
    }),
    v("json", UpdateEmailTemplateSchema),
    async (c) => {
      const template = await gridsService.emailTemplate.get(internalIdParam(c, "templateId")!);
      if (!template) return c.json({ message: apiMessages(c).emailTemplateNotFound }, 404);
      const gate = await gateAt(c, { baseId: template.baseId }, "admin");
      if (!gate.ok) return respond(c, () => Promise.resolve(gate));
      const result = await gridsService.emailTemplate.update(template.id, c.req.valid("json"), currentActorUserId(c), getLocale(c));
      if (!result.ok) return respond(c, () => Promise.resolve(result));
      return c.json(await toPublicEmailTemplate(result.data));
    },
  )

  .delete(
    "/:templateId",
    requirePublicIdParam("templateId", "emailTemplate", "Email template"),
    describeRoute({
      tags: ["Grids:EmailTemplates"],
      summary: "Delete an email template",
      responses: {
        204: { description: "Deleted" },
        409: jsonResponse(ErrorResponseSchema, "Email template is in use"),
        403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        404: jsonResponse(ErrorResponseSchema, "Not found"),
      },
    }),
    async (c) => {
      const template = await gridsService.emailTemplate.get(internalIdParam(c, "templateId")!);
      if (!template) return c.json({ message: apiMessages(c).emailTemplateNotFound }, 404);
      const gate = await gateAt(c, { baseId: template.baseId }, "admin");
      if (!gate.ok) return respond(c, () => Promise.resolve(gate));
      const result = await gridsService.emailTemplate.remove(template.id, currentActorUserId(c), getLocale(c));
      if (!result.ok) return c.json({ message: result.error.message }, result.error.status);
      return c.body(null, 204);
    },
  );

export default app;
