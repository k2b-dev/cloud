import { requireIdentityAccessEvents } from "@k2b/cloud/events";
import { logger, stopRuntimeResources } from "@k2b/cloud/services";
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
  buildRuntimeHistoryIndexes,
  migrate,
} from "./migrate";
import { migrateSharedDrafts } from "./migrate-shared-drafts";
import { createMailNotificationService } from "./notifications";
import { router } from "./router";
import { commandRuntime, mailRuntime } from "./service";
import { applicationAiRuntime } from "./service/application-ai-runtime";
import { startConversationSummaryRuntime, stopConversationSummaryRuntime } from "./service/conversation-summary-jobs";
import { stopDraftDocumentPruning } from "./service/draft-document-log";
import { startDraftDocumentLogPolicy, stopDraftDocumentLogPolicy } from "./service/draft-document-log-policy";
import { retryPendingDraftSendCloses } from "./service/draft-document-send";
import { draftDocumentSnapshots, stopDraftDocumentSnapshots } from "./service/draft-document-snapshots";
import { stopDraftDocumentCancellation } from "./service/draft-document-socket-sql";
import { finishReplyDraftRetirements } from "./service/draft-retirement";
import { retireMailRuleBroker } from "./service/retired-rule-broker";
import { stopConversationViewCountCache } from "./service/view-count-cache";

const mailNotifications = createMailNotificationService(app.notifications);

const stopMailRuntimes = (): Promise<void> =>
  stopRuntimeResources([
    stopMailDraftConnections,
    stopDraftDocumentLogPolicy,
    stopDraftDocumentSnapshots,
    stopDraftDocumentPruning,
    stopConversationViewCountCache,
    () => stopConversationSummaryRuntime(),
    () => mailRuntime.stop(),
    applicationAiRuntime.stop,
    () => commandRuntime.stop(),
    () => mailNotifications.stop(),
    stopDraftDocumentCancellation,
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
        await buildRuntimeHistoryIndexes();
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
        await requireIdentityAccessEvents();
        await retireMailRuleBroker();
        await finishReplyDraftRetirements();
        await draftDocumentSnapshots.start();
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
// After startup: the platform has provisioned every resource declared so far,
// so a draft log it cannot prepare leaves only shared drafts unsupported.
startDraftDocumentLogPolicy(async (signal) => {
  const log = logger("mail:startup");
  try {
    await retryPendingDraftSendCloses(signal);
    await draftDocumentSnapshots.reconcile({ signal });
  } catch (error) {
    if (!signal.aborted) log.error("Shared draft startup recovery failed; retained input awaits reconciliation", { error });
  }
  try {
    await migrateSharedDrafts(signal);
  } catch (error) {
    if (!signal.aborted) log.error("Shared draft default migration failed; progress retained for the next start", { error });
  }
});
export default { ...result, websocket };

export type { ApiType } from "./api";
export * from "./contracts";
export { mailService as service } from "./service";
