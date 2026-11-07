import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import * as settings from "@k2b/cloud/services/settings";
import { DEFAULT_TRUSTED_PROXIES } from "./client-address";
import { loadTrustedProxies } from "./trusted-proxies";

const originalEnv = process.env.GATEWAY_TRUSTED_PROXIES;
beforeEach(() => {
  delete process.env.GATEWAY_TRUSTED_PROXIES;
});
afterEach(() => {
  mock.restore();
  if (originalEnv === undefined) delete process.env.GATEWAY_TRUSTED_PROXIES;
  else process.env.GATEWAY_TRUSTED_PROXIES = originalEnv;
});
test("startup waits for bootstrap and a direct stored-state read", async () => {
  const order: string[] = [];
  spyOn(settings, "loadCache").mockImplementation(async () => {
    order.push("bootstrap");
  });
  spyOn(settings, "read").mockImplementation(async () => {
    order.push("read");
    return { stored: "none", value: DEFAULT_TRUSTED_PROXIES };
  });
  expect((await loadTrustedProxies()).check("127.0.0.1", "ipv4")).toBe(true);
  expect(order).toEqual(["bootstrap", "read"]);
});
test("invalid and unreadable stored values stop startup with the repair command", async () => {
  spyOn(settings, "loadCache").mockResolvedValue();
  const read = spyOn(settings, "read");
  for (const state of [
    { stored: "unreadable" as const, value: DEFAULT_TRUSTED_PROXIES },
    { stored: "readable" as const, value: ["0.0.0.0/0"] },
    { stored: "readable" as const, value: "bad" },
  ]) {
    read.mockResolvedValue(state);
    await expect(loadTrustedProxies()).rejects.toThrow("--replace-unreadable");
  }
});

test("invalid proxy bootstrap cannot broaden trust when no stored row exists", async () => {
  spyOn(settings, "loadCache").mockResolvedValue();
  const read = spyOn(settings, "read").mockResolvedValue({ stored: "none", value: DEFAULT_TRUSTED_PROXIES });
  process.env.GATEWAY_TRUSTED_PROXIES = "0.0.0.0/0";
  await expect(loadTrustedProxies()).rejects.toThrow("Invalid GATEWAY_TRUSTED_PROXIES bootstrap");
  read.mockResolvedValue({ stored: "readable", value: ["127.0.0.1"] });
  expect((await loadTrustedProxies()).check("127.0.0.1", "ipv4")).toBe(true);
});

test("fresh installations wait for Core's settings migration before accepting a proxy list", async () => {
  const load = spyOn(settings, "loadCache")
    .mockRejectedValueOnce(Object.assign(new Error("relation settings.entries does not exist"), { errno: "42P01" }))
    .mockResolvedValue();
  const read = spyOn(settings, "read").mockResolvedValue({ stored: "none", value: DEFAULT_TRUSTED_PROXIES });
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  const proxies = await loadTrustedProxies();
  expect(load).toHaveBeenCalledTimes(2);
  expect(read).toHaveBeenCalledTimes(1);
  expect(proxies.check("127.0.0.1", "ipv4")).toBe(true);
  expect(warning).toHaveBeenCalled();
});
test("a hung database cannot hold gateway startup beyond its cancellation budget", async () => {
  spyOn(settings, "loadCache").mockImplementation(() => new Promise(() => {}));
  const read = spyOn(settings, "read");
  const controller = new AbortController();
  const startup = loadTrustedProxies(controller.signal);
  controller.abort();
  await expect(startup).rejects.toThrow("HTTP remains closed");
  expect(read).not.toHaveBeenCalled();
});

test("startup retries Valkey cleanup before reading the stored proxy list", async () => {
  const load = spyOn(settings, "loadCache")
    .mockRejectedValueOnce(Object.assign(new Error("Max reconnection attempts reached"), { code: "ERR_REDIS_CONNECTION_CLOSED" }))
    .mockResolvedValue();
  const read = spyOn(settings, "read").mockResolvedValue({ stored: "none", value: DEFAULT_TRUSTED_PROXIES });
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  const proxies = await loadTrustedProxies();
  expect(load).toHaveBeenCalledTimes(2);
  expect(read).toHaveBeenCalledTimes(1);
  expect(proxies.check("127.0.0.1", "ipv4")).toBe(true);
  expect(warning).toHaveBeenCalled();
});

test.each([
  { code: "ERR_REDIS_CONNECTION_TIMEOUT", message: "Connection timed out" },
  { code: "ERR_REDIS_SERVER_ERROR", message: "LOADING data" },
  { code: "ERR_REDIS_SERVER_ERROR", message: "-LOADING data" },
])("startup retries temporary Valkey replies: %s", async (failure) => {
  const load = spyOn(settings, "loadCache")
    .mockRejectedValueOnce(Object.assign(new Error(failure.message), { code: failure.code }))
    .mockResolvedValue();
  spyOn(settings, "read").mockResolvedValue({ stored: "none", value: DEFAULT_TRUSTED_PROXIES });
  spyOn(console, "warn").mockImplementation(() => {});
  const signal = new AbortController().signal;
  await loadTrustedProxies(signal);
  expect(load).toHaveBeenCalledTimes(2);
  expect(load).toHaveBeenLastCalledWith(signal);
});

test("permanent Valkey server errors fail without retry", async () => {
  const failure = Object.assign(new Error("WRONGPASS invalid credentials"), { code: "ERR_REDIS_SERVER_ERROR" });
  const load = spyOn(settings, "loadCache").mockRejectedValue(failure);
  await expect(loadTrustedProxies()).rejects.toBe(failure);
  expect(load).toHaveBeenCalledTimes(1);
});
