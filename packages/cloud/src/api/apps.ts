import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { ErrorResponseSchema } from "../contracts";
import { type AuthContext, auth, jsonResponse, requiresAuth, v } from "../server";
import { visibleNavigationApps } from "../ssr/app-navigation";
import { getLocalizedRuntimeContext } from "../ssr/runtime";

const AppListQuerySchema = z.object({
  search: z.string().trim().min(1).optional(),
});

const VisibleAppSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  icon: z.string(),
  href: z.string(),
});

const VisibleAppListSchema = z.object({
  items: z.array(VisibleAppSchema),
});

export const appDiscoveryRoutes = new Hono<AuthContext>().use(auth.requireRole("authenticated")).get(
  "/",
  describeRoute({
    tags: ["Apps"],
    summary: "List apps available to the current user",
    description: "Returns live Cloud apps that are visible in the current user's navigation.",
    ...requiresAuth,
    responses: {
      200: jsonResponse(VisibleAppListSchema, "Available apps"),
      401: jsonResponse(ErrorResponseSchema, "Authentication required"),
    },
  }),
  v("query", AppListQuerySchema),
  (c) => {
    const search = c.req.valid("query").search?.toLowerCase();
    const items = visibleNavigationApps(getLocalizedRuntimeContext(c).apps, c.get("user"))
      .map((app) => ({
        id: app.id,
        name: app.name,
        description: app.description,
        icon: app.icon,
        href: app.nav.href,
      }))
      .filter((app) => !search || `${app.id} ${app.name} ${app.description}`.toLowerCase().includes(search));
    return c.json({ items });
  },
);
