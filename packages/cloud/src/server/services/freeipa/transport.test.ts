import { afterEach, describe, expect, test } from "bun:test";
import { TEST_CA_CERT, TEST_SERVER_CERT, TEST_SERVER_KEY, TEST_WRONG_CA_CERT } from "./test-certificates.test-fixture";
import { FreeIpaTransportError, isFreeIpaUpstreamStatus, readFreeIpaErrorBody, withFreeIpaResponse } from "./transport";

let server: ReturnType<typeof Bun.serve> | null = null;

const request = (input: string | URL, init: BunFetchRequestInit = {}, options: { signal?: AbortSignal; timeoutMs?: number } = {}) =>
  withFreeIpaResponse(
    input,
    init,
    async (response) => ({
      body: await response.text(),
      ok: response.ok,
    }),
    options,
  );

afterEach(() => {
  server?.stop(true);
  server = null;
});

describe("FreeIPA transport bounds", () => {
  test("times out delayed requests with a typed failure", async () => {
    server = Bun.serve({
      port: 0,
      fetch: async () => {
        await Bun.sleep(100);
        return new Response("late");
      },
    });

    await expect(request(server.url, {}, { timeoutMs: 10 })).rejects.toMatchObject({
      name: "FreeIpaTransportError",
      kind: "timeout",
    });
  });

  test("keeps the timeout active while the response body is consumed", async () => {
    server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          new ReadableStream({
            async start(controller) {
              controller.enqueue(new TextEncoder().encode("partial"));
              await Bun.sleep(100);
              controller.close();
            },
          }),
        ),
    });

    await expect(withFreeIpaResponse(server.url, {}, (response) => response.text(), { timeoutMs: 10 })).rejects.toMatchObject({
      name: "FreeIpaTransportError",
      kind: "timeout",
    });
  });

  test("propagates caller cancellation as a typed failure", async () => {
    server = Bun.serve({
      port: 0,
      fetch: async () => {
        await Bun.sleep(100);
        return new Response("late");
      },
    });
    const controller = new AbortController();
    const pending = request(server.url, {}, { signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toMatchObject({
      name: "FreeIpaTransportError",
      kind: "aborted",
    });
  });

  test("bounds error response reads", async () => {
    const result = await readFreeIpaErrorBody(new Response("x".repeat(100)), 16);
    expect(result).toEqual({ text: "x".repeat(16), truncated: true });
  });

  test("classifies only retryable HTTP failures as upstream availability errors", () => {
    expect([408, 429, 500, 503].every(isFreeIpaUpstreamStatus)).toBe(true);
    expect([400, 401, 403, 404].some(isFreeIpaUpstreamStatus)).toBe(false);
  });

  test("does not expose the low-level network error", async () => {
    try {
      // The refused loopback connect must win; a 100 ms deadline could fire first on a stalled event loop.
      await request("http://127.0.0.1:1", {}, { timeoutMs: 5_000 });
      throw new Error("expected request to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(FreeIpaTransportError);
      expect((error as Error).message).toBe("Could not connect to FreeIPA");
    }
  });
});

describe("FreeIPA TLS policy", () => {
  const startTlsServer = () => {
    server = Bun.serve({
      port: 0,
      tls: { cert: TEST_SERVER_CERT, key: TEST_SERVER_KEY },
      fetch: () => new Response("ok"),
    });
    return server;
  };

  test("trusts the configured private CA and verifies the hostname", async () => {
    const tlsServer = startTlsServer();
    const response = await request(tlsServer.url, { tls: { ca: TEST_CA_CERT, rejectUnauthorized: true } });
    expect(response.body).toBe("ok");
  });

  test("rejects system trust, a wrong CA, and hostname mismatch", async () => {
    const tlsServer = startTlsServer();
    const wrongHost = new URL(tlsServer.url);
    wrongHost.hostname = "127.0.0.1";

    await expect(request(tlsServer.url, { tls: { rejectUnauthorized: true } })).rejects.toMatchObject({ kind: "tls" });
    await expect(request(tlsServer.url, { tls: { ca: TEST_WRONG_CA_CERT, rejectUnauthorized: true } })).rejects.toMatchObject({
      kind: "tls",
    });
    await expect(request(wrongHost, { tls: { ca: TEST_CA_CERT, rejectUnauthorized: true } })).rejects.toMatchObject({ kind: "tls" });
  });

  test("allows the explicit insecure mode", async () => {
    const tlsServer = startTlsServer();
    const response = await request(tlsServer.url, { tls: { rejectUnauthorized: false } });
    expect(response.ok).toBe(true);
  });

  test("explicit verification wins over NODE_TLS_REJECT_UNAUTHORIZED=0", async () => {
    const tlsServer = startTlsServer();
    const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    try {
      await expect(request(tlsServer.url, { tls: { ca: TEST_WRONG_CA_CERT, rejectUnauthorized: true } })).rejects.toMatchObject({
        kind: "tls",
      });
    } finally {
      if (previous === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous;
    }
  });
});
