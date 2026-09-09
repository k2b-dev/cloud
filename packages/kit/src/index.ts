import { type AuthContext, middleware } from "@k2b/cloud/server";
import { Hono } from "hono";
import api from "./api";
import { kitCapabilities } from "./capabilities";
import { app } from "./config";
import pages from "./frontend";
import { kitHelp } from "./help";
import { migrate } from "./migrate";

const router = new Hono<AuthContext>()
  .use("*", middleware.runtime())
  .use("*", middleware.settings())
  .route("/api/kit", api)
  .route("/app/kit", pages);
export default await app.start({
  fetch: router.fetch,
  help: kitHelp,
  capabilities: kitCapabilities,
  openapi: api,
  lifecycle: { setup: migrate },
});

import * as service from "./service";

export type { ApiType } from "./api";
export { service };
