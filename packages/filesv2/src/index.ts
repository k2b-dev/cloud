import { type AuthContext, middleware } from "@k2b/cloud/server";
import { Hono } from "hono";
import apiRoutes from "./api";
import { app } from "./config";
import frontend from "./frontend";
import { filesHelp } from "./help";
import { migrate } from "./migrate";

const router = new Hono<AuthContext>()
  .use("*", middleware.runtime())
  .use("*", middleware.settings())
  .route("/api/filesv2", apiRoutes)
  .route("/", frontend);
export default await app.start({ fetch: router.fetch, openapi: apiRoutes, help: filesHelp, lifecycle: { setup: migrate } });
export type { ApiType } from "./api";

export { filesService as service } from "./service";
