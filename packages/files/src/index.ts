import { type AppContext, type AuthContext, middleware, auth } from "@valentinkolb/cloud/server";
import { Hono } from "hono";
import apiRoutes from "./api";
import { filesCapabilities } from "./capabilities";
import { app, ssr } from "./config";
import pageRoutes, { adminPages as adminPageRoutes } from "./frontend";
import { filesHelp } from "./help";
import { filesService } from "./service";

/** Per-app Hono context: AuthContext + typed snapshot with files.* + core.* settings. */
export type FilesAppContext = AppContext<typeof app>;

const router = new Hono<AuthContext>()
  .use("*", middleware.runtime())
  .use("*", middleware.settings())
  .route("/api/files", apiRoutes)
  .route("/app/files", pageRoutes)
  .route("/admin/files", adminPageRoutes);

router.get("/app/files/*", auth.requireRole("*"), (c) => ssr.error(c, 404));
router.get("/admin/files/*", auth.requireRole("*"), (c) => ssr.error(c, 404));

export default await app.start({
  capabilities: filesCapabilities,
  fetch: router.fetch,
  help: filesHelp,
  openapi: apiRoutes,
});
export type { ApiType } from "./api";
export { filesService as service };
