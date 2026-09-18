import { type AuthContext, middleware } from "@k2b/cloud/server";
import { Hono } from "hono";
import apiRoutes from "./api";
import { filesCapabilities } from "./capabilities";
import { app } from "./config";
import frontend from "./frontend";
import { filesHelp } from "./help";
import { filesLifecycle } from "./lifecycle";
import { publicApi } from "./public";

const router = new Hono<AuthContext>()
  .use("*", middleware.runtime())
  .use("*", middleware.settings())
  .route("/api/filesv2", apiRoutes)
  .route("/share/filesv2", publicApi)
  .route("/", frontend);
export default await app.start({ fetch: router.fetch, openapi: apiRoutes, help: filesHelp, lifecycle: filesLifecycle, capabilities: filesCapabilities });
export type { ApiType } from "./api";

export { filesService as service } from "./service";
