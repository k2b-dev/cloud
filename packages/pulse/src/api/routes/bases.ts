import { AccessEntrySchema, hasRole } from "@k2b/cloud/contracts";
import {
  type AuthContext,
  getLocale,
  jsonResponse,
  REQUEST_IDLE_TIMEOUT_SECONDS,
  respond,
  respondMessage,
  setRequestTimeout,
  v,
} from "@k2b/cloud/server";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { pulseService } from "../../service";
import { retryBase } from "../../service/base-admin";
import { projectBases } from "../../service/public-resources";
import { RetentionStoreUnavailable } from "../../store/retention";
import { BaseSchema, CreateBaseSchema, GrantBaseAccessSchema, MessageSchema, UpdateBaseAccessSchema, UpdateBaseSchema } from "../schemas";
import { projectResult, requestAccessScope, requirePublicIdParam, requireUuidParam } from "../shared";

const routes = new Hono<AuthContext>()
  .onError((error, c) => {
    if (error instanceof RetentionStoreUnavailable)
      return c.json({ code: "STORE_UNAVAILABLE", message: "The data store is unavailable. Retry the retention preview." }, 503);
    throw error;
  })
  .get(
    "/bases",
    describeRoute({
      tags: ["Pulse"],
      summary: "List accessible Pulse bases",
      responses: { 200: jsonResponse(z.array(BaseSchema), "Pulse bases") },
    }),
    async (c) =>
      respond(
        c,
        projectResult(pulseService.base.list(requestAccessScope(c)), (items) => projectBases(items)),
      ),
  )
  .post(
    "/bases",
    describeRoute({
      tags: ["Pulse"],
      summary: "Create a Pulse base",
      responses: { 201: jsonResponse(BaseSchema, "Created Pulse base") },
    }),
    v("json", CreateBaseSchema),
    async (c) => {
      const actor = c.get("actor");
      const isCloudAdmin = actor.kind === "user" && hasRole(actor.user, "admin");
      return respond(
        c,
        projectResult(
          pulseService.base.create({
            ...c.req.valid("json"),
            user: requestAccessScope(c),
            isCloudAdmin,
            agent: actor.kind === "service_account",
          }),
          (item) => projectBases([item]).then(([value]) => value!),
        ),
        201,
      );
    },
  )
  .post(
    "/bases/:baseId/retry",
    describeRoute({
      tags: ["Pulse"],
      summary: "Retry a failed base operation",
      responses: { 200: jsonResponse(BaseSchema, "Pulse base") },
    }),
    async (c) => {
      const baseId = await requirePublicIdParam(c.req.param("baseId"), "base ID", "bases");
      if (!baseId.ok) return respond(c, baseId.result);
      const result = await retryBase(baseId.value, requestAccessScope(c));
      if (!result.ok) return respond(c, result);
      return respond(
        c,
        projectResult(pulseService.base.get(baseId.value, requestAccessScope(c)), (item) => projectBases([item]).then(([value]) => value!)),
      );
    },
  )
  .get("/bases/:baseId", async (c) => {
    const baseId = await requirePublicIdParam(c.req.param("baseId"), "base ID", "bases");
    if (!baseId.ok) return respond(c, baseId.result);
    return respond(
      c,
      projectResult(pulseService.base.get(baseId.value, requestAccessScope(c)), (item) => projectBases([item]).then(([value]) => value!)),
    );
  })
  .patch(
    "/bases/:baseId",
    describeRoute({
      tags: ["Pulse"],
      summary: "Update a Pulse base",
      responses: { 200: jsonResponse(BaseSchema, "Updated Pulse base") },
    }),
    v("json", UpdateBaseSchema),
    async (c) => {
      const baseId = await requirePublicIdParam(c.req.param("baseId"), "base ID", "bases");
      if (!baseId.ok) return respond(c, baseId.result);
      // A shorter retention first previews what it removes: a few ClickHouse scans in sequence, each bounded to 30 s.
      setRequestTimeout(c, 240);
      const result = await pulseService.base
        .update({ baseId: baseId.value, user: requestAccessScope(c), ...c.req.valid("json") })
        .finally(() => setRequestTimeout(c, REQUEST_IDLE_TIMEOUT_SECONDS));
      if (
        !result.ok &&
        result.error.code === "PULSE_RETENTION_CONFIRMATION_REQUIRED" &&
        "preview" in result.error &&
        "previewedFrom" in result.error
      )
        return c.json(
          {
            code: result.error.code,
            message: result.error.message,
            preview: result.error.preview,
            previewedFrom: result.error.previewedFrom,
          },
          409,
        );
      return respond(
        c,
        projectResult(result, (item) => projectBases([item]).then(([value]) => value!)),
      );
    },
  )
  .delete("/bases/:baseId", async (c) => {
    const baseId = await requirePublicIdParam(c.req.param("baseId"), "base ID", "bases");
    if (!baseId.ok) return respond(c, baseId.result);
    return respondMessage(
      c,
      pulseService.base.remove({ baseId: baseId.value, user: requestAccessScope(c) }),
      "Pulse base deletion started",
    );
  })
  .post("/bases/:baseId/clear-data", async (c) => {
    const baseId = await requirePublicIdParam(c.req.param("baseId"), "base ID", "bases");
    if (!baseId.ok) return respond(c, baseId.result);
    return respondMessage(
      c,
      pulseService.base.clearData({ baseId: baseId.value, user: requestAccessScope(c) }),
      "Pulse data clear started",
    );
  })
  .get(
    "/bases/:baseId/access",
    describeRoute({
      tags: ["Pulse"],
      summary: "List Pulse base access entries",
      responses: { 200: jsonResponse(z.array(AccessEntrySchema), "Pulse base access entries") },
    }),
    async (c) => {
      const baseId = await requirePublicIdParam(c.req.param("baseId"), "base ID", "bases");
      if (!baseId.ok) return respond(c, baseId.result);
      return respond(c, pulseService.base.access.list(baseId.value, requestAccessScope(c)));
    },
  )
  .post(
    "/bases/:baseId/access",
    describeRoute({
      tags: ["Pulse"],
      summary: "Grant Pulse base access",
      responses: { 201: jsonResponse(AccessEntrySchema, "Created access entry") },
    }),
    v("json", GrantBaseAccessSchema),
    async (c) => {
      const baseId = await requirePublicIdParam(c.req.param("baseId"), "base ID", "bases");
      if (!baseId.ok) return respond(c, baseId.result);
      return respond(c, pulseService.base.access.grant({ baseId: baseId.value, user: requestAccessScope(c), ...c.req.valid("json") }), 201);
    },
  )
  .patch(
    "/bases/:baseId/access/:accessId",
    describeRoute({
      tags: ["Pulse"],
      summary: "Update Pulse access level",
      responses: { 200: jsonResponse(MessageSchema, "Access updated") },
    }),
    v("json", UpdateBaseAccessSchema),
    async (c) => {
      const baseId = await requirePublicIdParam(c.req.param("baseId"), "base ID", "bases");
      if (!baseId.ok) return respond(c, baseId.result);
      const accessId = requireUuidParam(c.req.param("accessId"), "access ID");
      if (!accessId.ok) return respond(c, accessId.result);
      return respondMessage(
        c,
        pulseService.base.access.update({
          baseId: baseId.value,
          accessId: accessId.value,
          user: requestAccessScope(c),
          locale: getLocale(c),
          ...c.req.valid("json"),
        }),
        "Access updated",
      );
    },
  )
  .delete("/bases/:baseId/access/:accessId", async (c) => {
    const baseId = await requirePublicIdParam(c.req.param("baseId"), "base ID", "bases");
    if (!baseId.ok) return respond(c, baseId.result);
    const accessId = requireUuidParam(c.req.param("accessId"), "access ID");
    if (!accessId.ok) return respond(c, accessId.result);
    return respondMessage(
      c,
      pulseService.base.access.revoke({
        baseId: baseId.value,
        accessId: accessId.value,
        user: requestAccessScope(c),
        locale: getLocale(c),
      }),
      "Access revoked",
    );
  });

export default routes;
