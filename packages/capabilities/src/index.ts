import { type AuthContext, auth, middleware } from "@k2b/cloud/server";
import { Hono } from "hono";
import { catalogCapabilities } from "./capabilities";
import { app, ssr } from "./config";
import pageRoutes from "./frontend";

const router = new Hono<AuthContext>()
  .use("*", middleware.runtime())
  .use("*", middleware.settings())
  .route("/app/capabilities", pageRoutes);

router.get("/app/capabilities/*", auth.requireRole("*"), (c) => ssr.error(c, 404));

export default await app.start({ fetch: router.fetch, capabilities: catalogCapabilities });
