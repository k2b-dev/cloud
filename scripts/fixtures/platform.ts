/** Select the final test target before importing application data code. */
import { closePlatformClients } from "../../packages/cloud/src/runtime/clients";
import { bindConnections, connections, hasConnections } from "../../packages/cloud/src/runtime/connections";

export const initializeTestPlatform = async (appId = hasConnections() ? connections().appId : "integration-test"): Promise<void> => {
  await closePlatformClients();
  bindConnections(undefined);
  const { initializePlatform } = await import("../../packages/cloud/src/start");
  await initializePlatform({ appId, source: "env" });
};
