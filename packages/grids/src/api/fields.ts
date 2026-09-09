import { ErrorResponseSchema } from "@k2b/cloud/contracts";
import { type AuthContext, auth, getLocale, jsonResponse, respond } from "@k2b/cloud/server";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { ShortIdSchema } from "../contracts";
import { gridsService } from "../service";
import type { FieldDependent } from "../service/field-dependents";
import { type PublicResourceType, projectPublicIds, resolvePublicIds } from "../service/public-resources";
import { apiMessages } from "./messages";
import { currentActorUserId, gateAt } from "./permissions";
import {
  fromPublicFieldWrite,
  PublicCreateFieldSchema,
  PublicFieldListSchema,
  PublicFieldSchema,
  PublicUpdateFieldSchema,
  toPublicField,
  toPublicFields,
} from "./public-dto";
import { internalIdParam, requirePublicIdParam, requireStoredPublicIdParam } from "./route-params";
import { v } from "./validator";

const PublicFieldDependentSchema = z.object({
  type: z.enum(["view", "form", "formula", "lookup", "rollup", "relation_display", "audit_policy", "federation_mapping"]),
  resourceId: ShortIdSchema,
  resourceName: z.string(),
  context: z.string().optional(),
  blocking: z.boolean(),
});
const PublicFieldDependentsResponseSchema = z.object({
  dependents: z.array(PublicFieldDependentSchema),
  hasBlocking: z.boolean(),
});

const dependentResourceType = (dependent: FieldDependent): Extract<PublicResourceType, "field" | "form" | "table" | "view"> => {
  if (dependent.type === "view") return "view";
  if (dependent.type === "form") return "form";
  if (dependent.type === "audit_policy" || dependent.type === "federation_mapping") return "table";
  return "field";
};

const toPublicFieldDependents = async (dependents: readonly FieldDependent[]) => {
  const types = ["field", "form", "table", "view"] as const;
  const projectedByType = new Map(
    await Promise.all(
      types.map(
        async (type) =>
          [
            type,
            await projectPublicIds(
              type,
              dependents.filter((item) => dependentResourceType(item) === type).map((item) => item.resourceId),
            ),
          ] as const,
      ),
    ),
  );
  return dependents.map((dependent) => {
    const publicId = projectedByType.get(dependentResourceType(dependent))?.get(dependent.resourceId);
    if (!publicId) throw new Error(`Cannot project ${dependent.type} dependent ${dependent.resourceId}`);
    return { ...dependent, resourceId: publicId };
  });
};

