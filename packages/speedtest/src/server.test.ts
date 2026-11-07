import { describe, expect, test } from "bun:test";
import { IpBudget } from "./budget";
import { DOWNLOAD_BYTES, UPLOAD_BYTES } from "./engine";
import { createSpeedtestHandler } from "./server";
import { createUdpHandler, UDP_CHALLENGE, UDP_HELLO, UDP_PACKET_BYTES, UDP_PROBE, UDP_REPLY } from "./udp";

const request = (path: string, init?: RequestInit) => new Request(`https://speedtest.example.com${path}`, init);
const handler = () => createSpeedtestHandler({ maxActive: 128, maxPeers: 4_096, now: () => 0, script: "// shared engine bundle" });

describe("standalone HTTP server", () => {
  test("public ping is uncacheable and CORS exposes Retry-After without credentials", async () => {
    const response = await handler()(request("/ping"), "192.0.2.1");
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
    expect(response.headers.get("access-control-expose-headers")).toBe("Retry-After");
  });
  test("fixed download sizes, strict validation and bounded chunks", async () => {
    const run = handler();
    for (const size of ["0", "-1", "abc", "10.5", String(DOWNLOAD_BYTES + 1)])
      expect((await run(request(`/download?size=${size}`), "192.0.2.1")).status).toBe(400);
    const response = await run(request("/download?size=100000"), "192.0.2.1");
    expect(response.headers.get("content-length")).toBe("100000");
    const reader = response.body!.getReader();
    let total = 0;
    for (;;) {
      const value = await reader.read();
      if (value.done) break;
      expect(value.value.byteLength).toBeLessThanOrEqual(65_536);
      total += value.value.byteLength;
    }
    expect(total).toBe(100_000);
  });
  test("reads streamed upload and rejects oversized declarations or bodies", async () => {
    const run = handler();
    expect(
      (await run(request("/upload", { method: "POST", headers: { "content-length": String(UPLOAD_BYTES + 1) } }), "192.0.2.1")).status,
    ).toBe(413);
    const response = await run(request("/upload", { method: "POST", body: new Uint8Array(100_000) }), "192.0.2.1");
    expect(await response.json()).toEqual({ bytes: 100_000 });
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(65_536));
      },
      cancel() {
        cancelled = true;
      },
    });
    const large = await run(request("/upload", { method: "POST", body }), "192.0.2.1");
    expect(large.status).toBe(413);
    expect(cancelled).toBe(true);
  });
  test("all transfer paths share one anonymous IP budget; spoofed headers cannot reset it", async () => {
    const run = handler();
    for (let index = 0; index < 300; index++) {
      const response = await run(
        request(index % 2 ? "/upload" : "/download?size=1", {
          method: index % 2 ? "POST" : "GET",
          headers: { "x-real-ip": `192.0.2.${index}` },
        }),
        "198.51.100.1",
      );
      await response.arrayBuffer();
      expect(response.status).toBe(200);
    }
    const response = await run(request("/download?size=1"), "198.51.100.1");
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("600");
    expect((await run(request("/ping"), "198.51.100.1")).status).toBe(204);
    expect((await run(request("/upload", { method: "POST" }), "198.51.100.2")).status).toBe(200);
  });
  test("trusts client headers only from configured exact proxy addresses", async () => {
    const run = createSpeedtestHandler({ maxActive: 1, maxPeers: 1, trustedProxies: ["127.0.0.1"], now: () => 0 });
    expect((await run(request("/ping", { headers: { "x-real-ip": "192.0.2.1" } }), "127.0.0.1")).status).toBe(204);
    expect((await run(request("/ping", { headers: { "x-real-ip": "192.0.2.2" } }), "127.0.0.1")).status).toBe(503);
  });
  test("cancelling a download releases its active slot", async () => {
    const run = createSpeedtestHandler({ maxActive: 1, maxPeers: 4, now: () => 0 });
    const response = await run(request("/download"), "192.0.2.1");
    expect((await run(request("/download"), "192.0.2.2")).status).toBe(503);
    await response.body!.cancel();
    expect((await run(request("/ping"), "192.0.2.2")).status).toBe(204);
  });
  test("scripts are explicit build artifacts and unknown paths never start a transfer", async () => {
    expect((await handler()(request("/cli"), "192.0.2.1")).headers.get("content-type")).toContain("text/javascript");
    expect((await handler()(request("/unknown"), "192.0.2.1")).status).toBe(404);
  });
});

test("budget storage is bounded, live peers are never evicted and expired records recover", () => {
  let now = 0;
  const budget = new IpBudget({ maxPeers: 1, maxActive: 5, now: () => now });
  const live = budget.acquire("192.0.2.1", true);
  expect("release" in live).toBe(true);
  if (!("release" in live)) throw new Error("missing lease");
  now = 600_000;
  expect(budget.acquire("192.0.2.2", true)).toMatchObject({ status: 503 });
  live.release();
  live.release();
  const next = budget.acquire("192.0.2.2", true);
  expect("release" in next).toBe(true);
  if ("release" in next) next.release();
});

