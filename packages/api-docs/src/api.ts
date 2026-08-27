import { getLocalizedRuntimeContext } from "@valentinkolb/cloud/ssr/runtime";
import { type AuthContext, ok, rateLimit, respond } from "@valentinkolb/cloud/server";
import { Hono } from "hono";
import { buildApiDocSources } from "./sources";

export const apiRoutes = new Hono<AuthContext>()
  .use(rateLimit())
  .get("/sources", (c) => respond(c, ok({ items: buildApiDocSources(getLocalizedRuntimeContext(c).apps) })));

export type ApiType = typeof apiRoutes;
