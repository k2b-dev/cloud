import { describe, expect, test } from "bun:test";
import { DOWNLOAD_BYTES, UPLOAD_BYTES } from "./engine";
import { createSpeedtestHandler } from "./server";
import { createUdpHandler, UDP_CHALLENGE, UDP_HELLO, UDP_PACKET_BYTES, UDP_PROBE, UDP_REPLY } from "./udp";

const request = (path: string, init?: RequestInit) => new Request(`https://speedtest.example.com${path}`, init);
const handler = () => createSpeedtestHandler({ maxActive: 128, maxPeers: 4_096, now: () => 0, script: "// shared engine bundle" });
async function start(run: ReturnType<typeof handler>, ip = "192.0.2.1") {
  const response = await run(request("/session", { method: "POST" }), ip);
  expect(response.status).toBe(201);
  const result = await response.json();
  return { "x-speedtest-token": String(result.token) };
}
describe("standalone HTTP server", () => {
  test("public ping is uncacheable and CORS exposes retry without credentials", async () => {
    const response = await handler()(request("/ping"), "192.0.2.1");
    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
    expect(response.headers.get("access-control-expose-headers")).toBe("Retry-After");
    expect(response.headers.get("access-control-allow-headers")).toContain("X-Speedtest-Token");
  });
  test("raw transfer routes require admission and tickets cannot move to another IP", async () => {
    const run = handler();
    expect((await run(request("/download"), "192.0.2.1")).status).toBe(401);
    expect((await run(request("/upload", { method: "POST", body: "x" }), "192.0.2.1")).status).toBe(401);
    const headers = await start(run);
    expect((await run(request("/download", { headers }), "192.0.2.2")).status).toBe(401);
    await run(request("/session/end", { method: "POST", headers }), "192.0.2.1");
    expect((await run(request("/download", { headers }), "192.0.2.1")).status).toBe(401);
  });
  test("fixed download sizes, strict validation and bounded chunks", async () => {
    const run = handler();
    const headers = await start(run);
    for (const size of ["0", "-1", "abc", "10.5", String(DOWNLOAD_BYTES + 1)])
      expect((await run(request(`/download?size=${size}`, { headers }), "192.0.2.1")).status).toBe(400);
    const response = await run(request("/download?size=100000", { headers }), "192.0.2.1");
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
    const headers = await start(run);
    expect(
      (await run(request("/upload", { method: "POST", headers: { ...headers, "content-length": String(UPLOAD_BYTES + 1) } }), "192.0.2.1"))
        .status,
    ).toBe(413);
    const response = await run(request("/upload", { method: "POST", headers, body: new Uint8Array(100_000) }), "192.0.2.1");
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
    expect((await run(request("/upload", { method: "POST", headers, body }), "192.0.2.1")).status).toBe(413);
    expect(cancelled).toBe(true);
  });
  test("hundreds of chunks share one test, ended tests still count and proxy spoofing cannot reset the limit", async () => {
    const run = handler();
    for (let testIndex = 0; testIndex < 2; testIndex++) {
      const headers = await start(run);
      for (let index = 0; index < 320; index++) {
        const response = await run(
          request("/download?size=1", { headers: { ...headers, "x-real-ip": `198.51.100.${index % 255}` } }),
          "192.0.2.1",
        );
        expect(response.status).toBe(200);
        await response.arrayBuffer();
      }
      await run(request("/session/end", { method: "POST", headers }), "192.0.2.1");
    }
    const response = await run(request("/session", { method: "POST" }), "192.0.2.1");
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
  });
  test("trusts client headers only from exact configured proxy addresses", async () => {
    const run = createSpeedtestHandler({ maxActive: 10, maxPeers: 4, trustedProxies: ["127.0.0.1"], now: () => 0 });
    const headers = await start(run, "192.0.2.1");
    expect((await run(request("/ping", { headers: { ...headers, "x-real-ip": "192.0.2.1" } }), "::ffff:127.0.0.1")).status).toBe(204);
    expect((await run(request("/ping", { headers: { ...headers, "x-real-ip": "192.0.2.1" } }), "198.51.100.1")).status).toBe(401);
  });
  test("stream cancellation releases slots; session end stops remaining streams", async () => {
    const run = handler();
    const headers = await start(run);
    const responses: Response[] = [];
    try {
      for (let index = 0; index < 10; index++) responses.push(await run(request("/download", { headers }), "192.0.2.1"));
      expect(responses.every((response) => response.status === 200)).toBe(true);
      expect((await run(request("/download", { headers }), "192.0.2.1")).status).toBe(429);
      await responses[0]!.body!.cancel();
      const replacement = await run(request("/download", { headers }), "192.0.2.1");
      expect(replacement.status).toBe(200);
      responses.push(replacement);
      await run(request("/session/end", { method: "POST", headers }), "192.0.2.1");
      await expect(responses[1]!.arrayBuffer()).rejects.toThrow();
    } finally {
      await Promise.all(responses.map((response) => response.body?.cancel().catch(() => {})));
    }
  });
  test("global bandwidth exhaustion fails visibly and never returns a completed truncated download", async () => {
    const run = createSpeedtestHandler({ maxActive: 10, maxPeers: 4, capacityMbps: 1, testMbps: 1, now: () => 0 });
    const headers = await start(run);
    const response = await run(request("/download?size=200000", { headers }), "192.0.2.1");
    await expect(response.arrayBuffer()).rejects.toThrow();
    expect(await (await run(request("/session", { headers }), "192.0.2.1")).json()).toEqual({ limited: true });
    expect((await run(request("/upload", { method: "POST", headers }), "192.0.2.1")).status).toBe(503);
  });
  test("scripts are build artifacts and unknown paths never start a transfer", async () => {
    expect((await handler()(request("/cli"), "192.0.2.1")).headers.get("content-type")).toContain("text/javascript");
    expect((await handler()(request("/unknown"), "192.0.2.1")).status).toBe(404);
  });
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
