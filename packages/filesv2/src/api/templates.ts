import { type AuthContext, middleware, requiresAdmin, requiresAuth, respond, v } from "@k2b/cloud/server";
import { ok } from "@k2b/stdlib";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { TEMPLATE_LIMIT } from "../document-assets";
import { templateService as service } from "../service/templates";
import {
  TemplateFileSchema,
  TemplateGrantSchema,
  TemplateImportSchema,
  TemplateQuerySchema,
  TemplateUpdateSchema,
  TemplateUploadSchema,
  TemplateUseSchema,
} from "../template-contracts";

const id = v("param", z.object({ id: z.string().uuid() }));
export const templateApi = new Hono<AuthContext>()
  .use(bodyLimit({ maxSize: Math.ceil((TEMPLATE_LIMIT * 4) / 3) + 16_384 }))
  .get("/", middleware.openapi({ summary: "List usable file templates", ...requiresAuth }), v("query", TemplateQuerySchema), async (c) =>
    respond(c, ok(await service.list(c.get("actor"), c.get("accessSubject"), c.req.valid("query")))),
  )
  .get("/admin", middleware.openapi({ summary: "List all file templates", ...requiresAdmin }), v("query", TemplateQuerySchema), async (c) =>
    respond(c, ok(await service.list(c.get("actor"), c.get("accessSubject"), c.req.valid("query"), true))),
  )
  .post(
    "/admin",
    middleware.openapi({ summary: "Upload an independent template snapshot", ...requiresAdmin }),
    v("json", TemplateUploadSchema),
    async (c) => respond(c, ok(await service.upload(c.get("actor"), c.req.valid("json")))),
  )
  .post(
    "/admin/import",
    middleware.openapi({ summary: "Import an independent template from an accessible file", ...requiresAdmin }),
    v("json", TemplateImportSchema),
    async (c) => respond(c, ok(await service.import(c.get("actor"), c.req.valid("json")))),
  )
  .patch(
    "/admin/:id",
    middleware.openapi({ summary: "Update template metadata and optional snapshot", ...requiresAdmin }),
    id,
    v("json", TemplateUpdateSchema),
    async (c) => respond(c, ok(await service.update(c.get("actor"), c.req.valid("param").id, c.req.valid("json")))),
  )
  .put(
    "/admin/:id/content",
    middleware.openapi({ summary: "Replace a template snapshot", ...requiresAdmin }),
    id,
    v("json", TemplateFileSchema),
    async (c) => respond(c, ok(await service.replace(c.get("actor"), c.req.valid("param").id, c.req.valid("json")))),
  )
  .delete(
    "/admin/:id",
    middleware.openapi({ summary: "Delete a template without affecting created files", ...requiresAdmin }),
    id,
    async (c) => respond(c, ok(await service.remove(c.get("actor"), c.req.valid("param").id))),
  )
  .get("/admin/:id/grants", middleware.openapi({ summary: "Read template permissions", ...requiresAdmin }), id, async (c) =>
    respond(c, ok(await service.grants(c.get("actor"), c.req.valid("param").id))),
  )
  .post(
    "/admin/:id/grants",
    middleware.openapi({ summary: "Grant template use", ...requiresAdmin }),
    id,
    v("json", TemplateGrantSchema),
    async (c) => respond(c, ok(await service.grant(c.get("actor"), c.req.valid("param").id, c.req.valid("json").principal))),
  )
  .delete(
    "/admin/:id/grants/:accessId",
    middleware.openapi({ summary: "Revoke template use", ...requiresAdmin }),
    v("param", z.object({ id: z.string().uuid(), accessId: z.string().uuid() })),
    async (c) => respond(c, ok(await service.revoke(c.get("actor"), c.req.valid("param").id, c.req.valid("param").accessId))),
  )
  .get("/:id", middleware.openapi({ summary: "Read usable template metadata", ...requiresAuth }), id, async (c) =>
    respond(c, ok(await service.get(c.get("actor"), c.get("accessSubject"), c.req.valid("param").id))),
  )
  .post(
    "/:id/use",
    middleware.openapi({ summary: "Create a file from an authorized template", ...requiresAuth }),
    id,
    v("json", TemplateUseSchema),
    async (c) => respond(c, ok(await service.use(c.get("actor"), c.get("accessSubject"), c.req.valid("param").id, c.req.valid("json")))),
  );
