import { type AuthContext, middleware } from "@valentinkolb/cloud/server";
import { Hono } from "hono";
import apiRoutes from "./api";
import { app } from "./config";
import pageRoutes from "./frontend";
import { migrate } from "./migrate";
import { oauthService } from "./service";
import { oauth } from "./service/oauth";

const OAUTH_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1_000;
let cleanupTimer: ReturnType<typeof setInterval> | undefined;

const cleanupOAuthStorage = async (): Promise<void> => {
  await Promise.all([
    oauth.codes.cleanup(),
    oauth.refreshTokens.cleanup(),
    oauth.clients.cleanupUnusedDynamic(),
    oauth.tokens.cleanupSigningKeys(),
    oauth.tokens.cleanupAuthorityGrants(),
  ]);
};

const router = new Hono<AuthContext>()
  .use("*", middleware.runtime())
  .use("*", middleware.settings())
  .route("/api/oauth/admin/clients", apiRoutes)
  .route("/", pageRoutes);

export default await app.start({
  fetch: router.fetch,
  openapi: apiRoutes,
  lifecycle: {
    setup: async () => {
      await migrate();
      await oauth.tokens.ensureConfiguredIssuanceMode();
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
