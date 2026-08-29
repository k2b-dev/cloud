import { createPagination, ErrorResponseSchema, parsePagination } from "@valentinkolb/cloud/contracts";
import { type AuthContext, auth, getLocale, jsonResponse, respond } from "@valentinkolb/cloud/server";
import { Hono, type MiddlewareHandler } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { CreateBaseSchema, UpdateBaseSchema } from "../contracts";
import {
  ControlledDestructionOverviewSchema,
  ControlledDestructionRunSchema,
  StartControlledDestructionInputSchema,
} from "../controlled-destruction-contracts";
import {
  CreatePreservationHoldInputSchema,
  PreservationHoldInputSchema,
  PreservationHoldSchema,
  PreservationHoldsQuerySchema,
  PreservationHoldsResponseSchema,
} from "../preservation-hold-contracts";
import {
  RetentionFilesQuerySchema,
  RetentionFilesResponseSchema,
  RetentionPolicyInputSchema,
  RetentionPolicyResponseSchema,
  RetentionPreviewSchema,
  RetentionRecordsQuerySchema,
  RetentionRecordsResponseSchema,
} from "../retention-policy-contracts";
import { gridsService } from "../service";
import { resolvePublicId } from "../service/public-resources";
import { apiMessages } from "./messages";
import {
  currentActorUser,
  currentActorUserId,
  currentActorViewer,
  currentResourceBoundBaseId,
  gateAt,
  gateCredentialScope,
} from "./permissions";
import {
  PublicBaseListSchema,
  PublicBaseSchema,
  PublicFieldSchema,
  PublicFormSchema,
  PublicTableSchema,
  toPublicBase,
  toPublicBases,
  toPublicFields,
  toPublicForms,
  toPublicTables,
} from "./public-dto";
import { internalIdParam, publicIdParam, requirePublicIdParam, requireStoredPublicIdParam } from "./route-params";
import { v } from "./validator";

const TrashResponseSchema = z.object({
  tables: z.array(PublicTableSchema),
  fields: z.array(PublicFieldSchema),
  forms: z.array(PublicFormSchema),
});

const resolveHoldTableScope = async (baseId: string, tablePublicId: string): Promise<string | null> => {
  const tableId = await resolvePublicId("table", tablePublicId);
  if (!tableId) return null;
  const table = await gridsService.table.get(tableId);
  return table?.baseId === baseId ? tableId : null;
};

