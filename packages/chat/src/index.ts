import { type AuthContext, auth, middleware } from "@k2b/cloud/server";
import { Hono } from "hono";
import { websocket } from "hono/bun";
import apiRoutes from "./api";
import { app, ssr } from "./config";
import pageRoutes, { adminPages } from "./frontend";
import { chatHelp } from "./help";
import { migrate } from "./migrate";
import { chatService } from "./service";
import { maintenanceLifecycle } from "./service/maintenance";

const router = new Hono<AuthContext>()
  .use("*", middleware.runtime())
  .use("*", middleware.settings())
  .route("/api/chat", apiRoutes)
  .route("/app/chat", pageRoutes)
  .route("/admin/chat", adminPages);

router.get("/app/chat/*", auth.requireRole("*"), (c) => ssr.error(c, 404));
router.get("/admin/chat/*", auth.requireRole("*"), (c) => ssr.error(c, 404));

const result = await app.start({
  fetch: router.fetch,
  help: chatHelp,
  openapi: apiRoutes,
  lifecycle: {
    ...maintenanceLifecycle,
    setup: async () => {
      await migrate();
    },
  },
});
// `/api/chat/live` upgrades through Bun, which needs the WebSocket handlers on the server definition.
export default { ...result, websocket };
export type { ApiType } from "./api";
export type { ChatHealth, ChatService } from "./service";
export { chatService as service };
