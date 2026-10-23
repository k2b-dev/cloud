import { type AuthContext, auth, ok, rateLimit, respond } from "@k2b/cloud/server";
import { appAccessAuthority, usableAppIds } from "@k2b/cloud/services";
import { getLocalizedRuntimeContext } from "@k2b/cloud/ssr/runtime";
import { Hono } from "hono";
import { buildApiDocSources } from "./sources";

export const apiRoutes = new Hono<AuthContext>()
  .use(auth.requireRole("*"))
  .use(rateLimit())
  .get("/sources", async (c) => {
    const apps = getLocalizedRuntimeContext(c).apps;
    const allowed = await usableAppIds(appAccessAuthority(c), apps);
    return respond(c, ok({ items: buildApiDocSources(apps.filter((app) => allowed.has(app.id))) }));
  });

export type ApiType = typeof apiRoutes;
