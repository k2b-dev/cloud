import { type AuthContext, auth } from "@k2b/cloud/server";
import { Hono, type MiddlewareHandler } from "hono";
import { createWorkflowCatalogRoutes } from "./workflow-catalog-routes";
import { createWorkflowRunRoutes } from "./workflow-run-routes";
import { createWorkflowTriggerRoutes } from "./workflow-trigger-routes";

export { permissionedWorkflowCatalog } from "./workflow-api-shared";

const createWorkflowsApi = (deps: { requireAuthenticated?: MiddlewareHandler<AuthContext>; [key: string]: unknown } = {}) =>
  new Hono<AuthContext>()
    .use(deps.requireAuthenticated ?? auth.requireRole("authenticated"))
    .route("/", createWorkflowCatalogRoutes())
    .route("/", createWorkflowRunRoutes())
    .route("/", createWorkflowTriggerRoutes());

export default createWorkflowsApi();
