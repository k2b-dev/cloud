import { err, fail } from "@k2b/stdlib";
import { ErrorResponseSchema } from "@valentinkolb/cloud/contracts";
import { type AuthContext, auth, getLocale, jsonResponse, respond } from "@valentinkolb/cloud/server";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { describeRoute } from "hono-openapi";
import { BaseNavigationSchema, NAVIGATION_MAX_BYTES } from "../navigation-contracts";
import { getBaseNavigation, updateBaseNavigation } from "../service/base-navigation";
import { currentActorUserId, gateAt } from "./permissions";
import { internalIdParam, requirePublicIdParam } from "./route-params";
import { v } from "./validator";

const route = describeRoute({
  tags: ["Grids:Base"],
  summary: "Read or replace shared base navigation (base admin)",
  responses: {
    200: jsonResponse(BaseNavigationSchema, "Navigation"),
    400: jsonResponse(ErrorResponseSchema, "Invalid input"),
    403: jsonResponse(ErrorResponseSchema, "Forbidden"),
    409: jsonResponse(ErrorResponseSchema, "Revision conflict"),
  },
});
export default new Hono<AuthContext>()
  .use(auth.requireRole("authenticated"))
  .get("/:baseId/navigation", requirePublicIdParam("baseId", "base", "Base"), route, async (c) => {
    const baseId = internalIdParam(c, "baseId")!;
    const access = await gateAt(c, { baseId }, "admin");
    if (!access.ok) return respond(c, () => Promise.resolve(access));
    const navigation = await getBaseNavigation(baseId);
    return navigation ? c.json(navigation) : respond(c, () => Promise.resolve(fail(err.notFound("Base"))));
  })
  .put(
    "/:baseId/navigation",
    bodyLimit({ maxSize: NAVIGATION_MAX_BYTES + 1024 }),
    requirePublicIdParam("baseId", "base", "Base"),
    route,
    v("json", BaseNavigationSchema),
    async (c) => {
      const baseId = internalIdParam(c, "baseId")!;
      const access = await gateAt(c, { baseId }, "admin");
      if (!access.ok) return respond(c, () => Promise.resolve(access));
      return respond(c, () => updateBaseNavigation(baseId, c.req.valid("json"), currentActorUserId(c), getLocale(c)));
    },
  );
