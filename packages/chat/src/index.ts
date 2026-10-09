import { type AuthContext, auth, middleware } from "@k2b/cloud/server";
import { Hono } from "hono";
import apiRoutes from "./api";
import { app, ssr } from "./config";
import pageRoutes, { adminPages } from "./frontend";
import { chatHelp } from "./help";
import { migrate } from "./migrate";
import { chatService } from "./service";

const router = new Hono<AuthContext>()
  .use("*", middleware.runtime())
  .use("*", middleware.settings())
  .route("/api/chat", apiRoutes)
  .route("/app/chat", pageRoutes)
  .route("/admin/chat", adminPages);

router.get("/app/chat/*", auth.requireRole("*"), (c) => ssr.error(c, 404));
router.get("/admin/chat/*", auth.requireRole("*"), (c) => ssr.error(c, 404));

export default await app.start({
  fetch: router.fetch,
  help: chatHelp,
  openapi: apiRoutes,
  lifecycle: {
    setup: async () => {
      await migrate();
    },
  },
});
export type { ApiType } from "./api";
export type { ChatHealth, ChatService } from "./service";
export { chatService as service };
