import { type AuthContext, rateLimit } from "@k2b/cloud/server";
import { Hono } from "hono";
import documentMarkdownRoutes from "./document-markdown";
import markdownPdfRoutes from "./markdown-pdf";
import speedtestRoutes from "./speedtest";
import speedtestCliRoutes from "./speedtest-cli";
import webhookRoutes from "./webhooks";

const buildToolsApi = () =>
  new Hono<AuthContext>()
    .route("/speedtest", speedtestRoutes)
    .use(rateLimit())
    .route("/speedtest", speedtestCliRoutes)
    .route("/documents", documentMarkdownRoutes)
    .route("/markdown", markdownPdfRoutes)
    .route("/webhooks", webhookRoutes);

export type ApiType = ReturnType<typeof buildToolsApi>;

export const createToolsApiRouter = () => buildToolsApi();
