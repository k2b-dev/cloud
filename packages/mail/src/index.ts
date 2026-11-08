import { stopRuntimeResources } from "@k2b/cloud/services";
import { websocket } from "hono/bun";
import apiRoutes from "./api";
import { stopMailDraftConnections } from "./api/draft-document-socket";
import { mailCapabilities } from "./capabilities";
import { app } from "./config";
import { mailHelp } from "./help";
import {
  buildActivityFeedIndex,
  buildBackfillActivityIndex,
  buildCommandTargetIndex,
  buildOpenConversationIndex,
  buildOptionalSearchIndex,
  buildProviderMessageIndex,
  migrate,
} from "./migrate";
import { createMailNotificationService } from "./notifications";
import { router } from "./router";
import { commandRuntime, mailRuntime } from "./service";
import { applicationAiRuntime } from "./service/application-ai-runtime";
import { startConversationSummaryRuntime, stopConversationSummaryRuntime } from "./service/conversation-summary-jobs";
import { retireMailRuleBroker } from "./service/retired-rule-broker";
import { stopConversationViewCountCache } from "./service/view-count-cache";

const mailNotifications = createMailNotificationService(app.notifications);

const stopMailRuntimes = (): Promise<void> =>
  stopRuntimeResources([
    stopMailDraftConnections,
    stopConversationViewCountCache,
    () => stopConversationSummaryRuntime(),
    () => mailRuntime.stop(),
    applicationAiRuntime.stop,
    () => commandRuntime.stop(),
    () => mailNotifications.stop(),
  ]);

const result = await app.start({
  capabilities: mailCapabilities,
  fetch: router.fetch,
  help: mailHelp,
  openapi: apiRoutes,
  lifecycle: {
    setup: async () => {
      await migrate();
      // Startup waits for none of these builds. A busy predecessor defers the rest until
      // the next start: concurrent expression builds can wait on each other's snapshots.
      void (async () => {
        if ((await buildBackfillActivityIndex()) === "busy") return;
        if ((await buildCommandTargetIndex()) === "busy") return;
        if ((await buildProviderMessageIndex()) === "busy") return;
        if ((await buildOpenConversationIndex()) === "busy") return;
        if ((await buildActivityFeedIndex()) === "busy") return;
        await buildOptionalSearchIndex();
      })();
    },
    start: async () => {
      try {
        await retireMailRuleBroker();
        await mailNotifications.start();
        await mailRuntime.start();
        await commandRuntime.start();
        await applicationAiRuntime.start();
        await startConversationSummaryRuntime();
      } catch (startError) {
        try {
          await stopMailRuntimes();
        } catch (cleanupError) {
          throw new AggregateError([startError, cleanupError], "Mail startup and cleanup failed");
        }
        throw startError;
      }
    },
    stop: stopMailRuntimes,
  },
});
export default { ...result, websocket };

export type { ApiType } from "./api";
export * from "./contracts";
export { mailService as service } from "./service";
