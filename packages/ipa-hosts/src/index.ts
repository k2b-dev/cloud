import { type AuthContext, middleware, auth } from "@valentinkolb/cloud/server";
import { Hono } from "hono";
import apiRoutes from "./api";
import { ipaSyncWidgetHandler } from "./api/widgets";
import { ipaHosts } from "./backend";
import { app, ssr } from "./config";
import adminPageRoutes from "./frontend";
import { ipaHostsHelp } from "./help";
import { migrate } from "./migrate";
import { ipaHostsService } from "./service";

const router = new Hono<AuthContext>()
  .use("*", middleware.runtime())
  .use("*", middleware.settings())
  .route("/api/ipa-hosts", apiRoutes)
  .route("/admin/ipa-hosts", adminPageRoutes);

router.get("/admin/ipa-hosts/*", auth.requireRole("*"), (c) => ssr.error(c, 404));

export default await app.start({
  fetch: router.fetch,
  help: ipaHostsHelp,
  openapi: apiRoutes,
  widgets: { sync: ipaSyncWidgetHandler },
  lifecycle: {
    setup: async () => {
      await migrate();
    },
    start: async () => {
      await ipaHosts.sync.start();
    },
    stop: async () => {
      await ipaHosts.sync.stop();
    },
  },
});
export type { ApiType } from "./api";
export type { IpaHostsService } from "./service";
export { ipaHostsService as service };
