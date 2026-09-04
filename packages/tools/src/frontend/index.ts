import { ssr } from "../config";
import { type AuthContext, auth } from "@valentinkolb/cloud/server";
import { type Handler, Hono, type MiddlewareHandler } from "hono";
import toolDetailPage from "./[tool]/page";
import toolsPage from "./page";

type ToolsPageRouteDependencies = {
  requireAny?: MiddlewareHandler<AuthContext>;
  requireAuthenticated?: MiddlewareHandler<AuthContext>;
  toolsPage?: Handler<AuthContext>[];
  toolDetailPage?: Handler<AuthContext>[];
};

export const createToolsPageRoutes = (dependencies: ToolsPageRouteDependencies = {}) =>
  new Hono<AuthContext>()
    .get("/", dependencies.requireAny ?? auth.requireRole("*"), ...(dependencies.toolsPage ?? toolsPage))
    .use("/document-markdown", dependencies.requireAuthenticated ?? auth.requireRole("authenticated", ssr.access))
    .use("/markdown-pdf", dependencies.requireAuthenticated ?? auth.requireRole("authenticated", ssr.access))
    .get("/:toolId", dependencies.requireAny ?? auth.requireRole("*"), ...(dependencies.toolDetailPage ?? toolDetailPage));

export default createToolsPageRoutes();
