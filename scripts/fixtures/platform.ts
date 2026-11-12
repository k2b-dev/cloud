/** Select the final test target before importing application data code. */
import { closePlatformClients } from "../../packages/cloud/src/runtime/clients";
import { bindConnections, connections, hasConnections } from "../../packages/cloud/src/runtime/connections";

export const initializeTestPlatform = async (appId = hasConnections() ? connections().appId : "integration-test"): Promise<void> => {
  await closePlatformClients();
  bindConnections(undefined);
  const { initializePlatform } = await import("../../packages/cloud/src/start");
  // Data-only initialization is independent of a fixture's signed HTTP identity.
  const key = process.env.CLOUD_APP_KEY;
  const keyFile = process.env.CLOUD_APP_KEY_FILE;
  delete process.env.CLOUD_APP_KEY;
  delete process.env.CLOUD_APP_KEY_FILE;
  try {
    await initializePlatform({ appId, source: "env" });
  } finally {
    if (key !== undefined) process.env.CLOUD_APP_KEY = key;
    if (keyFile !== undefined) process.env.CLOUD_APP_KEY_FILE = keyFile;
  }
};

export { connectNats } from "../../packages/cloud/src/_internal/nats-connection";
export { getProcessNats } from "../../packages/cloud/src/_internal/process-sync";
export { stubConnections } from "../../packages/cloud/src/runtime/connections.test-fixture";
