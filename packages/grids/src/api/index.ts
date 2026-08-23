import { rateLimit } from "@valentinkolb/cloud/server";
import { Hono } from "hono";
import wsRoutes from "../ws";
import accessRoutes from "./access";
import adminRoutes from "./admin";
import adminSettingsRoutes from "./admin-settings";
import basesRoutes from "./bases";
import customAppsRoutes from "./custom-apps";
import documentsRoutes from "./documents";
import emailTemplateRoutes from "./email-templates";
import evidenceExportRoutes from "./evidence-exports";
import fieldsRoutes from "./fields";
import formsRoutes from "./forms";
import formulasRoutes from "./formulas";
import gqlRoutes from "./gql";
import htmlTemplateFieldRoutes from "./html-template-fields";
import recordsRoutes from "./records";
import tablesRoutes from "./tables";
import templatesRoutes from "./templates";
import viewsRoutes from "./views";
import workflowsRoutes from "./workflows";
import workspaceRoutes from "./workspace";

const app = new Hono()
  .use(rateLimit())
  .route("/ws", wsRoutes)
  .route("/admin/settings", adminSettingsRoutes)
  .route("/admin", adminRoutes)
  .route("/templates", templatesRoutes)
  .route("/bases", basesRoutes)
  .route("/apps", customAppsRoutes)
  .route("/tables", tablesRoutes)
  .route("/fields", fieldsRoutes)
  .route("/records", recordsRoutes)
  .route("/access", accessRoutes)
  .route("/views", viewsRoutes)
  .route("/documents", documentsRoutes)
  .route("/evidence-exports", evidenceExportRoutes)
  .route("/email-templates", emailTemplateRoutes)
  .route("/formulas", formulasRoutes)
  .route("/html-template-fields", htmlTemplateFieldRoutes)
  .route("/gql", gqlRoutes)
  .route("/workflows", workflowsRoutes)
  .route("/workspace", workspaceRoutes)
  .route("/forms", formsRoutes);

export default app;
export type ApiType = typeof app;
