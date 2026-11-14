import { websocket } from "hono/bun";
import { assistantCapabilities } from "./capabilities";
import { agentHost } from "./chat-code/agent-host";
import { httpService } from "./chat-code/http-service";
import { app } from "./config";
import { assistantHelp } from "./help";
import { migrateAssistant } from "./migrate";
import { apiRoutes, router } from "./router";

let hostTimer: ReturnType<typeof setInterval> | undefined;
let hostSweep: Promise<unknown> | undefined;
let databaseTimer: ReturnType<typeof setInterval> | undefined;
let databaseCleanup: Promise<unknown> | undefined;
const sweep = () =>
  (databaseCleanup ??= httpService
    .cleanup()
    .catch(() => console.warn("Assistant storage cleanup deferred"))
    .finally(() => {
      databaseCleanup = undefined;
    }));

const result = await app.start({
  fetch: router.fetch,
  help: assistantHelp,
  capabilities: assistantCapabilities,
  openapi: apiRoutes,
  lifecycle: {
    setup: migrateAssistant,
    start: async () => {
      hostTimer = setInterval(() => {
        hostSweep ??= agentHost
          .sweep()
          .catch(() => console.warn("Code host cleanup deferred"))
          .finally(() => {
            hostSweep = undefined;
          });
      }, 1000);
      hostTimer.unref();
      await sweep();
      databaseTimer = setInterval(() => void sweep(), 30000);
      databaseTimer.unref();
    },
    stop: async () => {
      clearInterval(hostTimer);
      await hostSweep;
      await agentHost.close();
      clearInterval(databaseTimer);
      await databaseCleanup;
    },
  },
});
export default { ...result, websocket };

export type { ApiType } from "./api";
