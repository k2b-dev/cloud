import { Hono } from "hono";
import { middleware, type AuthContext } from "@valentinkolb/cloud/server";
import { app } from "./config";
import api from "./api";
import pages from "./frontend";
import { kitCapabilities } from "./capabilities";
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
