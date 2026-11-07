import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { RedisClient } from "bun";
import { closePlatformClients, initializeClients, redis } from "../../runtime/clients";
import { bindConnections, connections, hasConnections } from "../../runtime/connections";
import { stubConnections } from "../../runtime/connections.test-fixture";
import * as cache from "../request-cache-redis";
import { registerSettings } from "./defaults";
import { readEnvSettingsStatus } from "./env-status";
import { loadCache } from "./index";
import { bulkRead, listLegacyKeys, readStates } from "./store";

const previous = hasConnections() ? connections() : undefined;
afterEach(async () => {
  mock.restore();
  await closePlatformClients();
  bindConnections(previous);
});

test("settings propagate missing startup before cache or decryption fallbacks", async () => {
  bindConnections(undefined);
  await expect(bulkRead(["app.url"])).rejects.toThrow("connections() used before platform start");
  await expect(readStates(["app.url"])).rejects.toThrow("connections() used before platform start");
  await expect(listLegacyKeys()).rejects.toThrow("connections() used before platform start");
});

test("bound settings and environment status propagate missing startup", async () => {
  const owner = "test.startup_servers";
  const access = "test.startup_access";
  registerSettings([
    {
      key: owner,
      kind: "string_list",
      default: [],
      group: "test",
      description: "Startup binding probe",
      resetOnChange: [access],
      envBootstrap: () => [],
    },
    { key: access, kind: "secret", default: "", group: "test", description: "Startup binding access probe" },
  ]);
  bindConnections(undefined);
  await expect(bulkRead([access])).rejects.toThrow("connections() used before platform start");
  await expect(readStates([access])).rejects.toThrow("connections() used before platform start");
  await expect(readEnvSettingsStatus()).rejects.toThrow("connections() used before platform start");
});

test("settings startup uses its dedicated cache client rather than the shared platform client", async () => {
  const platformUrl = "redis://127.0.0.1:2";
  stubConnections({ valkey: { url: platformUrl } });
  await initializeClients();
  const client = new RedisClient(platformUrl, { autoReconnect: false });
  const request = spyOn(cache, "requestCacheRedis").mockResolvedValue(client);
  const connect = spyOn(client, "connect").mockRejectedValue(new Error("Valkey connection unavailable"));
  const globalConnect = spyOn(redis, "connect").mockRejectedValue(new Error("Wrong client"));
  const scan = spyOn(client, "scan");
  try {
    await expect(loadCache()).rejects.toThrow("Valkey connection unavailable");
    expect(request).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(globalConnect).not.toHaveBeenCalled();
    expect(scan).not.toHaveBeenCalled();
  } finally {
    client.close();
  }
});

test.each([
  { code: "ERR_REDIS_CONNECTION_CLOSED", message: "Connection closed" },
  { code: "ERR_REDIS_CONNECTION_TIMEOUT", message: "Connection timed out" },
  { code: "ERR_REDIS_SERVER_ERROR", message: "LOADING data" },
])("settings startup retries temporary Valkey errors: %s", async (failure) => {
  stubConnections();
  const terminal = new Error("Permanent configuration error");
  const request = spyOn(cache, "requestCacheRedis")
    .mockRejectedValueOnce(Object.assign(new Error(failure.message), { code: failure.code }))
    .mockRejectedValue(terminal);
  spyOn(console, "warn").mockImplementation(() => {});
  await expect(loadCache()).rejects.toBe(terminal);
  expect(request).toHaveBeenCalledTimes(2);
});

test("cancellation stops settings recovery after its first failed attempt", async () => {
  stubConnections();
  const request = spyOn(cache, "requestCacheRedis").mockRejectedValue(
    Object.assign(new Error("Connection closed"), { code: "ERR_REDIS_CONNECTION_CLOSED" }),
  );
  const controller = new AbortController();
  const startup = loadCache(controller.signal);
  controller.abort();
  await expect(startup).rejects.toThrow("did not recover within the settings startup allowance");
  expect(request).toHaveBeenCalledTimes(1);
});

test("a failed cleanup never publishes its format marker", async () => {
  const platformUrl = "redis://127.0.0.1:2";
  stubConnections({ valkey: { url: platformUrl } });
  await initializeClients();
  const client = new RedisClient(platformUrl, { autoReconnect: false });
  spyOn(cache, "requestCacheRedis").mockResolvedValue(client);
  spyOn(client, "connect").mockResolvedValue();
  spyOn(client, "get").mockResolvedValue(null);
  const scan = spyOn(client, "scan").mockRejectedValue(new Error("Cleanup unavailable"));
  const globalScan = spyOn(redis, "scan").mockRejectedValue(new Error("Wrong cache connection"));
  const mark = spyOn(client, "set");
  try {
    await expect(loadCache(AbortSignal.abort())).rejects.toThrow("Cleanup unavailable");
    expect(scan).toHaveBeenCalledTimes(1);
    expect(globalScan).not.toHaveBeenCalled();
    expect(mark).not.toHaveBeenCalled();
  } finally {
    client.close();
  }
});
