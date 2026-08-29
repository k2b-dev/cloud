import { ErrorResponseSchema, PermissionLevelSchema } from "@valentinkolb/cloud/contracts";
import { type AuthContext, getLocale, jsonResponse, respond } from "@valentinkolb/cloud/server";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import {
  type BaseAdminAuthorization,
  resolveAccessBinding,
  revokeAccess,
  updateAccessLevel,
  validateAccessPermission,
} from "../service/access";
import { apiMessages } from "./messages";
import { currentAccessSubject, currentActorUserId, currentCredentialPermission, currentResourceBoundBaseId, gateAt } from "./permissions";
import { v } from "./validator";

const UpdateLevelSchema = z.object({ permission: PermissionLevelSchema });

type AccessEntryRouteDeps = {
  gate: typeof gateAt;
  actorId: typeof currentActorUserId;
  authorization: (c: Parameters<typeof gateAt>[0]) => BaseAdminAuthorization;
};
const defaultDeps: AccessEntryRouteDeps = {
  gate: gateAt,
  actorId: currentActorUserId,
  authorization: (c) => ({
    subject: currentAccessSubject(c),
    permissionCap: currentCredentialPermission(c),
    resourceBoundBaseId: currentResourceBoundBaseId(c),
  }),
};

export const createAccessEntryRoutes = (deps: AccessEntryRouteDeps = defaultDeps) =>
  new Hono<AuthContext>()
    .patch(
      "/:accessId",
      describeRoute({
        tags: ["Grids:Access"],
        summary: "Update a grant's permission level",
        responses: {
          204: { description: "OK" },
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
          404: jsonResponse(ErrorResponseSchema, "Not found"),
        },
      }),
      v("json", UpdateLevelSchema),
      async (c) => {
        const accessId = c.req.param("accessId")!;
        const binding = await resolveAccessBinding(accessId);
        if (!binding) return c.json({ message: apiMessages(c).accessEntryNotFound }, 404);
        const gate = await deps.gate(c, { baseId: binding.baseId }, "admin");
        if (!gate.ok) return respond(c, () => Promise.resolve(gate));

        const { permission } = c.req.valid("json");
        const validationError = validateAccessPermission(binding.resourceType, permission, getLocale(c));
        if (validationError) return c.json({ message: validationError }, 400);
        const result = await updateAccessLevel(accessId, permission, deps.actorId(c), deps.authorization(c), getLocale(c));
        if (!result.ok) return c.json({ message: result.error.message }, result.error.status);
        return c.body(null, 204);
      },
    )
    .delete(
      "/:accessId",
      describeRoute({
        tags: ["Grids:Access"],
        summary: "Revoke a grant",
        responses: {
          204: { description: "Revoked" },
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
          404: jsonResponse(ErrorResponseSchema, "Not found"),
        },
      }),
      async (c) => {
        const accessId = c.req.param("accessId")!;
        const binding = await resolveAccessBinding(accessId);
        if (!binding) return c.json({ message: apiMessages(c).accessEntryNotFound }, 404);
        const gate = await deps.gate(c, { baseId: binding.baseId }, "admin");
        if (!gate.ok) return respond(c, () => Promise.resolve(gate));
        const result = await revokeAccess(accessId, deps.actorId(c), deps.authorization(c), getLocale(c));
        if (!result.ok) return c.json({ message: result.error.message }, result.error.status);
        return c.body(null, 204);
      },
    );

export const accessEntryRoutes = createAccessEntryRoutes();
