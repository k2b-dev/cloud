import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { redis } from "@k2b/cloud";
import * as settings from "@k2b/cloud/services/settings";
import { useUnitClients } from "../../../scripts/fixtures/unit-clients";
import { checkPublicRate, PUBLIC_HOST_BUDGET_FACTOR } from "./public-protections";

useUnitClients();

beforeEach(() => {
  spyOn(Date, "now").mockReturnValue(1_793_404_800_000);
});
afterEach(() => mock.restore());

test("public limiter isolates host+IP and host budgets in a dedicated namespace", async () => {
  spyOn(settings, "get").mockResolvedValue(60);
  const send = spyOn(redis, "send").mockResolvedValue([1, 0, "1"]);
  expect(await checkPublicRate("first.test", "203.0.113.1")).toBeNull();
  expect(await checkPublicRate("second.test", "203.0.113.1")).toBeNull();
  expect(await checkPublicRate("first.test", "203.0.113.2")).toBeNull();
  const argumentsFor = (position: number) => send.mock.calls[position]?.[1];
  expect(argumentsFor(1)?.[2]).toContain("cloud:public-domains:host:first.test:");
  expect(argumentsFor(1)?.[5]).toBe(String(60 * PUBLIC_HOST_BUDGET_FACTOR));
  expect(argumentsFor(0)?.[2]).toContain("cloud:public-domains:client:first.test:ip:203.0.113.1:");
  expect(argumentsFor(0)?.[5]).toBe("60");
  expect(argumentsFor(2)?.[2]).toContain("cloud:public-domains:client:second.test:ip:203.0.113.1:");
  expect(argumentsFor(4)?.[2]).toContain("cloud:public-domains:client:first.test:ip:203.0.113.2:");
});

test("exhausted aggregate host budget rejects an otherwise admitted client", async () => {
  spyOn(settings, "get").mockResolvedValue(61);
  const send = spyOn(redis, "send").mockResolvedValueOnce([1, 0, "1"]).mockResolvedValueOnce([6101, 0, "6101"]);
  const response = await checkPublicRate("site.test", "203.0.113.1");
  expect(response?.status).toBe(429);
  expect(response?.headers.get("Retry-After")).toBe("1");
  expect(send).toHaveBeenCalledTimes(2);
});

test("exhausted client budget rejects with Retry-After", async () => {
  spyOn(settings, "get").mockResolvedValue(62);
  const send = spyOn(redis, "send").mockResolvedValue([63, 0, "63"]);
  const response = await checkPublicRate("site.test", "203.0.113.1");
  expect(response?.status).toBe(429);
  expect(send).toHaveBeenCalledTimes(1);
  expect(response?.headers.get("Retry-After")).toBe("1");
});

test("IPv6 addresses within a /64 share the per-client admission budget", async () => {
  spyOn(settings, "get").mockResolvedValue(64);
  const send = spyOn(redis, "send").mockResolvedValue([1, 0, "1"]);
  await checkPublicRate("site.test", "2001:db8:1:2::1");
  await checkPublicRate("site.test", "2001:db8:1:2::ffff");
  expect(send.mock.calls[0]?.[1]?.[2]).toContain("client:site.test:ip6:2001:db8:1:2::/64:");
  expect(send.mock.calls[2]?.[1]?.[2]).toBe(send.mock.calls[0]?.[1]?.[2]);
});
