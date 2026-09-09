import { ErrorResponseSchema } from "@k2b/cloud/contracts";
import { type AuthContext, auth, jsonResponse, type PermissionLevel, respond } from "@k2b/cloud/server";
import { type Context, Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { gridsService } from "../service";
import { compileGqlViewWrite } from "./gql-runtime";
import { apiMessages } from "./messages";
import { currentActorUser, currentActorUserId, currentActorViewer, gateAt } from "./permissions";
import {
  fromPublicCreateView,
  fromPublicUpdateView,
  PublicCreateViewSchema,
  PublicUpdateViewSchema,
  PublicViewListSchema,
  PublicViewSchema,
  toPublicView,
  toPublicViews,
} from "./public-dto";
import { internalIdParam, requirePublicIdParam, requireStoredPublicIdParam } from "./route-params";
import { v } from "./validator";

const gqlDiagnosticMessage = (diagnostics: Array<{ message: string }>): string =>
  diagnostics.map((diagnostic) => diagnostic.message).join("; ") || "invalid GQL source";

export const canAdministerView = (params: { level: PermissionLevel }): boolean => gridsService.permission.hasAtLeast(params.level, "admin");

export const changesViewSharing = (shared: boolean | undefined, ownerUserId: string | null): boolean =>
  shared !== undefined && shared !== (ownerUserId === null);

const canAdministerViewForRequest = async (
  c: Context<AuthContext>,
  _view: { id: string; tableId: string; ownerUserId: string | null },
  baseId: string,
): Promise<boolean> => {
  const gate = await gateAt(c, { baseId }, "admin");
  if (!gate.ok) return false;
  return canAdministerView({ level: gate.data });
};

const app = new Hono<AuthContext>()
  .use(auth.requireRole("authenticated"))

  .get(
    "/by-table/:tableId",
    requirePublicIdParam("tableId", "table", "Table"),
    describeRoute({
      tags: ["Grids:View"],
      summary: "List views visible on a table",
      responses: {
        200: jsonResponse(PublicViewListSchema, "Views"),
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
      const list = await gridsService.view.listForTable({
        tableId,
        ...currentActorViewer(c),
      });
      return c.json(await toPublicViews(list));
    },
  )

  .post(
    "/by-table/:tableId",
    requirePublicIdParam("tableId", "table", "Table"),
    describeRoute({
      tags: ["Grids:View"],
      summary: "Create a view (shared or personal)",
      responses: {
        201: jsonResponse(PublicViewSchema, "Created"),
        400: jsonResponse(ErrorResponseSchema, "Invalid input"),
        403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        404: jsonResponse(ErrorResponseSchema, "Not found"),
        409: jsonResponse(ErrorResponseSchema, "Conflict"),
      },
    }),
    v("json", PublicCreateViewSchema),
    async (c) => {
      const tableId = internalIdParam(c, "tableId")!;
      const table = await gridsService.table.get(tableId);
      if (!table) return c.json({ message: apiMessages(c).tableNotFound }, 404);
      const body = c.req.valid("json");
      const gate = await gateAt(c, { baseId: table.baseId }, "admin");
      if (!gate.ok) return respond(c, () => Promise.resolve(gate));
      const converted = await fromPublicCreateView(tableId, body);
      if (!converted.ok) return c.json({ message: converted.error.message }, converted.error.status);
      const compiled = await compileGqlViewWrite(c, {
        baseId: table.baseId,
        tableId,
        ...(converted.data.source !== undefined ? { source: converted.data.source } : {}),
      });
      if (!compiled.ok) return c.json({ message: gqlDiagnosticMessage(compiled.diagnostics) }, 400);
      const user = currentActorUser(c);
      if (!body.shared && !user) return c.json({ message: apiMessages(c).signInToCreatePersonalView }, 403);
      const result = await gridsService.view.create(
        {
          tableId,
          name: converted.data.name,
          description: converted.data.description ?? null,
          icon: converted.data.icon ?? null,
          source: compiled.source,
          ui: converted.data.ui,
          ownerUserId: body.shared ? null : (user?.id ?? null),
        },
        currentActorUserId(c),
      );
      return result.ok ? c.json(await toPublicView(result.data), 201) : c.json({ message: result.error.message }, result.error.status);
    },
  )

  .get(
    "/:viewId",
    requirePublicIdParam("viewId", "view", "View"),
    describeRoute({
      tags: ["Grids:View"],
      summary: "Get a single view",
      responses: {
        200: jsonResponse(PublicViewSchema, "View"),
        404: jsonResponse(ErrorResponseSchema, "Not found"),
      },
    }),
    async (c) => {
      const viewId = internalIdParam(c, "viewId")!;
      const view = await gridsService.view.get(viewId);
      if (!view) return c.json({ message: apiMessages(c).viewNotFound }, 404);
      const table = await gridsService.table.get(view.tableId);
      if (!table) return c.json({ message: apiMessages(c).tableNotFound }, 404);

      const gate = await gateAt(c, { baseId: table.baseId }, "read");
      if (!gate.ok) {
        return c.json({ message: apiMessages(c).viewNotFound }, 404);
      }
      return c.json(await toPublicView(view));
    },
  )

  .patch(
    "/:viewId",
    requirePublicIdParam("viewId", "view", "View"),
    describeRoute({
      tags: ["Grids:View"],
      summary: "Update a view",
      responses: {
        200: jsonResponse(PublicViewSchema, "Updated"),
        400: jsonResponse(ErrorResponseSchema, "Invalid input"),
        403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        404: jsonResponse(ErrorResponseSchema, "Not found"),
        409: jsonResponse(ErrorResponseSchema, "Conflict"),
      },
    }),
    v("json", PublicUpdateViewSchema),
    async (c) => {
      const viewId = internalIdParam(c, "viewId")!;
      const view = await gridsService.view.get(viewId);
      if (!view) return c.json({ message: apiMessages(c).viewNotFound }, 404);
      const table = await gridsService.table.get(view.tableId);
      if (!table) return c.json({ message: apiMessages(c).tableNotFound }, 404);
      const body = c.req.valid("json");
      if (body.shared === false && !currentActorUser(c)) return c.json({ message: apiMessages(c).signInToMakeViewPersonal }, 403);
      if (!(await canAdministerViewForRequest(c, view, table.baseId))) {
        return c.json({ message: apiMessages(c).viewUpdateNeedsAdmin }, 403);
      }
      if (changesViewSharing(body.shared, view.ownerUserId)) {
        const shareGate = await gateAt(c, { baseId: table.baseId }, "admin");
        if (!shareGate.ok) return respond(c, () => Promise.resolve(shareGate));
      }

      const converted = await fromPublicUpdateView(view.tableId, body);
      if (!converted.ok) return c.json({ message: converted.error.message }, converted.error.status);

      const compiled =
        converted.data.source !== undefined
          ? await compileGqlViewWrite(c, {
              baseId: table.baseId,
              tableId: view.tableId,
              source: converted.data.source,
            })
          : null;
      if (compiled && !compiled.ok) return c.json({ message: gqlDiagnosticMessage(compiled.diagnostics) }, 400);

      const result = await gridsService.view.update(
        viewId,
        {
          ...converted.data,
          ...(compiled?.ok ? { source: compiled.source } : {}),
        },
        currentActorUserId(c),
      );
      return result.ok ? c.json(await toPublicView(result.data)) : c.json({ message: result.error.message }, result.error.status);
    },
  )

  .delete(
    "/:viewId",
    requirePublicIdParam("viewId", "view", "View"),
    describeRoute({
      tags: ["Grids:View"],
      summary: "Delete a view",
      responses: {
        204: { description: "Deleted" },
        403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        404: jsonResponse(ErrorResponseSchema, "Not found"),
      },
    }),
    async (c) => {
      const viewId = internalIdParam(c, "viewId")!;
      const view = await gridsService.view.get(viewId);
      if (!view) return c.json({ message: apiMessages(c).viewNotFound }, 404);
      const table = await gridsService.table.get(view.tableId);
      if (!table) return c.json({ message: apiMessages(c).tableNotFound }, 404);
      if (!(await canAdministerViewForRequest(c, view, table.baseId))) {
        return c.json({ message: apiMessages(c).viewDeleteNeedsAdmin }, 403);
      }
      const result = await gridsService.view.remove(viewId, currentActorUserId(c));
      if (!result.ok) return c.json({ message: result.error.message }, result.error.status);
      return c.body(null, 204);
    },
  )

  .post(
    "/:viewId/restore",
    requireStoredPublicIdParam("viewId", "view", "View"),
    describeRoute({
      tags: ["Grids:View"],
      summary: "Restore a soft-deleted view",
      responses: {
        200: jsonResponse(PublicViewSchema, "Restored"),
        403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        404: jsonResponse(ErrorResponseSchema, "Not found"),
        409: jsonResponse(ErrorResponseSchema, "Conflict"),
      },
    }),
    async (c) => {
      const viewId = internalIdParam(c, "viewId")!;
      const view = await gridsService.view.get(viewId, { includeDeleted: true });
      if (!view) return c.json({ message: apiMessages(c).viewNotFound }, 404);
      const table = await gridsService.table.get(view.tableId);
      if (!table) return c.json({ message: apiMessages(c).tableNotFound }, 404);
      if (!(await canAdministerViewForRequest(c, view, table.baseId))) {
        return c.json({ message: apiMessages(c).viewRestoreNeedsAdmin }, 403);
      }
      const result = await gridsService.view.restore(viewId, currentActorUserId(c));
      return result.ok ? c.json(await toPublicView(result.data)) : c.json({ message: result.error.message }, result.error.status);
    },
  );

export default app;
