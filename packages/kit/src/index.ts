import { Hono } from "hono";
import { middleware, type AuthContext } from "@valentinkolb/cloud/server";
import { app } from "./config";
import api from "./api";
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
  openapi: api,
  lifecycle: { setup: migrate },
});
