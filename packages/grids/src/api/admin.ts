import { AccessEntrySchema, ErrorResponseSchema, GrantAccessSchema, PermissionLevelSchema } from "@valentinkolb/cloud/contracts";
import { type AuthContext, auth, getLocale, jsonResponse, respond } from "@valentinkolb/cloud/server";
import { Hono, type MiddlewareHandler } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { ShortIdSchema } from "../contracts";
import { gridsService } from "../service";
import { projectPublicIds, resolvePublicId } from "../service/public-resources";
import { validateAccessLevelForResource } from "./access";
import { apiMessages } from "./messages";
import { currentActorUserId } from "./permissions";
import { v } from "./validator";

const ScopedAccessEntrySchema = AccessEntrySchema.extend({
  resourceType: z.enum(["base", "customApp"]),
  resourceId: ShortIdSchema,
  resourceName: z.string(),
  tableId: ShortIdSchema.nullable(),
  tableName: z.string().nullable(),
});
const ScopedAccessListSchema = z.array(ScopedAccessEntrySchema);
const UpdateLevelSchema = z.object({ permission: PermissionLevelSchema });

type AdminApiDeps = {
  requireAdmin?: MiddlewareHandler<AuthContext>;
  resolvePublicId?: typeof resolvePublicId;
  projectPublicIds?: typeof projectPublicIds;
};

