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
let databaseTimer: ReturnType<typeof setInterval> | undefined;
let databaseCleanup: Promise<unknown> | undefined;
const sweep = () =>
  (databaseCleanup ??= Promise.all([artifactDatabase.cleanup(), httpService.cleanup(), appChecks.cleanup()])
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
    setup: migrateArtifacts,
    start: async () => {
      rsqlAllowlist();
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
      await Promise.all([agentHost.close(), closeMachineHosts()]);
      clearInterval(databaseTimer);
      await databaseCleanup;
    },
  },
});
export default { ...result, websocket };

export type { ApiType } from "./api";
