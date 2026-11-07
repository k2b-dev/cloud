import { type AuthContext, auth, middleware } from "@k2b/cloud/server";
import { Hono } from "hono";
import { createToolsApiRouter } from "./api";
import adminSettingsRoutes from "./api/admin-settings";
import documentMarkdownRoutes from "./api/document-markdown";
import markdownPdfRoutes from "./api/markdown-pdf";
import speedtestRoutes from "./api/speedtest";
import webhookRoutes from "./api/webhooks";
import { app, ssr } from "./config";
import pageRoutes from "./frontend";
import { toolsHelp } from "./help";
import { migrate } from "./migrate";

const apiRoutes = createToolsApiRouter();

export type { ApiType } from "./api";

const router = new Hono<AuthContext>()
  .use("*", middleware.runtime())
  .use("*", middleware.settings())
  .route("/tools/api/admin/settings", adminSettingsRoutes)
  .route("/tools/api/speedtest", speedtestRoutes)
  .route("/tools/api/documents", documentMarkdownRoutes)
  .route("/tools/api/markdown", markdownPdfRoutes)
  .route("/tools/api/webhooks", webhookRoutes)
  .all("/tools/api/*", (c) => c.notFound())
  .route("/tools", pageRoutes);

router.get("/tools/*", auth.requireRole("*"), (c) => ssr.error(c, 404));

export default await app.start({
  fetch: router.fetch,
  help: toolsHelp,
  openapi: apiRoutes,
  lifecycle: {
    setup: async () => {
      await migrate();
    },
  },
});
