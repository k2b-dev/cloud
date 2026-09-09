import { type AuthContext, jsonResponse, respond, respondMessage, v } from "@k2b/cloud/server";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { pulseService } from "../../service";
import { projectDashboardSnapshot, projectDashboards } from "../../service/public-resources";
import {
  CreateDashboardSchema,
  DashboardDslCompileResultSchema,
  DashboardDslCompileSchema,
  DashboardSchema,
  DashboardSnapshotSchema,
  UpdateDashboardSchema,
} from "../schemas";
import { projectResult, requestAccessScope, requirePublicIdParam } from "../shared";

const projectDashboard = async <T extends { id: string; baseId: string }>(dashboard: T): Promise<T> =>
  (await projectDashboards([dashboard]))[0]!;

const routes = new Hono<AuthContext>()
  .get(
    "/bases/:baseId/dashboards",
    describeRoute({
      tags: ["Pulse"],
      summary: "List Pulse dashboards for a base",
      responses: { 200: jsonResponse(z.array(DashboardSchema), "Pulse dashboards") },
    }),
    async (c) => {
      const baseId = await requirePublicIdParam(c.req.param("baseId"), "base ID", "bases");
      if (!baseId.ok) return respond(c, baseId.result);
      return respond(c, projectResult(pulseService.dashboard.list(baseId.value, requestAccessScope(c)), projectDashboards));
    },
  )
  .post(
    "/bases/:baseId/dashboards",
    describeRoute({
      tags: ["Pulse"],
      summary: "Create a Pulse dashboard",
      responses: { 201: jsonResponse(DashboardSchema, "Created Pulse dashboard") },
    }),
    v("json", CreateDashboardSchema),
    async (c) => {
      const baseId = await requirePublicIdParam(c.req.param("baseId"), "base ID", "bases");
      if (!baseId.ok) return respond(c, baseId.result);
      return respond(
        c,
        projectResult(
          pulseService.dashboard.create({ baseId: baseId.value, user: requestAccessScope(c), ...c.req.valid("json") }),
          projectDashboard,
        ),
        201,
      );
    },
  )
  .patch(
    "/dashboards/:dashboardId",
    describeRoute({
      tags: ["Pulse"],
      summary: "Update a Pulse dashboard",
      responses: { 200: jsonResponse(DashboardSchema, "Updated Pulse dashboard") },
    }),
    v("json", UpdateDashboardSchema),
    async (c) => {
      const dashboardId = await requirePublicIdParam(c.req.param("dashboardId"), "dashboard ID", "dashboards");
      if (!dashboardId.ok) return respond(c, dashboardId.result);
      return respond(
        c,
        projectResult(
          pulseService.dashboard.update({ dashboardId: dashboardId.value, user: requestAccessScope(c), ...c.req.valid("json") }),
          projectDashboard,
        ),
      );
    },
  )
  .get(
    "/dashboards/:dashboardId/snapshot",
    describeRoute({
      tags: ["Pulse"],
      summary: "Render an authenticated Pulse dashboard snapshot",
      responses: { 200: jsonResponse(DashboardSnapshotSchema, "Rendered Pulse dashboard snapshot") },
    }),
    async (c) => {
      const dashboardId = await requirePublicIdParam(c.req.param("dashboardId"), "dashboard ID", "dashboards");
      if (!dashboardId.ok) return respond(c, dashboardId.result);
      return respond(
        c,
        projectResult(
          pulseService.dashboard.snapshot({ dashboardId: dashboardId.value, user: requestAccessScope(c) }),
          projectDashboardSnapshot,
        ),
      );
    },
  )
  .delete("/dashboards/:dashboardId", async (c) => {
    const dashboardId = await requirePublicIdParam(c.req.param("dashboardId"), "dashboard ID", "dashboards");
    if (!dashboardId.ok) return respond(c, dashboardId.result);
    return respondMessage(
      c,
      pulseService.dashboard.remove({ dashboardId: dashboardId.value, user: requestAccessScope(c) }),
      "Dashboard removed",
    );
  })
  .post("/dashboards/:dashboardId/public-token", async (c) => {
    const dashboardId = await requirePublicIdParam(c.req.param("dashboardId"), "dashboard ID", "dashboards");
    if (!dashboardId.ok) return respond(c, dashboardId.result);
    return respond(
      c,
      projectResult(
        pulseService.dashboard.enablePublic({ dashboardId: dashboardId.value, user: requestAccessScope(c) }),
        async (value) => ({ ...value, dashboard: await projectDashboard(value.dashboard) }),
      ),
    );
  })
  .delete("/dashboards/:dashboardId/public-token", async (c) => {
    const dashboardId = await requirePublicIdParam(c.req.param("dashboardId"), "dashboard ID", "dashboards");
    if (!dashboardId.ok) return respond(c, dashboardId.result);
    return respond(
      c,
      projectResult(
        pulseService.dashboard.disablePublic({ dashboardId: dashboardId.value, user: requestAccessScope(c) }),
        projectDashboard,
      ),
    );
  })
  .post(
    "/dashboard-dsl/compile",
    describeRoute({
      tags: ["Pulse"],
      summary: "Compile a Pulse dashboard DSL document without saving it",
      responses: { 200: jsonResponse(DashboardDslCompileResultSchema, "Dashboard DSL diagnostics and config") },
    }),
    v("json", DashboardDslCompileSchema),
    async (c) => {
      const input = c.req.valid("json");
      const baseId = await requirePublicIdParam(input.baseId, "base ID", "bases");
      if (!baseId.ok) return respond(c, baseId.result);
      return respond(c, pulseService.dashboard.compileDsl({ ...input, baseId: baseId.value, user: requestAccessScope(c) }));
    },
  );

export default routes;
