import { Hono, type MiddlewareHandler } from "hono";
import { describeRoute } from "hono-openapi";
import { GeoBudgetInputSchema, GeoKeyInputSchema } from "../contracts/geo-admin";
import { type AuthContext, auth, v } from "../server";
import { GeoAdminError, geoAdmin } from "../services/geo/admin";

export const createAdminGeoRoutes = (
  authenticate: MiddlewareHandler<AuthContext> = auth.requireRole("admin"),
  service: Pick<typeof geoAdmin, "status" | "usage" | "setKey" | "removeKey" | "saveBudget"> = geoAdmin,
) =>
  new Hono<AuthContext>()
    .use(authenticate)
    .onError((error, c) => {
      if (error instanceof GeoAdminError) return c.json(error.body, error.status);
      if (c.req.raw.signal.aborted) return new Response(null, { status: 499 });
      throw error;
    })
    .get(
      "/",
      describeRoute({ tags: ["Places and maps"], summary: "Show the Geoapify key state, plan and budgets" }),
      auth.requireOAuthScope("read", "admin"),
      async (c) => c.json(await service.status(c.get("user"))),
    )
    .get(
      "/usage",
      describeRoute({ tags: ["Places and maps"], summary: "Show this month's and today's geo credits with shares per function" }),
      auth.requireOAuthScope("read", "admin"),
      async (c) => c.json(await service.usage(c.get("user"))),
    )
    .put(
      "/key",
      describeRoute({
        tags: ["Places and maps"],
        summary: "Verify a Geoapify key with one provider lookup, then store it; a refused key changes nothing",
      }),
      auth.requireOAuthScope("write", "admin"),
      v("json", GeoKeyInputSchema),
      async (c) => c.json(await service.setKey(c.get("user"), c.req.valid("json").apiKey, c.req.raw.signal)),
    )
    .delete(
      "/key",
      describeRoute({ tags: ["Places and maps"], summary: "Remove the Geoapify key; places and maps turn off for everyone" }),
      auth.requireOAuthScope("write", "admin"),
      async (c) => c.json(await service.removeKey(c.get("user"))),
    )
    .put(
      "/budget",
      describeRoute({ tags: ["Places and maps"], summary: "Save the plan, the monthly budget and the daily limit per person" }),
      auth.requireOAuthScope("write", "admin"),
      v("json", GeoBudgetInputSchema),
      async (c) => c.json(await service.saveBudget(c.get("user"), c.req.valid("json"))),
    );

export default createAdminGeoRoutes();
