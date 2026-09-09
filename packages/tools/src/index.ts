import { type AuthContext, middleware, auth } from "@k2b/cloud/server";
import { Hono } from "hono";
import { createToolsApiRouter } from "./api";
import documentMarkdownRoutes from "./api/document-markdown";
import markdownPdfRoutes from "./api/markdown-pdf";
import speedtestRoutes from "./api/speedtest";
import speedtestCliRoutes from "./api/speedtest-cli";
import webhookRoutes from "./api/webhooks";
import { app, ssr } from "./config";
import pageRoutes from "./frontend";
import { toolsHelp } from "./help";
import { migrate } from "./migrate";

const apiRoutes = createToolsApiRouter();

export type { ApiType } from "./api";

const router = new Hono<AuthContext>()
  // Raw measurement endpoints (ping/download/upload) mount before runtime
  // and settings middleware so neither runs in the chain — they don't
  // need the platform runtime snapshot or per-request settings cache,
  // and skipping them keeps the ping baseline as low as the HTTP stack
  // allows.
  .route("/tools/api/speedtest", speedtestRoutes)
  .use("*", middleware.runtime())
  .use("*", middleware.settings())
  // CLI script endpoints sit behind settings — they template the public
  // app URL (`settings.app.url`) into the served script.
  .route("/tools/api/speedtest", speedtestCliRoutes)
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