export const createAdminApi = (deps: AdminApiDeps = {}) => {
  const requireAdmin = deps.requireAdmin ?? auth.requireRole("admin");
  const resolve = deps.resolvePublicId ?? resolvePublicId;
  const project = deps.projectPublicIds ?? projectPublicIds;

  const resolveBase = async (publicId: string): Promise<string | null> => {
    const parsed = ShortIdSchema.safeParse(publicId);
    return parsed.success ? resolve("base", parsed.data) : null;
  };

  const toPublicScopedEntries = async (entries: Awaited<ReturnType<typeof gridsService.access.listForBaseTree>>) => {
    const baseIds = entries.filter((entry) => entry.resourceType === "base").map((entry) => entry.resourceId);
    const customAppIds = entries.filter((entry) => entry.resourceType === "customApp").map((entry) => entry.resourceId);
    const tableIds = entries.flatMap((entry) => (entry.tableId ? [entry.tableId] : []));
    const [bases, customApps, tables] = await Promise.all([
      project("base", baseIds),
      project("customApp", customAppIds),
      project("table", tableIds),
    ]);
    return entries.map((entry) => {
      const resourceId = (entry.resourceType === "base" ? bases : customApps).get(entry.resourceId);
      const tableId = entry.tableId ? tables.get(entry.tableId) : null;
      if (!resourceId || (entry.tableId && !tableId)) throw new Error(`Cannot project access resource ${entry.resourceId}`);
      return { ...entry, resourceId, tableId };
    });
  };

  return new Hono<AuthContext>()
    .use(requireAdmin)

    .get(
      "/bases/:baseId/access",
      describeRoute({
        tags: ["Grids:Admin"],
        summary: "List base and Grids App ACL entries as platform admin",
        responses: {
          200: jsonResponse(ScopedAccessListSchema, "Entries"),
          404: jsonResponse(ErrorResponseSchema, "Not found"),
        },
      }),
      async (c) => {
        const baseId = await resolveBase(c.req.param("baseId")!);
        if (!baseId) return c.json({ message: apiMessages(c).baseNotFound }, 404);
        const base = await gridsService.base.get(baseId);
        if (!base) return c.json({ message: apiMessages(c).baseNotFound }, 404);
        return c.json(await toPublicScopedEntries(await gridsService.access.listForBaseTree(baseId)));
      },
    )

    .post(
      "/bases/:baseId/access",
      describeRoute({
        tags: ["Grids:Admin"],
        summary: "Grant base access as platform admin",
        responses: {
          201: jsonResponse(AccessEntrySchema, "Created"),
          404: jsonResponse(ErrorResponseSchema, "Not found"),
        },
      }),
      v("json", GrantAccessSchema),
      async (c) => {
        const baseId = await resolveBase(c.req.param("baseId")!);
        if (!baseId) return c.json({ message: apiMessages(c).baseNotFound }, 404);
        const base = await gridsService.base.get(baseId);
        if (!base) return c.json({ message: apiMessages(c).baseNotFound }, 404);
        const result = await gridsService.access.grant({
          resourceType: "base",
          resourceId: baseId,
          actorId: currentActorUserId(c),
          ...c.req.valid("json"),
        });
        if (!result.ok) return respond(c, () => Promise.resolve(result));
        const created = (await gridsService.access.listForBase(baseId)).find((entry) => entry.id === result.data.accessId);
        if (!created) return c.json({ message: apiMessages(c).createdAccessEntryNotFound }, 500);
        return c.json(created, 201);
      },
    )

    .patch(
      "/bases/:baseId/access/:accessId",
      describeRoute({
        tags: ["Grids:Admin"],
        summary: "Update base access as platform admin",
        responses: {
          204: { description: "OK" },
          404: jsonResponse(ErrorResponseSchema, "Not found"),
        },
      }),
      v("json", UpdateLevelSchema),
      async (c) => {
        const baseId = await resolveBase(c.req.param("baseId")!);
        if (!baseId) return c.json({ message: apiMessages(c).baseNotFound }, 404);
        const accessId = c.req.param("accessId")!;
        const binding = await gridsService.access.resolveBinding(accessId);
        if (!binding || binding.baseId !== baseId) {
          return c.json({ message: apiMessages(c).accessEntryNotFound }, 404);
        }
        const { permission } = c.req.valid("json");
        const validationError = validateAccessLevelForResource(binding.resourceType, permission);
        if (validationError) return c.json({ message: validationError }, 400);
        const result = await gridsService.access.updateLevel(accessId, permission, currentActorUserId(c));
        if (!result.ok) return c.json({ message: result.error.message }, result.error.status);
        return c.body(null, 204);
      },
    )

    .delete(
      "/bases/:baseId/access/:accessId",
      describeRoute({
        tags: ["Grids:Admin"],
        summary: "Revoke base access as platform admin",
        responses: {
          204: { description: "Revoked" },
          404: jsonResponse(ErrorResponseSchema, "Not found"),
        },
      }),
      async (c) => {
        const baseId = await resolveBase(c.req.param("baseId")!);
        if (!baseId) return c.json({ message: apiMessages(c).baseNotFound }, 404);
        const accessId = c.req.param("accessId")!;
        const binding = await gridsService.access.resolveBinding(accessId);
        if (!binding || binding.baseId !== baseId) {
          return c.json({ message: apiMessages(c).accessEntryNotFound }, 404);
        }
        const result = await gridsService.access.revoke(accessId, currentActorUserId(c));
        if (!result.ok) return c.json({ message: result.error.message }, result.error.status);
        return c.body(null, 204);
      },
    )

    .delete(
      "/bases/:baseId",
      describeRoute({
        tags: ["Grids:Admin"],
        summary: "Delete a base as platform admin",
        responses: {
          204: { description: "Deleted" },
          404: jsonResponse(ErrorResponseSchema, "Not found"),
        },
      }),
      async (c) => {
        const baseId = await resolveBase(c.req.param("baseId")!);
        if (!baseId) return c.json({ message: apiMessages(c).baseNotFound }, 404);
        const base = await gridsService.base.get(baseId);
        if (!base) return c.json({ message: apiMessages(c).baseNotFound }, 404);
        const result = await gridsService.base.remove(baseId, currentActorUserId(c), getLocale(c));
        if (!result.ok) return c.json({ message: result.error.message }, result.error.status);
        return c.body(null, 204);
      },
    );
};

export default createAdminApi();
