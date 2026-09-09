import { type AuthContext, auth } from "@k2b/cloud/server";
import { Hono } from "hono";
import { authenticatedFormRoutes } from "./form-authenticated-routes";
import { publicFormRoutes } from "./form-public-routes";

const formsRoutes = new Hono<AuthContext>()
  .route("/", publicFormRoutes)
  .use(auth.requireRole("authenticated"))
  .route("/", authenticatedFormRoutes);

export default formsRoutes;
