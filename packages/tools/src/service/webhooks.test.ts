import { afterAll, beforeAll, beforeEach, describe, expect, jest, mock, test } from "bun:test";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import { type SendWebhookInput, sendOutgoingWebhookRequest } from "./webhooks";

const input = (url: string): SendWebhookInput => ({ url, method: "GET", headers: {}, body: "" });

test("preserves protocol and credential error codes", async () => {
  await expect(sendOutgoingWebhookRequest(input("ftp://example.com/"))).rejects.toMatchObject({ code: "UNSUPPORTED_PROTOCOL" });
  await expect(sendOutgoingWebhookRequest(input("https://user:pass@example.com/"))).rejects.toMatchObject({ code: "CREDENTIALS_IN_URL" });
});

test("a failed or empty resolution returns the visible unresolved error", async () => {
  for (const resolve of [
    async () => {
      throw new Error("DNS unavailable");
    },
    async () => [],
  ]) {
    expect(await sendOutgoingWebhookRequest(input("http://missing.test/"), { resolve })).toEqual({
      responseStatus: null,
      responseHeaders: null,
      responseBody: null,
      error: "The host name could not be resolved.",
    });
  }
});

test("mapped loopback literals fail policy before any connection", async () => {
  for (const host of ["[::ffff:127.0.0.1]", "[::ffff:7f00:1]"]) {
    await expect(sendOutgoingWebhookRequest(input(`http://${host}:1/`))).rejects.toMatchObject({ code: "BLOCKED_TARGET" });
  }
});

test("the total deadline also bounds a stalled DNS lookup", async () => {
  jest.useFakeTimers();
  try {
    const pending = sendOutgoingWebhookRequest(input("http://missing.test/"), { resolve: () => new Promise(() => {}) });
    jest.advanceTimersByTime(10_000);
    expect((await pending).error).toBe("The request timed out.");
  } finally {
    jest.useRealTimers();
  }
});

