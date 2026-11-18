import { type AuthContext, auth, middleware } from "@k2b/cloud/server";
import { startRuntimeInterval } from "@k2b/cloud/services";
import { Hono } from "hono";
import apiRoutes from "./api";
import { app, ssr } from "./config";
import pageRoutes from "./frontend";
import { migrate } from "./migrate";
import { oauthService } from "./service";
import { oauth } from "./service/oauth";
import { probeOAuthTokenAuthority } from "./service/token-authority";

const OAUTH_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1_000;
let cleanup: ReturnType<typeof startRuntimeInterval> | undefined;

const cleanupOAuthStorage = async (): Promise<void> => {
  await Promise.all([
    oauth.codes.cleanup(),
    oauth.device.cleanup(),
    oauth.refreshTokens.cleanup(),
    oauth.clients.cleanupUnusedDynamic(),
    oauth.tokens.cleanupAuthorityGrants(),
  ]);
};

const router = new Hono<AuthContext>()
  .use("*", middleware.runtime())
  .use("*", middleware.settings())
  .route("/api/oauth/admin/clients", apiRoutes)
  .route("/", pageRoutes);

router.get("/admin/oauth/*", auth.requireRole("*"), (c) => ssr.error(c, 404));
router.get("/oauth/consent/*", auth.requireRole("*"), (c) => ssr.error(c, 404));
router.get("/oauth/device/*", auth.requireRole("*"), (c) => ssr.error(c, 404));
router.get("/oauth/error/*", auth.requireRole("*"), (c) => ssr.error(c, 404, { layout: "minimal" }));

export default await app.start({
  fetch: router.fetch,
  openapi: apiRoutes,
  lifecycle: {
    setup: async () => {
      await probeOAuthTokenAuthority();
      await migrate();
    },
    start: async (ctx) => {
      cleanup = startRuntimeInterval({
        run: () => cleanupOAuthStorage(),
        intervalMs: OAUTH_CLEANUP_INTERVAL_MS,
        onError: (error) =>
          ctx.logger("oauth:cleanup").warn("OAuth cleanup failed", { error: error instanceof Error ? error.message : String(error) }),
      });
    },
    stop: async () => {
      await cleanup?.stop();
      cleanup = undefined;
    },
  },
});
export type { ApiType } from "./api";
export type { OauthService } from "./service";
export { oauthService as service };
