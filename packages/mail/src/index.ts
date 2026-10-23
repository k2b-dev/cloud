import { stopRuntimeResources } from "@k2b/cloud/services";
import { websocket } from "hono/bun";
import apiRoutes from "./api";
import { stopMailDraftConnections } from "./api/draft-document-socket";
import { mailCapabilities } from "./capabilities";
import { app } from "./config";
import { mailHelp } from "./help";
import { buildCommandTargetIndex, buildOptionalSearchIndex, migrate } from "./migrate";
import { createMailNotificationService } from "./notifications";
import { router } from "./router";
import { commandRuntime, mailRuntime, workflowRuntime } from "./service";

const mailNotifications = createMailNotificationService(app.notifications);

const stopMailRuntimes = (): Promise<void> =>
  stopRuntimeResources([
    stopMailDraftConnections,
    () => mailRuntime.stop(),
    () => workflowRuntime.stop(),
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
      // Lookups use the older index until the command index is valid; search ranks natively until
      // the optional BM25 index is valid. Startup waits for neither build. While another build of the
      // command index runs, the BM25 build waits for the next start: two builds at once can deadlock.
      void buildCommandTargetIndex().then((outcome) => (outcome === "busy" ? undefined : buildOptionalSearchIndex()));
    },
    start: async () => {
      try {
        await mailNotifications.start();
        await mailRuntime.start();
        await commandRuntime.start();
        await workflowRuntime.start();
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
