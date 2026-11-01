import { type AuthContext, auth, middleware } from "@k2b/cloud/server";
import { Hono } from "hono";
import humanApi from "./api";
import adminPages from "./artifacts/admin-page";
import { codeToolRoutes } from "./artifacts/code-tool-routes";
import { machineApi } from "./artifacts/machine-api";
import { runnerApi } from "./artifacts/runner-api";
import { ssr } from "./config";
import pageRoutes from "./frontend";

// The same relative API tree drives request routing and the published schema.
// Human routes retain their own user-backed middleware.
export const apiRoutes = new Hono<AuthContext>().route("/artifacts/machine", machineApi).route("/", humanApi);

export const router = new Hono<AuthContext>()
  .use("*", middleware.noTransform())
  .use("*", middleware.runtime())
  .use("*", middleware.settings())
  .route("/_internal/assistant/tools", codeToolRoutes)
  .route("/api/assistant/runner", runnerApi)
  .route("/api/assistant", apiRoutes)
  .route("/app/assistant", pageRoutes)
  .route("/admin/assistant", adminPages);

router.get("/app/assistant/*", auth.requireRole("*"), (c) => ssr.error(c, 404));
