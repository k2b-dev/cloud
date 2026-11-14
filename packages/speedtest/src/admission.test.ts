import { expect, test } from "bun:test";
import { TestAdmission } from "./admission";

test("rolling minute never allows a boundary burst and reports the oldest start's expiry", () => {
  let now = 0;
  const budget = new TestAdmission({ maxPeers: 4, maxActive: 20, capacityMbps: 2_000, testMbps: 1_000, now: () => now });
  const first = budget.start("192.0.2.1", "quick");
  expect("token" in first).toBe(true);
  if ("token" in first) budget.end("192.0.2.1", first.token);
  now = 30_000;
  const second = budget.start("192.0.2.1", "quick");
  if ("token" in second) budget.end("192.0.2.1", second.token);
  now = 59_999;
  expect(budget.start("192.0.2.1", "quick")).toEqual({ status: 429, retryAfter: 1 });
  now = 60_000;
  expect(budget.start("192.0.2.1", "quick")).toHaveProperty("token");
  expect(budget.start("192.0.2.1", "quick")).toEqual({ status: 429, retryAfter: 30 });
});
test("IPv6 /64 and mapped IPv4 aliases share starts, unrelated networks do not", () => {
  const budget = new TestAdmission({ maxPeers: 8, maxActive: 80, capacityMbps: 8_000, testMbps: 1_000, now: () => 0 });
  for (const ip of ["2001:db8:1234:5678::1", "2001:db8:1234:5678::ffff"]) expect(budget.start(ip, "quick")).toHaveProperty("token");
  expect(budget.start("2001:db8:1234:5678:ffff::1", "quick")).toMatchObject({ status: 429 });
  expect(budget.start("2001:db8:1234:5679::1", "quick")).toHaveProperty("token");
  expect(budget.start("192.0.2.1", "quick")).toHaveProperty("token");
  expect(budget.start("::ffff:c000:201", "quick")).toHaveProperty("token");
  expect(budget.start("::ffff:192.0.2.1", "quick")).toMatchObject({ status: 429 });
});
test("capacity derives concurrency, refused admission costs no start, expiry aborts active transfers", () => {
  let now = 0;
  const budget = new TestAdmission({ maxPeers: 4, maxActive: 100, capacityMbps: 1_000, testMbps: 1_000, now: () => now });
  expect(budget.maxTests).toBe(1);
  const first = budget.start("192.0.2.1", "accurate");
  if (!("token" in first)) throw new Error("No admission");
  const lease = budget.acquire("192.0.2.1", first.token);
  if ("status" in lease) throw new Error("No transfer");
  expect(budget.start("192.0.2.2", "quick")).toEqual({ status: 503, retryAfter: 29 });
  now = 29_000;
  expect(budget.start("192.0.2.2", "quick")).toHaveProperty("token");
  expect(lease.signal.aborted).toBe(true);
  expect(budget.acquire("192.0.2.1", first.token)).toMatchObject({ status: 401 });
});
test("ledger stays bounded and recovers after the rolling window", () => {
  let now = 0;
  const budget = new TestAdmission({ maxPeers: 1, maxActive: 20, now: () => now });
  const first = budget.start("192.0.2.1", "quick");
  if ("token" in first) budget.end("192.0.2.1", first.token);
  expect(budget.start("192.0.2.2", "quick")).toMatchObject({ status: 503 });
  now = 60_000;
  expect(budget.start("192.0.2.2", "quick")).toHaveProperty("token");
});
test("IPv6 network starts stay bounded across subnets, cancellations and rolling expiry", () => {
  let now = 0;
  const budget = new TestAdmission({ maxPeers: 64, maxActive: 20, now: () => now });
  // Sixteen /64 connections may each use their two starts in one /48.
  for (let subnet = 0; subnet < 16; subnet++) {
    const ip = `2001:db8:1234:${subnet.toString(16)}::1`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const session = budget.start(ip, "quick");
      expect(session).toHaveProperty("token");
      if ("token" in session) expect(budget.end(ip, session.token)).toBe(true);
    }
  }
  now = 26_000;
  expect(budget.start("2001:db8:1234:ffff::1", "quick")).toEqual({ status: 429, retryAfter: 34 });
  const other = budget.start("2001:db8:abcd::1", "quick");
  expect(other).toHaveProperty("token");
  if ("token" in other) budget.end("2001:db8:abcd::1", other.token);
  const ipv4 = budget.start("192.0.2.1", "quick");
  expect(ipv4).toHaveProperty("token");
  if ("token" in ipv4) budget.end("192.0.2.1", ipv4.token);
  now = 60_000;
  expect(budget.start("2001:db8:1234:ffff::1", "quick")).toHaveProperty("token");
});
test("aggregate byte bucket refills at configured capacity and is shared by tests and directions", () => {
  let now = 0;
  const budget = new TestAdmission({ maxPeers: 4, maxActive: 20, capacityMbps: 2, testMbps: 1, now: () => now });
  const start = budget.start("192.0.2.1", "quick");
  if (!("token" in start)) throw new Error("No admission");
  const first = budget.acquire("192.0.2.1", start.token);
  if ("status" in first) throw new Error("No transfer");
  expect(first.consume(200_000)).toBe(true);
  now = 500;
  expect(first.consume(175_000)).toBe(true);
  const other = budget.start("192.0.2.2", "quick");
  if (!("token" in other)) throw new Error("No admission");
  const second = budget.acquire("192.0.2.2", other.token);
  if ("status" in second) throw new Error("No transfer");
  expect(second.consume(1)).toBe(false);
  expect(budget.status("192.0.2.2", other.token)).toEqual({ limited: true });
});
