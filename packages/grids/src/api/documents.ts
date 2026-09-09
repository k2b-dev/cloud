import { type AuthContext, auth } from "@k2b/cloud/server";
import { Hono, type MiddlewareHandler } from "hono";
import { createDocumentCollectionRoutes } from "./document-collection-routes";
import { createDocumentLinkRoutes } from "./document-link-routes";
import { createDocumentRenderRoutes } from "./document-render-routes";
import { createDocumentResourceRoutes } from "./document-resource-routes";
import { createDocumentSnapshotRoutes } from "./document-snapshot-routes";
import { createDocumentTemplateRoutes } from "./document-template-routes";

export const createDocumentsApi = (deps: { requireAuthenticated?: MiddlewareHandler<AuthContext> } = {}) =>
  new Hono<AuthContext>()
    .use(deps.requireAuthenticated ?? auth.requireRole("authenticated"))

    .route("/", createDocumentTemplateRoutes())

    .route("/", createDocumentRenderRoutes())

    .route("/", createDocumentCollectionRoutes())

    .route("/", createDocumentLinkRoutes())

    .route("/", createDocumentSnapshotRoutes())
    .route("/", createDocumentResourceRoutes({ requireAuthenticated: async (_c, next) => next() }));

export default createDocumentsApi();
