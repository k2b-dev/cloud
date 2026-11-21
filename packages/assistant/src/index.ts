import { startRuntimeInterval } from "@k2b/cloud/services";
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
let storageCleanup: ReturnType<typeof startRuntimeInterval> | undefined;

const result = await app.start({
  fetch: router.fetch,
  help: assistantHelp,
  capabilities: assistantCapabilities,
  openapi: apiRoutes,
  lifecycle: {
    setup: migrateAssistant,
    start: async () => {
      // runtime-timer: closes idle and expired code hosts; releasing them is how in-flight work ends, so quiesce keeps it.
      hostTimer = setInterval(() => {
        hostSweep ??= agentHost
          .sweep()
          .catch(() => console.warn("Code host cleanup deferred"))
          .finally(() => {
            hostSweep = undefined;
          });
      }, 1000);
      hostTimer.unref();
      storageCleanup = startRuntimeInterval({
        run: () => httpService.cleanup(),
        intervalMs: 30_000,
        onError: () => console.warn("Assistant storage cleanup deferred"),
      });
    },
    stop: async () => {
      clearInterval(hostTimer);
      await hostSweep;
      await agentHost.close();
      await storageCleanup?.stop();
      storageCleanup = undefined;
    },
  },
});
export default { ...result, websocket };

export type { ApiType } from "./api";
