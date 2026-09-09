import { type AuthContext, middleware, auth } from "@k2b/cloud/server";
import { Hono } from "hono";
import { websocket } from "hono/bun";
import apiRoutes from "./api";
import { contactsCapabilities } from "./capabilities";
import { capabilityRetention } from "./capability-retention";
import { app, ssr } from "./config";
import pageRoutes, { adminPages as adminPageRoutes } from "./frontend";
import { contactsHelp } from "./help";
import { migrate } from "./migrate";
import { contactsService } from "./service";

const router = new Hono<AuthContext>()
  .use("*", middleware.runtime())
  .use("*", middleware.settings())
  .route("/api/contacts", apiRoutes)
  .route("/app/contacts", pageRoutes)
  .route("/admin/contacts", adminPageRoutes);

router.get("/app/contacts/*", auth.requireRole("*"), (c) => ssr.error(c, 404));
router.get("/admin/contacts/*", auth.requireRole("*"), (c) => ssr.error(c, 404));

const result = await app.start({
  capabilities: contactsCapabilities,
  fetch: router.fetch,
  help: contactsHelp,
  openapi: apiRoutes,
  lifecycle: {
    setup: async () => {
      await migrate();
    },
    start: capabilityRetention.start,
    stop: capabilityRetention.stop,
  },
});
export default { ...result, websocket };
export type { ApiType } from "./api";
export type {
  Contact,
  ContactBook,
  CreateBookInput,
  CreateContactInput,
  UpdateBookInput,
  UpdateContactInput,
} from "./service";
export { contactsService as service };
