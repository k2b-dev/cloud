import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import { PassThrough } from "node:stream";
import { isUnsafeWorkflowHttpAddress, preflightWorkflowHttp, requestWorkflowHttp } from "./workflow-http-client";

const publicAddress = "93.184.216.34";

const responseRequest =
  (
    body: string | Buffer | Buffer[],
    inspect?: (options: RequestOptions) => void,
  ): ((options: RequestOptions, callback: (response: IncomingMessage) => void) => ClientRequest) =>
  (options, callback) => {
    inspect?.(options);
    const request = new EventEmitter() as ClientRequest;
    request.destroy = (() => request) as ClientRequest["destroy"];
    request.end = (() => {
      queueMicrotask(() => {
        const stream = new PassThrough();
        const response = stream as unknown as IncomingMessage;
        response.statusCode = 200;
        response.headers = {};
        callback(response);
        for (const chunk of Array.isArray(body) ? body : [body]) stream.write(chunk);
        stream.end();
      });
      return request;
    }) as ClientRequest["end"];
    return request;
  };

describe("workflow HTTP client", () => {
  test("preflights policy, DNS, headers, and body without opening a socket", async () => {
    let requested = false;
    const result = await preflightWorkflowHttp(
      { url: "https://api.example.com/hooks", method: "POST", body: '{"ok":true}' },
      {
        lookup: async () => [{ address: publicAddress, family: 4 }],
        request: responseRequest("unexpected", () => {
          requested = true;
        }),
      },
    );

    expect(result).toEqual({ ok: true, data: { host: "api.example.com" } });
    expect(requested).toBe(false);
  });

  test("reports an unresolved dry-run target without sending a request", async () => {
    const result = await preflightWorkflowHttp({ url: "https://missing.example.test/hooks", method: "POST" }, { lookup: async () => [] });

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error.message).toBe("HTTP request target could not be resolved");
  });

  test("forwards the runtime idempotency key instead of a workflow-supplied value", async () => {
    let headers: RequestOptions["headers"];
    const result = await requestWorkflowHttp(
      {
        url: "https://api.example.com/hooks",
        method: "POST",
        headers: { "Idempotency-Key": "workflow-value" },
        idempotencyKey: "workflow:run:step",
      },
      {
        lookup: async () => [{ address: publicAddress, family: 4 }],
        request: responseRequest("ok", (options) => {
          headers = options.headers;
        }),
      },
    );

    expect(result.ok).toBe(true);
    expect(headers).toMatchObject({ "idempotency-key": "workflow:run:step" });
  });

  test("pins the validated DNS address for the socket lookup", async () => {
    let pinnedAddress: string | null = null;
    let pinnedServername: string | undefined;
    let dnsLookups = 0;
    const result = await requestWorkflowHttp(
      { url: "https://api.example.com/hooks", method: "POST", body: '{"ok":true}' },
      {
        lookup: async () => {
          dnsLookups += 1;
          return [{ address: publicAddress, family: 4 }];
        },
        request: responseRequest("ok", (options) => {
          pinnedServername = (options as RequestOptions & { servername?: string }).servername;
          const pinnedLookup = options.lookup as unknown as (
            hostname: string,
            options: unknown,
            callback: (error: Error | null, address: string, family: number) => void,
          ) => void;
          pinnedLookup("api.example.com", {}, (_error, address) => {
            pinnedAddress = address;
          });
        }),
      },
    );

    expect(result.ok).toBe(true);
    expect(dnsLookups).toBe(1);
    expect(String(pinnedAddress)).toBe(publicAddress);
    // The socket dials the pinned address, but TLS still verifies against the
    // hostname the workflow wrote — pinning must not weaken certificate checks.
    expect(pinnedServername).toBe("api.example.com");
  });

  test("rejects private and reserved DNS results before opening a socket", async () => {
    let requested = false;
    const result = await requestWorkflowHttp(
      { url: "http://service.example.test", method: "GET" },
      {
        lookup: async () => [{ address: "127.0.0.1", family: 4 }],
        request: responseRequest("hidden", () => {
          requested = true;
        }),
      },
    );

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error.message).toBe("HTTP request target is not a public address");
    expect(requested).toBe(false);
  });

  test("refuses a hostname that names the private side, whatever it resolves to", async () => {
    let looked = false;
    const result = await requestWorkflowHttp(
      { url: "http://inventory.internal/api", method: "GET" },
      {
        lookup: async () => {
          looked = true;
          return [{ address: publicAddress, family: 4 }];
        },
        request: responseRequest("hidden"),
      },
    );

    // Refused on the name alone: an internal hostname that happens to answer
    // with a public address today is still somebody's idea of an inside route.
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error.message).toBe("HTTP request target is not a public address");
    expect(looked).toBe(false);
  });

  test("refuses loopback even when the service is right there", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("connected") });
    try {
      const result = await requestWorkflowHttp({ url: `http://127.0.0.1:${server.port}/health`, method: "GET" }, {});
      // There is no setting that opens this. A workflow author has the app's
      // permissions, not the server's network position, and the whole point of
      // this client is that the difference holds.
      expect(result.ok).toBe(false);
      expect(result.ok ? "" : result.error.message).toBe("HTTP request target is not a public address");
    } finally {
      server.stop(true);
    }
  });

  test("rejects mixed public and private DNS answers", async () => {
    const result = await requestWorkflowHttp(
      { url: "https://api.example.com", method: "GET" },
      {
        lookup: async () => [
          { address: publicAddress, family: 4 },
          { address: "127.0.0.1", family: 4 },
        ],
        request: responseRequest("hidden"),
      },
    );

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error.message).toBe("HTTP request target is not a public address");
  });

  test("rejects oversized request bodies before opening a socket", async () => {
    let requested = false;
    const result = await requestWorkflowHttp(
      { url: "https://api.example.com", method: "POST", body: "x".repeat(64 * 1024 + 1) },
      {
        lookup: async () => [{ address: publicAddress, family: 4 }],
        request: responseRequest("hidden", () => {
          requested = true;
        }),
      },
    );

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error.message).toBe("httpRequest body is too large");
    expect(requested).toBe(false);
  });

  test("rejects unsafe, malformed, and conflicting request headers", async () => {
    const unsafeHeaders: Record<string, string>[] = [
      { " Content-Length ": "5" },
      { "TRANSFER-ENCODING": "chunked" },
      { Host: "internal.example" },
      { "x-value": "safe\r\nHost: internal.example" },
      { "bad header": "value" },
    ];
    for (const headers of unsafeHeaders) {
      const result = await requestWorkflowHttp({ url: "https://api.example.com", method: "GET", headers });
      expect(result.ok).toBe(false);
      expect(result.ok ? "" : result.error.message).toMatch(/header .* (?:invalid|not allowed)/);
    }
  });

  test("stops buffering as soon as the streamed response exceeds 64 KiB", async () => {
    const result = await requestWorkflowHttp(
      { url: "https://api.example.com/large", method: "GET" },
      {
        lookup: async () => [{ address: publicAddress, family: 4 }],
        request: responseRequest([Buffer.alloc(40 * 1024), Buffer.alloc(40 * 1024)]),
      },
    );

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error.code).toBe("WORKFLOW_HTTP_OUTCOME_UNKNOWN");
  });

  test("marks connection failures before request dispatch as retryable", async () => {
    const requestFactory = (() => {
      const request = new EventEmitter() as ClientRequest;
      request.destroy = (() => request) as ClientRequest["destroy"];
      request.end = (() => {
        queueMicrotask(() => request.emit("error", Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" })));
        return request;
      }) as ClientRequest["end"];
      return request;
    }) as (options: RequestOptions, callback: (response: IncomingMessage) => void) => ClientRequest;
    const result = await requestWorkflowHttp(
      { url: "https://api.example.com/hooks", method: "POST", body: "{}" },
      {
        lookup: async () => [{ address: publicAddress, family: 4 }],
        request: requestFactory,
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("WORKFLOW_HTTP_RETRYABLE");
      expect(result.error.status).toBe(500);
    }
  });

  test("applies the request timeout while DNS is still resolving", async () => {
    const result = await requestWorkflowHttp(
      { url: "https://api.example.com/slow", method: "GET", timeoutMs: 5 },
      {
        lookup: () => new Promise(() => undefined),
      },
    );

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error.message).toBe("HTTP request target resolution timed out");
  });

  test("cancels final authorization within the existing request budget", async () => {
    let cancelled = false;
    let dispatched = false;
    const result = await requestWorkflowHttp(
      {
        url: "https://api.example.com/slow",
        method: "GET",
        timeoutMs: 5,
        authorize: (signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                cancelled = true;
                reject(signal.reason);
              },
              { once: true },
            );
          }),
      },
      {
        lookup: async () => [{ address: publicAddress, family: 4 }],
        request: () => {
          dispatched = true;
          throw new Error("Unexpected dispatch");
        },
      },
    );
    expect(cancelled).toBe(true);
    expect(dispatched).toBe(false);
    expect(result.ok ? "" : result.error.code).toBe("WORKFLOW_HTTP_RETRYABLE");
  });

  test("applies the timeout after response headers arrive", async () => {
    const requestFactory = ((_options: RequestOptions, callback: (response: IncomingMessage) => void) => {
      const request = new EventEmitter() as ClientRequest;
      request.destroy = ((error?: Error) => {
        if (error) queueMicrotask(() => request.emit("error", error));
        return request;
      }) as ClientRequest["destroy"];
      request.end = (() => {
        queueMicrotask(() => {
          const response = new PassThrough() as unknown as IncomingMessage;
          response.statusCode = 200;
          response.headers = {};
          callback(response);
          response.emit("data", Buffer.from("partial"));
        });
        return request;
      }) as ClientRequest["end"];
      return request;
    }) as (options: RequestOptions, callback: (response: IncomingMessage) => void) => ClientRequest;

    const result = await requestWorkflowHttp(
      { url: "https://api.example.com/slow", method: "GET", timeoutMs: 5 },
      {
        lookup: async () => [{ address: publicAddress, family: 4 }],
        request: requestFactory,
      },
    );

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error.code).toBe("WORKFLOW_HTTP_OUTCOME_UNKNOWN");
  });

  test("classifies IPv4, IPv6, and mapped private ranges conservatively", () => {
    expect(isUnsafeWorkflowHttpAddress("10.0.0.1")).toBe(true);
    expect(isUnsafeWorkflowHttpAddress("100.64.0.1")).toBe(true);
    expect(isUnsafeWorkflowHttpAddress("203.0.113.1")).toBe(true);
    expect(isUnsafeWorkflowHttpAddress("::1")).toBe(true);
    expect(isUnsafeWorkflowHttpAddress("0:0:0:0:0:ffff:127.0.0.1")).toBe(true);
    expect(isUnsafeWorkflowHttpAddress("fc00::1")).toBe(true);
    expect(isUnsafeWorkflowHttpAddress(publicAddress)).toBe(false);
    expect(isUnsafeWorkflowHttpAddress("2606:4700:4700::1111")).toBe(false);
  });
});