describe("webhook transport with a real local server", () => {
  const paths: string[] = [];
  let receivedHeaders: IncomingHttpHeaders = {};
  let receivedBody = "";
  let port: number;
  const server = createServer(async (request, response) => {
    paths.push(request.url ?? "");
    receivedHeaders = request.headers;
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    receivedBody = Buffer.concat(chunks).toString("utf8");
    if (request.url === "/redirect") {
      response.writeHead(302, { Location: `http://[::ffff:127.0.0.1]:${port}/secret` });
      response.end("redirect body");
    } else if (request.url === "/large") {
      response.end("x".repeat(80_000));
    } else if (["/gzip", "/deflate", "/br", "/gzip-small", "/deflate-small", "/br-small"].includes(request.url ?? "")) {
      const encoding = request.url!.slice(1).replace("-small", "");
      const compress = encoding === "gzip" ? gzipSync : encoding === "deflate" ? deflateSync : brotliCompressSync;
      response.writeHead(200, { "content-encoding": encoding });
      response.end(compress(request.url?.endsWith("-small") ? "\uFEFFhello 🌍" : "é".repeat(40_000)));
    } else if (request.url === "/unknown") {
      response.writeHead(200, { "content-encoding": "unknown" });
      response.end("raw text");
    } else if (request.url === "/empty") {
      response.writeHead(204, { "content-encoding": "gzip" });
      response.end();
    } else {
      response.writeHead(200, { "x-test": ["one", "two"], "set-cookie": "secret=value" });
      response.end("hello 🌍");
    }
  });

  beforeAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing server port");
    port = address.port;
  });
  beforeEach(() => {
    paths.length = 0;
  });
  afterAll(async () => {
    if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });

  const checkedResolve = () => mock(async () => [{ address: "127.0.0.1", family: 4 as const }]);
  const target = (path: string) => input(`http://redirect.test:${port}${path}`);

  test("mapped loopback forms are blocked without sending anything", async () => {
    for (const host of ["[::ffff:127.0.0.1]", "[::ffff:7f00:1]"]) {
      await expect(sendOutgoingWebhookRequest(input(`http://${host}:${port}/`))).rejects.toMatchObject({ code: "BLOCKED_TARGET" });
    }
    expect(paths).toEqual([]);
  });

  test("connects to the checked address once and returns redirects without following them", async () => {
    const resolve = checkedResolve();
    const result = await sendOutgoingWebhookRequest(target("/redirect"), { resolve });
    expect(result.error).toBeNull();
    expect(result.responseStatus).toBe(302);
    expect(result.responseHeaders?.location).toBe(`http://[::ffff:127.0.0.1]:${port}/secret`);
    expect(result.responseBody).toBe("redirect body");
    expect(paths).toEqual(["/redirect"]);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith("redirect.test");
  });

  test("a DNS failure sends nothing", async () => {
    const result = await sendOutgoingWebhookRequest(target("/"), {
      resolve: async () => {
        throw new Error("ENOTFOUND");
      },
    });
    expect(result.error).toBe("The host name could not be resolved.");
    expect(paths).toEqual([]);
  });

  test("caps response bytes and keeps the truncation marker", async () => {
    const result = await sendOutgoingWebhookRequest(target("/large"), { resolve: checkedResolve() });
    expect(result.error).toBeNull();
    expect(result.responseBody).toBe(`${"x".repeat(64_000)}\n\n[truncated]`);
  });

  test.each(["gzip", "deflate", "br"])("caps decoded %s responses", async (encoding) => {
    const result = await sendOutgoingWebhookRequest(target(`/${encoding}`), { resolve: checkedResolve() });
    expect(result.error).toBeNull();
    expect(result.responseBody).toBe(`${"é".repeat(32_000)}\n\n[truncated]`);
  });

  test.each(["gzip", "deflate", "br"])("decodes complete %s responses as UTF-8", async (encoding) => {
    const result = await sendOutgoingWebhookRequest(target(`/${encoding}-small`), { resolve: checkedResolve() });
    expect(result.error).toBeNull();
    expect(result.responseBody).toBe("hello 🌍");
  });

  test("keeps unknown encodings as raw text and bodyless responses as null", async () => {
    const unknown = await sendOutgoingWebhookRequest(target("/unknown"), { resolve: checkedResolve() });
    expect(unknown.error).toBeNull();
    expect(unknown.responseBody).toBe("raw text");
    const empty = await sendOutgoingWebhookRequest(target("/empty"), { resolve: checkedResolve() });
    expect(empty.error).toBeNull();
    expect(empty.responseStatus).toBe(204);
    expect(empty.responseBody).toBeNull();
  });

  test("owns framing and host, preserves person headers, and sanitizes response headers", async () => {
    const result = await sendOutgoingWebhookRequest(
      {
        ...target("/"),
        method: "POST",
        body: "ä",
        headers: { Host: "evil.test", "Content-Length": "999", "Transfer-Encoding": "chunked", Connection: "upgrade", "X-Person": "kept" },
      },
      { resolve: checkedResolve() },
    );
    expect(result.error).toBeNull();
    expect(receivedHeaders.host).toBe(`redirect.test:${port}`);
    expect(receivedHeaders["content-length"]).toBe("2");
    expect(receivedHeaders["transfer-encoding"]).toBeUndefined();
    expect(receivedHeaders.connection).not.toBe("upgrade");
    expect(receivedHeaders["x-person"]).toBe("kept");
    expect(receivedHeaders.accept).toBe("*/*");
    expect(receivedHeaders["user-agent"]).toBe("Cloud-Tools-Webhook-Tester");
    expect(receivedBody).toBe("ä");
    expect(result.responseBody).toBe("hello 🌍");
    expect(result.responseHeaders?.["set-cookie"]).toBe("[redacted]");
    expect(result.responseHeaders?.["x-test"]).toBe("one, two");
  });

  test("GET sends no body and retains explicit accept and user-agent", async () => {
    const result = await sendOutgoingWebhookRequest(
      { ...target("/"), body: "ignored", headers: { Accept: "application/json", "User-Agent": "Person" } },
      { resolve: checkedResolve() },
    );
    expect(result.error).toBeNull();
    expect(receivedBody).toBe("");
    expect(receivedHeaders.accept).toBe("application/json");
    expect(receivedHeaders["user-agent"]).toBe("Person");
  });
});