export const createBasesApi = (deps: { requireAuthenticated?: MiddlewareHandler<AuthContext> } = {}) => {
  const requireAuthenticated = deps.requireAuthenticated ?? auth.requireRole("authenticated");

  return new Hono<AuthContext>()
    .use(requireAuthenticated)

    .get(
      "/",
      describeRoute({
        tags: ["Grids:Base"],
        summary: "List bases the user can access",
        responses: {
          200: jsonResponse(PublicBaseListSchema, "Bases"),
          400: jsonResponse(ErrorResponseSchema, "Invalid query"),
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        },
      }),
      v(
        "query",
        z.object({
          q: z.string().optional().default(""),
          limit: z.coerce.number().int().min(1).max(500).optional().default(100),
          offset: z.coerce.number().int().min(0).optional().default(0),
        }),
      ),
      async (c) => {
        const scopeGate = await gateCredentialScope(c, "read");
        if (!scopeGate.ok) return respond(c, () => Promise.resolve(scopeGate));
        const boundBaseId = currentResourceBoundBaseId(c);
        if (boundBaseId === null) return c.json({ message: apiMessages(c).apiCredentialNeedsBase }, 403);
        const viewer = currentActorViewer(c);
        const { q, limit, offset } = c.req.valid("query");
        const result = await gridsService.base.listVisible({
          ...viewer,
          ...(boundBaseId ? { baseId: boundBaseId } : {}),
          query: q,
          limit,
          offset,
        });
        return c.json({ ...result, items: toPublicBases(result.items), limit, offset });
      },
    )

    .post(
      "/",
      describeRoute({
        tags: ["Grids:Base"],
        summary: "Create a base",
        responses: {
          201: jsonResponse(PublicBaseSchema, "Created"),
          400: jsonResponse(ErrorResponseSchema, "Invalid input"),
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        },
      }),
      v("json", CreateBaseSchema),
      async (c) => {
        const scopeGate = await gateCredentialScope(c, "write", { allowResourceBound: false });
        if (!scopeGate.ok) return respond(c, () => Promise.resolve(scopeGate));
        const user = currentActorUser(c);
        if (!user) return c.json({ message: apiMessages(c).signInToCreateBase }, 403);
        // User-backed actors with write-capable credentials become the base
        // admin through the access entry created by the service.
        const body = c.req.valid("json");
        const result = await gridsService.base.create(
          { name: body.name, description: body.description ?? null, documentDefaults: body.documentDefaults },
          user.id,
          getLocale(c),
        );
        return result.ok ? c.json(toPublicBase(result.data), 201) : c.json({ message: result.error.message }, result.error.status);
      },
    )

    .get(
      "/:baseId",
      requirePublicIdParam("baseId", "base", "Base"),
      describeRoute({
        tags: ["Grids:Base"],
        summary: "Get a base",
        responses: {
          200: jsonResponse(PublicBaseSchema, "Base"),
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
          404: jsonResponse(ErrorResponseSchema, "Not found"),
        },
      }),
      async (c) => {
        const baseId = internalIdParam(c, "baseId")!;
        const gate = await gateAt(c, { baseId }, "read");
        if (!gate.ok) return respond(c, () => Promise.resolve(gate));
        const base = await gridsService.base.get(baseId);
        if (!base) return c.json({ message: apiMessages(c).baseNotFound }, 404);
        return c.json(toPublicBase(base));
      },
    )

    .patch(
      "/:baseId",
      requirePublicIdParam("baseId", "base", "Base"),
      describeRoute({
        tags: ["Grids:Base"],
        summary: "Update base metadata",
        responses: {
          200: jsonResponse(PublicBaseSchema, "Updated"),
          400: jsonResponse(ErrorResponseSchema, "Invalid input"),
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
          404: jsonResponse(ErrorResponseSchema, "Not found"),
        },
      }),
      v("json", UpdateBaseSchema),
      async (c) => {
        const baseId = internalIdParam(c, "baseId")!;
        const gate = await gateAt(c, { baseId }, "admin");
        if (!gate.ok) return respond(c, () => Promise.resolve(gate));
        const body = c.req.valid("json");
        const result = await gridsService.base.update(baseId, body, currentActorUserId(c), getLocale(c));
        return result.ok ? c.json(toPublicBase(result.data)) : c.json({ message: result.error.message }, result.error.status);
      },
    )

    .get(
      "/:baseId/retention-policy",
      requirePublicIdParam("baseId", "base", "Base"),
      describeRoute({
        tags: ["Grids:Base"],
        summary: "Read the Base retention floor",
        responses: {
          200: jsonResponse(RetentionPolicyResponseSchema, "Retention policy"),
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
          404: jsonResponse(ErrorResponseSchema, "Base not found"),
        },
      }),
      async (c) => {
        const baseId = internalIdParam(c, "baseId")!;
        const gate = await gateAt(c, { baseId }, "admin");
        if (!gate.ok) return respond(c, () => Promise.resolve(gate));
        const policy = await gridsService.base.retentionPolicy.get(baseId);
        return c.json({ policy: policy ? { baseId: c.req.param("baseId"), ...policy } : null });
      },
    )

    .get(
      "/:baseId/preservation-holds",
      requirePublicIdParam("baseId", "base", "Base"),
      describeRoute({
        tags: ["Grids:Base"],
        summary: "List preservation holds",
        responses: {
          200: jsonResponse(PreservationHoldsResponseSchema, "Preservation holds"),
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
          404: jsonResponse(ErrorResponseSchema, "Base not found"),
        },
      }),
      v("query", PreservationHoldsQuerySchema),
      async (c) => {
        const baseId = internalIdParam(c, "baseId")!;
        const gate = await gateAt(c, { baseId }, "admin");
        if (!gate.ok) return respond(c, () => Promise.resolve(gate));
        const query = c.req.valid("query");
        const pagination = parsePagination(query);
        const result = await gridsService.base.preservationHolds.list(baseId, {
          status: query.status,
          scope: query.scope,
          tablePublicId: query.tableId ?? null,
          perPage: pagination.perPage,
          offset: pagination.offset,
        });
        return c.json({ items: result.items, pagination: createPagination(pagination, result.total) });
      },
    )

    .post(
      "/:baseId/preservation-holds",
      requirePublicIdParam("baseId", "base", "Base"),
      describeRoute({
        tags: ["Grids:Base"],
        summary: "Create a preservation hold",
        responses: {
          201: jsonResponse(PreservationHoldSchema, "Preservation hold created"),
          400: jsonResponse(ErrorResponseSchema, "Invalid reason"),
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
          404: jsonResponse(ErrorResponseSchema, "Base not found"),
        },
      }),
      v("json", CreatePreservationHoldInputSchema),
      async (c) => {
        const baseId = internalIdParam(c, "baseId")!;
        const gate = await gateAt(c, { baseId }, "admin");
        if (!gate.ok) return respond(c, () => Promise.resolve(gate));
        const actor = currentActorUser(c);
        const body = c.req.valid("json");
        let scope: { type: "base" } | { type: "table"; tableId: string } = { type: "base" };
        if (body.scope.type === "table") {
          const tableId = await resolveHoldTableScope(baseId, body.scope.tableId);
          if (!tableId) return c.json({ message: apiMessages(c).tableNotFound }, 404);
          scope = { type: "table", tableId };
        }
        const result = await gridsService.base.preservationHolds.create(
          baseId,
          { reason: body.reason, scope },
          {
            id: actor?.id ?? null,
            displayName: actor?.displayName ?? null,
          },
          getLocale(c),
        );
        return result.ok ? c.json(result.data, 201) : c.json({ message: result.error.message }, result.error.status);
      },
    )

    .post(
      "/:baseId/preservation-holds/:holdId/release",
      requirePublicIdParam("baseId", "base", "Base"),
      async (c, next) => {
        if (!publicIdParam(c, "holdId")) return c.json({ message: apiMessages(c).preservationHoldNotFound }, 404);
        await next();
      },
      describeRoute({
        tags: ["Grids:Base"],
        summary: "Release one preservation hold",
        responses: {
          200: jsonResponse(PreservationHoldSchema, "Preservation hold released"),
          400: jsonResponse(ErrorResponseSchema, "Invalid reason"),
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
          404: jsonResponse(ErrorResponseSchema, "Preservation hold not found"),
          409: jsonResponse(ErrorResponseSchema, "Preservation hold already released"),
        },
      }),
      v("json", PreservationHoldInputSchema),
      async (c) => {
        const baseId = internalIdParam(c, "baseId")!;
        const gate = await gateAt(c, { baseId }, "admin");
        if (!gate.ok) return respond(c, () => Promise.resolve(gate));
        const actor = currentActorUser(c);
        const result = await gridsService.base.preservationHolds.release(
          baseId,
          c.req.param("holdId"),
          c.req.valid("json"),
          {
            id: actor?.id ?? null,
            displayName: actor?.displayName ?? null,
          },
          getLocale(c),
        );
        return result.ok ? c.json(result.data) : c.json({ message: result.error.message }, result.error.status);
      },
    )

    .get(
      "/:baseId/controlled-destruction",
      requirePublicIdParam("baseId", "base", "Base"),
      describeRoute({
        tags: ["Grids:Base"],
        summary: "Preview controlled File destruction and list recent runs",
        responses: {
          200: jsonResponse(ControlledDestructionOverviewSchema, "Controlled destruction overview"),
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
          404: jsonResponse(ErrorResponseSchema, "Base not found"),
        },
      }),
      async (c) => {
        const baseId = internalIdParam(c, "baseId")!;
        const gate = await gateAt(c, { baseId }, "admin");
        if (!gate.ok) return respond(c, () => Promise.resolve(gate));
        return c.json(await gridsService.base.controlledDestruction.overview(baseId));
      },
    )

    .post(
      "/:baseId/controlled-destruction",
      requirePublicIdParam("baseId", "base", "Base"),
      describeRoute({
        tags: ["Grids:Base"],
        summary: "Start bounded controlled File destruction",
        responses: {
          201: jsonResponse(ControlledDestructionRunSchema, "Controlled destruction started"),
          400: jsonResponse(ErrorResponseSchema, "Invalid confirmation"),
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
          404: jsonResponse(ErrorResponseSchema, "Base not found"),
          409: jsonResponse(ErrorResponseSchema, "Preview changed"),
        },
      }),
      v("json", StartControlledDestructionInputSchema),
      async (c) => {
        const baseId = internalIdParam(c, "baseId")!;
        const gate = await gateAt(c, { baseId }, "admin");
        if (!gate.ok) return respond(c, () => Promise.resolve(gate));
        const actor = currentActorUser(c);
        const result = await gridsService.base.controlledDestruction.start(
          baseId,
          c.req.valid("json"),
          {
            id: actor?.id ?? null,
            displayName: actor?.displayName ?? null,
          },
          undefined,
          getLocale(c),
        );
        return result.ok ? c.json(result.data, 201) : c.json({ message: result.error.message }, result.error.status);
      },
    )

    .get(
      "/:baseId/controlled-destruction/:runId",
      requirePublicIdParam("baseId", "base", "Base"),
      async (c, next) => {
        if (!publicIdParam(c, "runId")) return c.json({ message: apiMessages(c).controlledDestructionRunNotFound }, 404);
        await next();
      },
      describeRoute({
        tags: ["Grids:Base"],
        summary: "Get one controlled destruction run",
        responses: {
          200: jsonResponse(ControlledDestructionRunSchema, "Controlled destruction run"),
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
          404: jsonResponse(ErrorResponseSchema, "Not found"),
        },
      }),
      async (c) => {
        const baseId = internalIdParam(c, "baseId")!;
        const gate = await gateAt(c, { baseId }, "admin");
        if (!gate.ok) return respond(c, () => Promise.resolve(gate));
        const run = await gridsService.base.controlledDestruction.get(baseId, c.req.param("runId"));
        return run
          ? c.json(ControlledDestructionRunSchema.parse(run))
          : c.json({ message: apiMessages(c).controlledDestructionRunNotFound }, 404);
      },
    )

    .post(
      "/:baseId/controlled-destruction/:runId/cancel",
      requirePublicIdParam("baseId", "base", "Base"),
      async (c, next) => {
        if (!publicIdParam(c, "runId")) return c.json({ message: apiMessages(c).controlledDestructionRunNotFound }, 404);
        await next();
      },
      describeRoute({
        tags: ["Grids:Base"],
        summary: "Cancel remaining controlled destruction work",
        responses: {
          200: jsonResponse(ControlledDestructionRunSchema, "Cancellation requested"),
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
          404: jsonResponse(ErrorResponseSchema, "Not found"),
          409: jsonResponse(ErrorResponseSchema, "Run is terminal"),
        },
      }),
      async (c) => {
        const baseId = internalIdParam(c, "baseId")!;
        const gate = await gateAt(c, { baseId }, "admin");
        if (!gate.ok) return respond(c, () => Promise.resolve(gate));
        const result = await gridsService.base.controlledDestruction.cancel(baseId, c.req.param("runId"), getLocale(c));
        return result.ok
          ? c.json(ControlledDestructionRunSchema.parse(result.data))
          : c.json({ message: result.error.message }, result.error.status);
      },
    )

    .post(
      "/:baseId/retention-policy/preview",
      requirePublicIdParam("baseId", "base", "Base"),
      describeRoute({
        tags: ["Grids:Base"],
        summary: "Preview a Base retention floor",
        responses: {
          200: jsonResponse(RetentionPreviewSchema, "Bounded retention preview"),
          400: jsonResponse(ErrorResponseSchema, "Invalid retention floor"),
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
          404: jsonResponse(ErrorResponseSchema, "Base not found"),
        },
      }),
      v("json", RetentionPolicyInputSchema),
      async (c) => {
        const baseId = internalIdParam(c, "baseId")!;
        const gate = await gateAt(c, { baseId }, "admin");
        if (!gate.ok) return respond(c, () => Promise.resolve(gate));
        return c.json(await gridsService.base.retentionPolicy.preview(baseId, c.req.valid("json")));
      },
    )

    .get(
      "/:baseId/retention-policy/records",
      requirePublicIdParam("baseId", "base", "Base"),
      describeRoute({
        tags: ["Grids:Base"],
        summary: "List trashed Records under a Base retention floor",
        responses: {
          200: jsonResponse(RetentionRecordsResponseSchema, "Retained Records"),
          400: jsonResponse(ErrorResponseSchema, "Invalid query"),
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
          404: jsonResponse(ErrorResponseSchema, "Base not found"),
        },
      }),
      v("query", RetentionRecordsQuerySchema),
      async (c) => {
        const baseId = internalIdParam(c, "baseId")!;
        const gate = await gateAt(c, { baseId }, "admin");
        if (!gate.ok) return respond(c, () => Promise.resolve(gate));
        const query = c.req.valid("query");
        const pagination = parsePagination(query);
        const result = await gridsService.base.retentionPolicy.listRecords(baseId, {
          minimumDays: query.minimumDays,
          search: query.search,
          status: query.status,
          perPage: pagination.perPage,
          offset: pagination.offset,
        });
        return c.json({
          observedAt: result.observedAt,
          minimumDays: query.minimumDays,
          items: result.items,
          pagination: createPagination(pagination, result.total),
        });
      },
    )

    .get(
      "/:baseId/retention-policy/files",
      requirePublicIdParam("baseId", "base", "Base"),
      describeRoute({
        tags: ["Grids:Base"],
        summary: "List unreferenced Files under a Base retention floor",
        responses: {
          200: jsonResponse(RetentionFilesResponseSchema, "Retained Files"),
          400: jsonResponse(ErrorResponseSchema, "Invalid query"),
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
          404: jsonResponse(ErrorResponseSchema, "Base not found"),
        },
      }),
      v("query", RetentionFilesQuerySchema),
      async (c) => {
        const baseId = internalIdParam(c, "baseId")!;
        const gate = await gateAt(c, { baseId }, "admin");
        if (!gate.ok) return respond(c, () => Promise.resolve(gate));
        const query = c.req.valid("query");
        const pagination = parsePagination(query);
        const result = await gridsService.base.retentionPolicy.listFiles(baseId, {
          minimumDays: query.minimumDays,
          search: query.search,
          status: query.status,
          perPage: pagination.perPage,
          offset: pagination.offset,
        });
        return c.json({
          observedAt: result.observedAt,
          minimumDays: query.minimumDays,
          items: result.items,
          pagination: createPagination(pagination, result.total),
        });
      },
    )

    .get(
      "/:baseId/retention-policy/files/:fileId/content",
      requirePublicIdParam("baseId", "base", "Base"),
      requirePublicIdParam("fileId", "file", "File"),
      describeRoute({
        tags: ["Grids:Base"],
        summary: "Read an unreferenced retained File",
        responses: {
          200: { description: "Exact File bytes" },
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
          404: jsonResponse(ErrorResponseSchema, "File not found"),
        },
      }),
      v("query", z.object({ inline: z.enum(["true", "false"]).optional() })),
      async (c) => {
        const baseId = internalIdParam(c, "baseId")!;
        const gate = await gateAt(c, { baseId }, "admin");
        if (!gate.ok) return respond(c, () => Promise.resolve(gate));
        const result = await gridsService.base.retentionPolicy.getFileContent(baseId, internalIdParam(c, "fileId")!, getLocale(c));
        if (!result.ok) return c.json({ message: result.error.message }, result.error.status);
        const disposition = c.req.valid("query").inline === "true" ? "inline" : "attachment";
        c.header("Content-Type", result.data.mimeType);
        c.header("Content-Disposition", `${disposition}; filename="${encodeURIComponent(result.data.filename)}"`);
        c.header("Cache-Control", "private, no-store");
        return c.body(new Uint8Array(result.data.bytes).buffer);
      },
    )

    .put(
      "/:baseId/retention-policy",
      requirePublicIdParam("baseId", "base", "Base"),
      describeRoute({
        tags: ["Grids:Base"],
        summary: "Set the Base retention floor",
        responses: {
          200: jsonResponse(RetentionPolicyResponseSchema, "Retention policy updated"),
          400: jsonResponse(ErrorResponseSchema, "Invalid retention floor"),
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
          404: jsonResponse(ErrorResponseSchema, "Base not found"),
        },
      }),
      v("json", RetentionPolicyInputSchema),
      async (c) => {
        const baseId = internalIdParam(c, "baseId")!;
        const gate = await gateAt(c, { baseId }, "admin");
        if (!gate.ok) return respond(c, () => Promise.resolve(gate));
        const policy = await gridsService.base.retentionPolicy.update(baseId, c.req.valid("json"), currentActorUserId(c));
        return c.json({ policy: { baseId: c.req.param("baseId"), ...policy } });
      },
    )

    .delete(
      "/:baseId/retention-policy",
      requirePublicIdParam("baseId", "base", "Base"),
      describeRoute({
        tags: ["Grids:Base"],
        summary: "Remove the Base retention floor",
        responses: {
          204: { description: "Retention policy removed" },
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
          404: jsonResponse(ErrorResponseSchema, "Base not found"),
        },
      }),
      async (c) => {
        const baseId = internalIdParam(c, "baseId")!;
        const gate = await gateAt(c, { baseId }, "admin");
        if (!gate.ok) return respond(c, () => Promise.resolve(gate));
        await gridsService.base.retentionPolicy.remove(baseId, currentActorUserId(c));
        return c.body(null, 204);
      },
    )

    .delete(
      "/:baseId",
      requirePublicIdParam("baseId", "base", "Base"),
      describeRoute({
        tags: ["Grids:Base"],
        summary: "Move a base to trash",
        responses: {
          204: { description: "Moved to trash" },
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
          404: jsonResponse(ErrorResponseSchema, "Not found"),
        },
      }),
      async (c) => {
        const baseId = internalIdParam(c, "baseId")!;
        const gate = await gateAt(c, { baseId }, "admin");
        if (!gate.ok) return respond(c, () => Promise.resolve(gate));
        const result = await gridsService.base.remove(baseId, currentActorUserId(c), getLocale(c));
        if (!result.ok) return c.json({ message: result.error.message }, result.error.status);
        return c.body(null, 204);
      },
    )

    .post(
      "/:baseId/restore",
      requireStoredPublicIdParam("baseId", "base", "Base"),
      describeRoute({
        tags: ["Grids:Base"],
        summary: "Restore a soft-deleted base",
        responses: {
          200: jsonResponse(PublicBaseSchema, "Restored"),
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
          404: jsonResponse(ErrorResponseSchema, "Not found"),
        },
      }),
      async (c) => {
        const baseId = internalIdParam(c, "baseId")!;
        const gate = await gateAt(c, { baseId }, "admin");
        if (!gate.ok) return respond(c, () => Promise.resolve(gate));
        const result = await gridsService.base.restore(baseId, currentActorUserId(c), getLocale(c));
        return result.ok ? c.json(toPublicBase(result.data)) : c.json({ message: result.error.message }, result.error.status);
      },
    )

    .get(
      "/:baseId/trash",
      requirePublicIdParam("baseId", "base", "Base"),
      describeRoute({
        tags: ["Grids:Base"],
        summary: "List soft-deleted resources for a base (tables, fields, forms)",
        description:
          "Returns trashed tables, fields, and forms grouped by resource type. " +
          "Fields/forms whose parent table is itself trashed are excluded — they restore alongside the table.",
        responses: {
          200: jsonResponse(TrashResponseSchema, "Trashed resources"),
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
          404: jsonResponse(ErrorResponseSchema, "Not found"),
        },
      }),
      async (c) => {
        const baseId = internalIdParam(c, "baseId")!;
        // Trash management is a structural / recovery action — base-admin only.
        const gate = await gateAt(c, { baseId }, "admin");
        if (!gate.ok) return respond(c, () => Promise.resolve(gate));
        const [tables, fields, forms] = await Promise.all([
          gridsService.table.listTrashedByBase(baseId),
          gridsService.field.listTrashedByBase(baseId),
          // Forms is keyed by tableId, but listTrashedByBase joins
          // through tables for us. Returns full Form objects; the UI
          // only needs id / name / tableId / deletedAt though.
          gridsService.form.listTrashedByBase(baseId),
        ]);
        return c.json({ tables: await toPublicTables(tables), fields: await toPublicFields(fields), forms: await toPublicForms(forms) });
      },
    );
};

export default createBasesApi();
