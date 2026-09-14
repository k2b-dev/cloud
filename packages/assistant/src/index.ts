import { agentHost } from "./artifacts/agent-host";
import { httpService } from "./artifacts/http-service";
import adminPages from "./artifacts/admin-page";
import { artifactDatabase } from "./artifacts/database";
import { type AuthContext, middleware, auth } from "@k2b/cloud/server";
import { Hono } from "hono";
import { websocket } from "hono/bun";
import apiRoutes from "./api";
import { app, ssr } from "./config";
import pageRoutes from "./frontend";
import { assistantHelp } from "./help";
import { codeToolRoutes } from "./artifacts/code-tool-routes";
import { migrateArtifacts } from "./artifacts/migrate";

let hostTimer: ReturnType<typeof setInterval> | undefined;
let hostSweep: Promise<unknown> | undefined;
let databaseTimer: ReturnType<typeof setInterval> | undefined;
let databaseCleanup: Promise<unknown> | undefined;
const sweep = () => databaseCleanup ??= Promise.all([artifactDatabase.cleanup(), httpService.cleanup()]).catch(() => console.warn("Assistant storage cleanup deferred")).finally(() => {databaseCleanup=undefined;});

const router = new Hono<AuthContext>()
  .use("*", middleware.runtime())
  .use("*", middleware.settings())
  .route("/_internal/assistant/tools", codeToolRoutes)
  .route("/api/assistant", apiRoutes)
  .route("/app/assistant", pageRoutes)
  .route("/admin/assistant",adminPages);

router.get("/app/assistant/*", auth.requireRole("*"), (c) => ssr.error(c, 404));

const result = await app.start({
  fetch: router.fetch,
  help: assistantHelp,
  openapi: apiRoutes,
  lifecycle: { setup: migrateArtifacts,
    start: async () => { hostTimer=setInterval(()=>{hostSweep ??= agentHost.sweep().catch(()=>console.warn("Code host cleanup deferred")).finally(()=>{hostSweep=undefined;});},1000);hostTimer.unref(); await sweep(); databaseTimer=setInterval(() => void sweep(),30000); databaseTimer.unref(); },
    stop: async () => {clearInterval(hostTimer);await hostSweep;await agentHost.close();clearInterval(databaseTimer); await databaseCleanup;},
  },
});
export default { ...result, websocket };

export type { ApiType } from "./api";
