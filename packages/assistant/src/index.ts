import { startRuntimeInterval } from "@k2b/cloud/services";
import { websocket } from "hono/bun";
import { agentHost } from "./artifacts/agent-host";
import { artifactDatabase, rsqlAllowlist } from "./artifacts/database";
import { appChecks } from "./artifacts/html/check-service";
import { httpService } from "./artifacts/http-service";
import { closeMachineHosts } from "./artifacts/machine-execution";
import { migrateArtifacts } from "./artifacts/migrate";
import { assistantCapabilities } from "./capabilities";
import { app } from "./config";
import { assistantHelp } from "./help";
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
    setup: migrateArtifacts,
    start: async () => {
      await rsqlAllowlist();
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
        run: async () => {
          await Promise.all([artifactDatabase.cleanup(), httpService.cleanup(), appChecks.cleanup()]);
        },
        intervalMs: 30_000,
        onError: () => console.warn("Assistant storage cleanup deferred"),
      });
    },
    stop: async () => {
      clearInterval(hostTimer);
      await hostSweep;
      await Promise.all([agentHost.close(), closeMachineHosts()]);
      await storageCleanup?.stop();
      storageCleanup = undefined;
    },
  },
});
export default { ...result, websocket };

export type { ApiType } from "./api";
