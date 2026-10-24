/**
 * Core app — thin shell that mounts the platform API (defined in cloud-lib),
 * builds runtime pages, and runs core setup hooks. The API itself lives in
 * `@k2b/cloud/api` so other apps can import its typed client without
 * cross-app imports.
 */

import { aiSkillsRoutes } from "@k2b/cloud/ai";
import { aiLive, aiLiveChannels } from "@k2b/cloud/ai/live";
import {
  createAiOpenAiRoutes,
  createAppAccessRoutes,
  createCoreApiRouter,
  createMcpProtectedResourceRoutes,
  createPwaPhoneRoutes,
} from "@k2b/cloud/api";
import { type AppContext, type AuthContext, middleware } from "@k2b/cloud/server";
import { createIdentityPublicRoutes } from "@k2b/cloud/services/identity";
import { Hono } from "hono";
import { websocket } from "hono/bun";
import { aiChatTaskRoutes } from "./ai-chat-task-routes";
import { createAiNotificationService } from "./ai-notifications";
import identityInvocationRoutes from "./api/identity-invocation";
import identityMandateRoutes from "./api/identity-mandates";
import identityOAuthDeviceApprovalRoutes, { terminalLogins } from "./api/identity-oauth-device-approval";
import { createIdentityOAuthIssuanceRoutes } from "./api/identity-oauth-issuance";
import { aiCapabilities } from "./capabilities";
import { app } from "./config";
import { coreHelp } from "./help";
import { buildSearchIndexes as buildOutgoingMailSearchIndexes } from "./migrate/core/outgoing-mail";
import { createCoreNotificationSender } from "./notifications";
import { createPagesRouter } from "./pages/create";
import { runCoreSetup, startCoreServices, stopCoreServices } from "./runtime-helpers";

/** Per-app Hono context: AuthContext + typed core settings snapshot. */
export type CoreAppContext = AppContext<typeof app>;

const notificationSender = createCoreNotificationSender(app.notifications);
const aiNotifications = createAiNotificationService(app.notifications);
const { api } = createCoreApiRouter({ notifications: notificationSender, terminalLogins });
const pages = createPagesRouter();
const mcpProtectedResource = createMcpProtectedResourceRoutes();
const identityPublicRoutes = createIdentityPublicRoutes();

// Dedicated brokers must precede Task auth on /api/ai/*: models-only OpenAI keys
// and non-user Skills readers cannot pass the Task router's user requirement.
const coreApi = new Hono()
  .route("/ai/openai/v1", createAiOpenAiRoutes())
  .route("/ai/skills", aiSkillsRoutes)
  .route("/ai", aiChatTaskRoutes)
  .route("/", api);

const router = new Hono<AuthContext>()
  .use("*", middleware.runtime())
  .use("*", middleware.settings())
  .route("/_cloud/app-access", createAppAccessRoutes())
  .route("/", identityPublicRoutes)
  .route("/", mcpProtectedResource)
  .route("/api/ai/live", aiLive.routes(aiLiveChannels))
  .route("/api/_internal/identity/v1", identityInvocationRoutes)
  .route("/api/_internal/identity/v1", identityMandateRoutes)
  .route("/api/_internal/identity/v1", createIdentityOAuthIssuanceRoutes({ notifyNewAccess: notificationSender.sendOAuthNewAccess }))
  .route("/api/_internal/identity/v1", identityOAuthDeviceApprovalRoutes)
  .route("/api", coreApi)
  // The mobile app's phone-side identity endpoints; only Core receives the device key.
  .route("/pwa/_auth", createPwaPhoneRoutes({ notify: notificationSender.sendAppDevicePaired }))
  .route("/", pages);

const result = await app.start({
  fetch: router.fetch,
  capabilities: aiCapabilities,
  help: coreHelp,
  openapi: coreApi,
  lifecycle: {
    setup: async () => {
      await runCoreSetup();
      // Searches run without the send log indexes until they are built, so startup does not wait for them.
      void buildOutgoingMailSearchIndexes();
    },
    start: async () => {
      await startCoreServices(notificationSender, aiNotifications);
    },
    stop: async () => {
      await stopCoreServices(aiNotifications);
    },
  },
});

export default { ...result, websocket };
