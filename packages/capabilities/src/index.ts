import { type AuthContext, middleware, auth } from "@k2b/cloud/server";
import { Hono } from "hono";
import { app, ssr } from "./config";
import pageRoutes from "./frontend";

const router = new Hono<AuthContext>()
  .use("*", middleware.runtime())
  .use("*", middleware.settings())
  .route("/app/capabilities", pageRoutes);

router.get("/app/capabilities/*", auth.requireRole("*"), (c) => ssr.error(c, 404));

export default await app.start({ fetch: router.fetch });
