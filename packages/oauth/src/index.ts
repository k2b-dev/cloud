import { type AuthContext, auth, middleware } from "@valentinkolb/cloud/server";
import { Hono } from "hono";
import apiRoutes from "./api";
import { app, ssr } from "./config";
import pageRoutes from "./frontend";
import { migrate } from "./migrate";
import { oauthService } from "./service";
import { oauth } from "./service/oauth";
import { probeOAuthTokenAuthority } from "./service/token-authority";

const OAUTH_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1_000;
let cleanupTimer: ReturnType<typeof setInterval> | undefined;

const cleanupOAuthStorage = async (): Promise<void> => {
  await Promise.all([
    oauth.codes.cleanup(),
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
      await cleanupOAuthStorage().catch((error) => {
        ctx.logger("oauth:cleanup").warn("OAuth cleanup failed", { error: error instanceof Error ? error.message : String(error) });
      });
      cleanupTimer = setInterval(() => {
        void cleanupOAuthStorage().catch((error) => {
          ctx.logger("oauth:cleanup").warn("OAuth cleanup failed", { error: error instanceof Error ? error.message : String(error) });
        });
      }, OAUTH_CLEANUP_INTERVAL_MS);
      cleanupTimer.unref?.();
    },
    stop: async () => {
      if (cleanupTimer) clearInterval(cleanupTimer);
      cleanupTimer = undefined;
    },
  },
});
export type { ApiType } from "./api";
export type { OauthService } from "./service";
export { oauthService as service };
