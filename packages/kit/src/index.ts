import adminPages from "./frontend/admin";
import { database } from "./service/database";
let databaseTimer: ReturnType<typeof setInterval> | undefined;
let cleanup: Promise<void> | undefined;
const sweep = () =>
  (cleanup ??= database
    .reconcile()
    .catch(() => console.warn("Kit database cleanup deferred"))
    .finally(() => {
      cleanup = undefined;
    }));
import { type AuthContext, middleware } from "@k2b/cloud/server";
import { Hono } from "hono";
import api from "./api";
import { kitCapabilities } from "./capabilities";
import { app } from "./config";
import pages from "./frontend";
import { kitHelp } from "./help";
import { migrate } from "./migrate";

const router = new Hono<AuthContext>()
  .use("*", middleware.runtime())
  .use("*", middleware.settings())
  .route("/api/kit", api)
  .route("/app/kit", pages)
  .route("/admin/kit", adminPages);
export default await app.start({
  fetch: router.fetch,
  help: kitHelp,
  capabilities: kitCapabilities,
  openapi: api,
  lifecycle: {
    setup: migrate,
    start: async () => {
      await sweep();
      databaseTimer = setInterval(() => void sweep(), 30000);
      databaseTimer.unref();
    },
    stop: async () => {
      clearInterval(databaseTimer);
      await cleanup;
    },
  },
});

import * as service from "./service";

export type { ApiType } from "./api";
export { service };
