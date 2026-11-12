import { spyOn } from "bun:test";
import * as appIdentity from "./app-identity";
import type { PlatformConnections, PlatformConnectionValues } from "./connections";
import * as state from "./connections";

/** No clients or infrastructure: unit tests stub the same snapshot services read. */
export const connectionFixture = (values: Partial<PlatformConnectionValues> = {}): PlatformConnections => ({
  appId: "test-app",
  database: { url: "postgres://127.0.0.1:1/unused_test" },
  valkey: { url: "redis://127.0.0.1:1" },
  nats: { servers: [], namespace: "test-unit", replicas: 1, ignoreClusterUpdates: true },
  appSecret: { current: "test-only-platform-secret" },
  ...values,
  sources: {
    database: { url: "env" },
    valkey: { url: "env" },
    nats: { servers: "env", namespace: "env", replicas: "env", ignoreClusterUpdates: "env" },
    appSecret: { current: "env" },
  },
});
export const stubConnections = (values: Partial<PlatformConnectionValues> = {}) =>
  spyOn(state, "connections").mockReturnValue(connectionFixture(values));

/** Startup lifecycle tests exercise infrastructure independently from enrolled identity. */
export const stubAppIdentity = () =>
  spyOn(appIdentity, "requireAppKey").mockImplementation((appId) => ({
    appId,
    installationId: "11111111-1111-4111-8111-111111111111",
    keyId: "22222222-2222-4222-8222-222222222222",
    seed: "nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A",
  }));
