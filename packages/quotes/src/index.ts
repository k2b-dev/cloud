import { type AuthContext, middleware } from "@k2b/cloud/server";
import { Hono } from "hono";
import apiRoutes from "./api";
import { quoteWidgetHandler } from "./api/widgets";
import { app } from "./config";
import { quotesService } from "./service";

const router = new Hono<AuthContext>().use("*", middleware.runtime()).use("*", middleware.settings()).route("/api/quotes", apiRoutes);

export default await app.start({ fetch: router.fetch, openapi: apiRoutes, widgets: { quote: quoteWidgetHandler } });
export type { ApiType } from "./api";
export { quotesService as service };
