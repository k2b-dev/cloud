import { afterEach, expect, mock, spyOn, test } from "bun:test";
import * as settings from "@k2b/cloud/services/settings";
import { redis } from "bun";
import { checkPublicRate, PUBLIC_HOST_BUDGET_FACTOR } from "./public-protections";

afterEach(() => mock.restore());

test("public limiter isolates host+IP and host budgets in a dedicated namespace", async () => {
  spyOn(settings, "get").mockResolvedValue(60);
  const send = spyOn(redis, "send").mockResolvedValue([1, 0, "1"]);
  expect(await checkPublicRate("first.test", "203.0.113.1")).toBeNull();
  expect(await checkPublicRate("second.test", "203.0.113.1")).toBeNull();
  expect(await checkPublicRate("first.test", "203.0.113.2")).toBeNull();
  const argumentsFor = (position: number) => send.mock.calls[position]?.[1];
  expect(argumentsFor(0)?.[2]).toContain("cloud:public-domains:host:first.test:");
  expect(argumentsFor(0)?.[5]).toBe(String(60 * PUBLIC_HOST_BUDGET_FACTOR));
  expect(argumentsFor(1)?.[2]).toContain("cloud:public-domains:client:first.test:203.0.113.1:");
  expect(argumentsFor(1)?.[5]).toBe("60");
  expect(argumentsFor(3)?.[2]).toContain("cloud:public-domains:client:second.test:203.0.113.1:");
  expect(argumentsFor(5)?.[2]).toContain("cloud:public-domains:client:first.test:203.0.113.2:");
});

test("exhausted aggregate host budget rejects before the client budget", async () => {
  spyOn(settings, "get").mockResolvedValue(61);
  const send = spyOn(redis, "send").mockResolvedValue([6101, 0, "6101"]);
  const response = await checkPublicRate("site.test", "203.0.113.1");
  expect(response?.status).toBe(429);
  expect(response?.headers.get("Retry-After")).toBe("1");
  expect(send).toHaveBeenCalledTimes(1);
});

test("exhausted client budget rejects with Retry-After", async () => {
  spyOn(settings, "get").mockResolvedValue(62);
  spyOn(redis, "send").mockResolvedValueOnce([1, 0, "1"]).mockResolvedValueOnce([63, 0, "63"]);
  const response = await checkPublicRate("site.test", "203.0.113.1");
  expect(response?.status).toBe(429);
  expect(response?.headers.get("Retry-After")).toBe("1");
});
