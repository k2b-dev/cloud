import { ErrorResponseSchema } from "@valentinkolb/cloud/contracts";
import { type AuthContext, getLocale, jsonResponse, respond } from "@valentinkolb/cloud/server";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { ShortIdSchema } from "../contracts";
import { gridsService } from "../service";
import {
  CreateFormSchema,
  FormListSchema,
  FormSchema,
  FormSubmitSchema,
  fromPublicFormConfig,
  type SubmitFormDeps,
  submitFormResponse,
  UpdateFormSchema,
} from "./form-api-shared";
import { apiMessages } from "./messages";
import { currentActorUserId, currentActorViewer, gateAt } from "./permissions";
import { toPublicForm, toPublicForms } from "./public-dto";
import { resolvePublicIdParam, resolveStoredPublicIdParam } from "./route-params";
import { v } from "./validator";

type AuthenticatedFormRoutesDeps = SubmitFormDeps & {
  service?: typeof gridsService;
  gate?: typeof gateAt;
  actorId?: typeof currentActorUserId;
  resolveId?: typeof resolvePublicIdParam;
  resolveStoredId?: typeof resolveStoredPublicIdParam;
  projectForm?: typeof toPublicForm;
  projectForms?: typeof toPublicForms;
};

export const createAuthenticatedFormRoutes = (deps: AuthenticatedFormRoutesDeps = {}) => {
  const service = deps.service ?? gridsService;
  const gateAtTarget = deps.gate ?? gateAt;
  const actorId = deps.actorId ?? currentActorUserId;
  const resolveId = deps.resolveId ?? resolvePublicIdParam;
  const resolveStoredId = deps.resolveStoredId ?? resolveStoredPublicIdParam;
  const projectForm = deps.projectForm ?? toPublicForm;
  const projectForms = deps.projectForms ?? toPublicForms;

  return new Hono<AuthContext>()
    .get(
      "/by-table/:tableId",
      describeRoute({
        tags: ["Grids:Form"],
        summary: "List custom forms for a table (default form is virtual; use /default)",
        responses: { 200: jsonResponse(FormListSchema, "Forms") },
      }),
      async (context) => {
        const tableId = await resolveId(context, "tableId", "table");
        if (!tableId) return context.json({ message: apiMessages(context).invalidTableId }, 400);
        const table = await service.table.get(tableId);
        if (!table) return context.json({ message: apiMessages(context).tableNotFound }, 404);
        const gate = await gateAtTarget(context, { baseId: table.baseId }, "read");
        if (!gate.ok) return respond(context, () => Promise.resolve(gate));
        return context.json(await projectForms(await service.form.listForTable(tableId)));
      },
    )
    .get(
      "/by-table/:tableId/default",
      describeRoute({
        tags: ["Grids:Form"],
        summary: "Fetch the virtual default form for a table",
        responses: { 200: jsonResponse(FormSchema, "Default form") },
      }),
      async (context) => {
        const tableId = await resolveId(context, "tableId", "table");
        if (!tableId) return context.json({ message: apiMessages(context).invalidTableId }, 400);
        const table = await service.table.get(tableId);
        if (!table) return context.json({ message: apiMessages(context).tableNotFound }, 404);
        const gate = await gateAtTarget(context, { baseId: table.baseId }, "read");
        if (!gate.ok) return respond(context, () => Promise.resolve(gate));
        return context.json(await projectForm(await service.form.buildDefault(tableId, getLocale(context))));
      },
    )
    .post(
      "/:formId/submit",
      describeRoute({
        tags: ["Grids:Form"],
        summary: "Submit a form with authenticated Base write access",
        responses: {
          201: jsonResponse(z.object({ recordId: ShortIdSchema }), "Created"),
          400: jsonResponse(ErrorResponseSchema, "Invalid input"),
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
          404: jsonResponse(ErrorResponseSchema, "Not found"),
        },
      }),
      v("json", FormSubmitSchema),
      async (context) => {
        const formId = await resolveId(context, "formId", "form");
        if (!formId) return context.json({ message: apiMessages(context).invalidFormId }, 400);
        const form = await service.form.get(formId);
        if (!form || !form.isActive) return context.json({ message: apiMessages(context).formNotFound }, 404);
        const table = await service.table.get(form.tableId);
        if (!table) return context.json({ message: apiMessages(context).formNotFound }, 404);
        const gate = await gateAtTarget(context, { baseId: table.baseId }, "write");
        if (!gate.ok) return respond(context, () => Promise.resolve(gate));
        return submitFormResponse(context, form, context.req.valid("json"), actorId(context), deps, currentActorViewer(context));
      },
    )
    .get(
      "/:formId",
      describeRoute({
        tags: ["Grids:Form"],
        summary: "Get a single form",
        responses: {
          200: jsonResponse(FormSchema, "Form"),
          404: jsonResponse(ErrorResponseSchema, "Not found"),
        },
      }),
      async (context) => {
        const formId = await resolveId(context, "formId", "form");
        if (!formId) return context.json({ message: apiMessages(context).invalidFormId }, 400);
        const form = await service.form.get(formId);
        if (!form) return context.json({ message: apiMessages(context).formNotFound }, 404);
        const table = await service.table.get(form.tableId);
        if (!table) return context.json({ message: apiMessages(context).formNotFound }, 404);
        const tableGate = await gateAtTarget(context, { baseId: table.baseId }, "read");
        if (!tableGate.ok) return respond(context, () => Promise.resolve(tableGate));
        return context.json(await projectForm(form));
      },
    )
    .post(
      "/by-table/:tableId",
      describeRoute({
        tags: ["Grids:Form"],
        summary: "Create a custom form",
        responses: {
          201: jsonResponse(FormSchema, "Created"),
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        },
      }),
      v("json", CreateFormSchema),
      async (context) => {
        const tableId = await resolveId(context, "tableId", "table");
        if (!tableId) return context.json({ message: apiMessages(context).invalidTableId }, 400);
        const table = await service.table.get(tableId);
        if (!table) return context.json({ message: apiMessages(context).tableNotFound }, 404);
        const gate = await gateAtTarget(context, { baseId: table.baseId }, "admin");
        if (!gate.ok) return respond(context, () => Promise.resolve(gate));
        const body = context.req.valid("json");
        const config = body.config ? await fromPublicFormConfig(tableId, body.config) : undefined;
        if (body.config && !config) return context.json({ message: apiMessages(context).invalidFormFieldId }, 400);
        const result = await service.form.create({ ...body, tableId, config: config ?? undefined }, actorId(context), getLocale(context));
        if (!result.ok) return respond(context, () => Promise.resolve(result), 201);
        return context.json(await projectForm(result.data), 201);
      },
    )
    .patch(
      "/:formId",
      describeRoute({
        tags: ["Grids:Form"],
        summary: "Update a form",
        responses: { 200: jsonResponse(FormSchema, "Updated") },
      }),
      v("json", UpdateFormSchema),
      async (context) => {
        const formId = await resolveId(context, "formId", "form");
        if (!formId) return context.json({ message: apiMessages(context).invalidFormId }, 400);
        const form = await service.form.get(formId);
        if (!form) return context.json({ message: apiMessages(context).formNotFound }, 404);
        const table = await service.table.get(form.tableId);
        if (!table) return context.json({ message: apiMessages(context).tableNotFound }, 404);
        const gate = await gateAtTarget(context, { baseId: table.baseId }, "admin");
        if (!gate.ok) return respond(context, () => Promise.resolve(gate));
        const body = context.req.valid("json");
        const config = body.config ? await fromPublicFormConfig(form.tableId, body.config) : undefined;
        if (body.config && !config) return context.json({ message: apiMessages(context).invalidFormFieldId }, 400);
        const result = await service.form.update(formId, { ...body, config: config ?? undefined }, actorId(context), getLocale(context));
        if (!result.ok) return respond(context, () => Promise.resolve(result));
        return context.json(await projectForm(result.data));
      },
    )
    .delete(
      "/:formId",
      describeRoute({
        tags: ["Grids:Form"],
        summary: "Move a form to trash",
        responses: { 204: { description: "Moved to trash" } },
      }),
      async (context) => {
        const formId = await resolveId(context, "formId", "form");
        if (!formId) return context.json({ message: apiMessages(context).invalidFormId }, 400);
        const form = await service.form.get(formId);
        if (!form) return context.json({ message: apiMessages(context).formNotFound }, 404);
        const table = await service.table.get(form.tableId);
        if (!table) return context.json({ message: apiMessages(context).tableNotFound }, 404);
        const gate = await gateAtTarget(context, { baseId: table.baseId }, "admin");
        if (!gate.ok) return respond(context, () => Promise.resolve(gate));
        const result = await service.form.remove(formId, actorId(context), getLocale(context));
        if (!result.ok) return context.json({ message: result.error.message }, result.error.status);
        return context.body(null, 204);
      },
    )
    .post(
      "/:formId/restore",
      describeRoute({
        tags: ["Grids:Form"],
        summary: "Restore a soft-deleted form",
        responses: {
          200: jsonResponse(FormSchema, "Restored"),
          404: jsonResponse(ErrorResponseSchema, "Not found"),
        },
      }),
      async (context) => {
        const formId = await resolveStoredId(context, "formId", "form");
        if (!formId) return context.json({ message: apiMessages(context).invalidFormId }, 400);
        const form = await service.form.get(formId, { includeDeleted: true });
        if (!form) return context.json({ message: apiMessages(context).formNotFound }, 404);
        const table = await service.table.get(form.tableId);
        if (!table) return context.json({ message: apiMessages(context).tableNotFound }, 404);
        const gate = await gateAtTarget(context, { baseId: table.baseId }, "admin");
        if (!gate.ok) return respond(context, () => Promise.resolve(gate));
        const result = await service.form.restore(formId, actorId(context), getLocale(context));
        if (!result.ok) return respond(context, () => Promise.resolve(result));
        return context.json(await projectForm(result.data));
      },
    );
};

export const authenticatedFormRoutes = createAuthenticatedFormRoutes();