const app = new Hono<AuthContext>()
  .use(auth.requireRole("authenticated"))

  .get(
    "/by-table/:tableId",
    requirePublicIdParam("tableId", "table", "Table"),
    describeRoute({
      tags: ["Grids:Field"],
      summary: "List fields of a table",
      responses: {
        200: jsonResponse(PublicFieldListSchema, "Fields"),
        403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        404: jsonResponse(ErrorResponseSchema, "Not found"),
      },
    }),
    async (c) => {
      const tableId = internalIdParam(c, "tableId")!;
      const table = await gridsService.table.get(tableId);
      if (!table) return c.json({ message: apiMessages(c).tableNotFound }, 404);
      const gate = await gateAt(c, { baseId: table.baseId }, "read");
      if (!gate.ok) return respond(c, () => Promise.resolve(gate));
      const fields = await gridsService.field.listByTable(tableId);
      return c.json(await toPublicFields(fields));
    },
  )

  .post(
    "/by-table/:tableId/reorder",
    requirePublicIdParam("tableId", "table", "Table"),
    describeRoute({
      tags: ["Grids:Field"],
      summary: "Reorder fields of a table",
      description:
        "Sets each field's `position` to its index in the supplied id list. " + "Ids that don't belong to the table are silently skipped.",
      responses: {
        204: { description: "Reordered" },
        400: jsonResponse(ErrorResponseSchema, "Invalid input"),
        403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        404: jsonResponse(ErrorResponseSchema, "Not found"),
      },
    }),
    v("json", z.object({ fieldIds: z.array(ShortIdSchema).min(1) })),
    async (c) => {
      const tableId = internalIdParam(c, "tableId")!;
      const table = await gridsService.table.get(tableId);
      if (!table) return c.json({ message: apiMessages(c).tableNotFound }, 404);
      const gate = await gateAt(c, { baseId: table.baseId }, "admin");
      if (!gate.ok) return respond(c, () => Promise.resolve(gate));
      const { fieldIds } = c.req.valid("json");
      const resolved = await resolvePublicIds("field", fieldIds);
      if (resolved.size !== new Set(fieldIds).size) return c.json({ message: apiMessages(c).fieldNotFound }, 404);
      const result = await gridsService.field.reorder(
        tableId,
        fieldIds.map((id) => resolved.get(id)!),
        currentActorUserId(c),
        getLocale(c),
      );
      if (!result.ok) return c.json({ message: result.error.message }, result.error.status);
      return c.body(null, 204);
    },
  )

  .post(
    "/by-table/:tableId",
    requirePublicIdParam("tableId", "table", "Table"),
    describeRoute({
      tags: ["Grids:Field"],
      summary: "Create a field",
      responses: {
        201: jsonResponse(PublicFieldSchema, "Created"),
        400: jsonResponse(ErrorResponseSchema, "Invalid input"),
        403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        404: jsonResponse(ErrorResponseSchema, "Not found"),
        409: jsonResponse(ErrorResponseSchema, "Conflict"),
      },
    }),
    v("json", PublicCreateFieldSchema),
    async (c) => {
      const tableId = internalIdParam(c, "tableId")!;
      const table = await gridsService.table.get(tableId);
      if (!table) return c.json({ message: apiMessages(c).tableNotFound }, 404);
      const gate = await gateAt(c, { baseId: table.baseId }, "admin");
      if (!gate.ok) return respond(c, () => Promise.resolve(gate));
      const body = c.req.valid("json");
      const internal = await fromPublicFieldWrite(body.type, body);
      if (!internal.ok) return respond(c, () => Promise.resolve(internal));
      const result = await gridsService.field.create({ tableId, ...internal.data }, currentActorUserId(c), getLocale(c));
      return result.ok ? c.json(await toPublicField(result.data), 201) : c.json({ message: result.error.message }, result.error.status);
    },
  )

  .get(
    "/:fieldId/dependents",
    requirePublicIdParam("fieldId", "field", "Field"),
    describeRoute({
      tags: ["Grids:Field"],
      summary: "Pre-flight: where is this field referenced?",
      responses: {
        200: jsonResponse(PublicFieldDependentsResponseSchema, "Dependents"),
        403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        404: jsonResponse(ErrorResponseSchema, "Not found"),
      },
    }),
    async (c) => {
      const fieldId = internalIdParam(c, "fieldId")!;
      const field = await gridsService.field.get(fieldId);
      if (!field) return c.json({ message: apiMessages(c).fieldNotFound }, 404);
      const table = await gridsService.table.get(field.tableId);
      if (!table) return c.json({ message: apiMessages(c).tableNotFound }, 404);
      const gate = await gateAt(c, { baseId: table.baseId }, "read");
      if (!gate.ok) return respond(c, () => Promise.resolve(gate));
      const deps = await gridsService.fieldDependents.get(fieldId);
      return c.json({ dependents: await toPublicFieldDependents(deps), hasBlocking: gridsService.fieldDependents.hasBlocking(deps) });
    },
  )

  .patch(
    "/:fieldId",
    requirePublicIdParam("fieldId", "field", "Field"),
    describeRoute({
      tags: ["Grids:Field"],
      summary: "Update field metadata",
      responses: {
        200: jsonResponse(PublicFieldSchema, "Updated"),
        400: jsonResponse(ErrorResponseSchema, "Invalid input"),
        403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        404: jsonResponse(ErrorResponseSchema, "Not found"),
        409: jsonResponse(ErrorResponseSchema, "Conflict"),
      },
    }),
    v("json", PublicUpdateFieldSchema),
    async (c) => {
      const fieldId = internalIdParam(c, "fieldId")!;
      const field = await gridsService.field.get(fieldId);
      if (!field) return c.json({ message: apiMessages(c).fieldNotFound }, 404);
      const table = await gridsService.table.get(field.tableId);
      if (!table) return c.json({ message: apiMessages(c).tableNotFound }, 404);
      const gate = await gateAt(c, { baseId: table.baseId }, "admin");
      if (!gate.ok) return respond(c, () => Promise.resolve(gate));
      const internal = await fromPublicFieldWrite(field.type, c.req.valid("json"));
      if (!internal.ok) return respond(c, () => Promise.resolve(internal));
      const result = await gridsService.field.update(fieldId, internal.data, currentActorUserId(c), getLocale(c));
      return result.ok ? c.json(await toPublicField(result.data)) : c.json({ message: result.error.message }, result.error.status);
    },
  )

  .delete(
    "/:fieldId",
    requirePublicIdParam("fieldId", "field", "Field"),
    describeRoute({
      tags: ["Grids:Field"],
      summary: "Soft-delete a field (rejects if blocking dependents exist)",
      responses: {
        204: { description: "Deleted" },
        403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        404: jsonResponse(ErrorResponseSchema, "Not found"),
        409: jsonResponse(ErrorResponseSchema, "Blocking dependents exist"),
      },
    }),
    async (c) => {
      const fieldId = internalIdParam(c, "fieldId")!;
      const field = await gridsService.field.get(fieldId);
      if (!field) return c.json({ message: apiMessages(c).fieldNotFound }, 404);
      const table = await gridsService.table.get(field.tableId);
      if (!table) return c.json({ message: apiMessages(c).tableNotFound }, 404);
      const gate = await gateAt(c, { baseId: table.baseId }, "admin");
      if (!gate.ok) return respond(c, () => Promise.resolve(gate));

      const deps = await gridsService.fieldDependents.get(fieldId);
      if (gridsService.fieldDependents.hasBlocking(deps)) {
        return c.json(
          {
            message: apiMessages(c).fieldHasDependents,
            dependents: await toPublicFieldDependents(deps.filter((d) => d.blocking)),
          },
          409,
        );
      }
      const result = await gridsService.field.softDelete(fieldId, currentActorUserId(c), getLocale(c));
      if (!result.ok) return c.json({ message: result.error.message }, result.error.status);
      return c.body(null, 204);
    },
  )

  .post(
    "/:fieldId/restore",
    requireStoredPublicIdParam("fieldId", "field", "Field"),
    describeRoute({
      tags: ["Grids:Field"],
      summary: "Restore a soft-deleted field",
      responses: {
        200: jsonResponse(PublicFieldSchema, "Restored"),
        400: jsonResponse(ErrorResponseSchema, "Invalid input"),
        403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        404: jsonResponse(ErrorResponseSchema, "Not found"),
        409: jsonResponse(ErrorResponseSchema, "Conflict"),
      },
    }),
    async (c) => {
      const fieldId = internalIdParam(c, "fieldId")!;
      // `field.get` intentionally returns soft-deleted fields while still
      // enforcing the live parent table/base invariant.
      const field = await gridsService.field.get(fieldId);
      if (!field) return c.json({ message: apiMessages(c).fieldNotFound }, 404);
      const table = await gridsService.table.get(field.tableId);
      if (!table) return c.json({ message: apiMessages(c).tableNotFound }, 404);
      const gate = await gateAt(c, { baseId: table.baseId }, "admin");
      if (!gate.ok) return respond(c, () => Promise.resolve(gate));
      const result = await gridsService.field.restore(fieldId, currentActorUserId(c), getLocale(c));
      return result.ok ? c.json(await toPublicField(result.data)) : c.json({ message: result.error.message }, result.error.status);
    },
  );

export default app;
