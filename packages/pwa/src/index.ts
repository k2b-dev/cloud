import { type AuthContext, middleware } from "@k2b/cloud/server";
import { Hono } from "hono";
import { app } from "./config";
import { shellRoutes } from "./frontend";

const router = new Hono<AuthContext>().use("*", middleware.runtime()).use("*", middleware.settings()).route("/", shellRoutes);

export default await app.start({ fetch: router.fetch });