describe("UDP address confirmation", () => {
  test("never amplifies or answers invalid, unconfirmed, expired or rebound probes", () => {
    let now = Date.parse("2026-10-15T09:30:00Z");
    const run = createUdpHandler({ maxPeers: 4, now: () => now, secret: new Uint8Array(32).fill(7) });
    for (const size of [0, 1, 63, 65, 1_400]) expect(run(new Uint8Array(size), "192.0.2.1", 5000)).toBeNull();
    const unconfirmed = new Uint8Array(UDP_PACKET_BYTES);
    unconfirmed[0] = UDP_PROBE;
    expect(run(unconfirmed, "192.0.2.1", 5000)).toBeNull();
    const hello = new Uint8Array(UDP_PACKET_BYTES);
    hello[0] = UDP_HELLO;
    const challenge = run(hello, "192.0.2.1", 5000)!;
    expect(challenge[0]).toBe(UDP_CHALLENGE);
    expect(challenge.byteLength).toBe(hello.byteLength);
    const proof = challenge.slice();
    proof[0] = UDP_PROBE;
    expect(run(proof, "192.0.2.2", 5000)).toBeNull();
    expect(run(proof, "192.0.2.1", 5001)).toBeNull();
    const reply = run(proof, "192.0.2.1", 5000)!;
    expect(reply[0]).toBe(UDP_REPLY);
    expect(reply.byteLength).toBe(proof.byteLength);
    const tampered = proof.slice();
    tampered[12]! ^= 1;
    expect(run(tampered, "192.0.2.1", 5000)).toBeNull();
    now += 30_001;
    expect(run(proof, "192.0.2.1", 5000)).toBeNull();
  });
});

test("IPv6 interface rotation and mapped IPv4 aliases keep one transfer budget", () => {
  const budget = new IpBudget({ maxPeers: 4, maxActive: 10, now: () => 0 });
  for (let index = 0; index < 300; index++) {
    const result = budget.acquire(`2001:db8:1234:5678::${index.toString(16)}`, true);
    expect("release" in result).toBe(true);
    if ("release" in result) result.release();
  }
  expect(budget.acquire("2001:db8:1234:5678:ffff:ffff:ffff:ffff", true)).toMatchObject({ status: 429, retryAfter: 600 });
  for (let index = 0; index < 300; index++) {
    const result = budget.acquire(index % 2 ? "::ffff:c000:201" : "192.0.2.1", true);
    if ("release" in result) result.release();
  }
  expect(budget.acquire("::ffff:192.0.2.1", true)).toMatchObject({ status: 429 });
});
test("a full ledger reports its actual recovery interval", () => {
  const budget = new IpBudget({ maxPeers: 1, maxActive: 10, now: () => 0 });
  const first = budget.acquire("192.0.2.1", true);
  if ("release" in first) first.release();
  for (let index = 2; index < 100; index++)
    expect(budget.acquire(`192.0.2.${index}`, true)).toMatchObject({ status: 503, retryAfter: 600 });
});
test("mapped proxy peers match the configured IPv4 proxy", async () => {
  const run = createSpeedtestHandler({ maxActive: 10, maxPeers: 1, trustedProxies: ["127.0.0.1"], now: () => 0 });
  expect((await run(request("/ping", { headers: { "x-real-ip": "192.0.2.1" } }), "::ffff:127.0.0.1")).status).toBe(204);
  expect((await run(request("/ping"), "192.0.2.1")).status).toBe(204);
});
test("adjacent client phases have cancellation headroom on the server", async () => {
  const run = handler();
  const responses: Response[] = [];
  try {
    for (let index = 0; index < 10; index++) {
      const response = await run(request("/download"), "192.0.2.1");
      responses.push(response);
      expect(response.status).toBe(200);
    }
    expect((await run(request("/download"), "192.0.2.1")).status).toBe(429);
  } finally {
    await Promise.all(responses.map((response) => response.body?.cancel()));
  }
});
test("UDP challenges cannot allocate peer records and packet processing has a global ceiling", () => {
  let now = Date.parse("2026-10-15T09:30:00Z");
  const run = createUdpHandler({ maxPeers: 1, now: () => now, maxPacketsPerSecond: 100, secret: new Uint8Array(32).fill(7) });
  const hello = new Uint8Array(UDP_PACKET_BYTES);
  hello[0] = UDP_HELLO;
  for (let index = 0; index < 50; index++) expect(run(hello, `192.0.2.${index}`, 5000)).not.toBeNull();
  const challenge = run(hello, "198.51.100.1", 5000)!;
  challenge[0] = UDP_PROBE;
  expect(run(challenge, "198.51.100.1", 5000)?.[0]).toBe(UDP_REPLY);
  for (let index = 0; index < 100; index++) run(hello, "203.0.113.1", 5000);
  expect(run(hello, "203.0.113.1", 5000)).toBeNull();
  now += 1_000;
  expect(run(hello, "203.0.113.1", 5000)).not.toBeNull();
});
