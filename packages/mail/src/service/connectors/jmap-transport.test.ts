import { afterEach, expect, spyOn, test } from "bun:test";
import type { IncomingMessage } from "node:http";
import { EndpointPolicyError } from "./endpoint-policy";
import { createJmapFixture } from "./jmap-fixture";
import { consumeJmapDownload, type JmapTransportDependencies, requestJmap } from "./jmap-transport";

const fixtures: ReturnType<typeof createJmapFixture>[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
});
const fixture = () => {
  const value = createJmapFixture();
  fixtures.push(value);
  return value;
};
const input = (url = "https://mail.example.invalid/.well-known/jmap") => ({
  url: new URL(url),
  method: "GET" as const,
  maxBytes: 4096,
  signal: new AbortController().signal,
});

test("bounds advertised and chunked response bodies", async () => {
  const f = fixture();
  f.controls.oversized = true;
  await expect(requestJmap(input(), f.dependencies)).rejects.toMatchObject({ code: "JMAP_TOO_LARGE" });
  f.controls.handle = () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(4097));
          controller.close();
        },
      }),
    );
  await expect(requestJmap(input(), f.dependencies)).rejects.toMatchObject({ code: "JMAP_TOO_LARGE" });
});

test("returns Location and never follows a redirect", async () => {
  const f = fixture();
  f.controls.redirect = "/jmap/session";
  expect(await requestJmap(input(), f.dependencies)).toMatchObject({ status: 307, location: "/jmap/session" });
  expect(f.requests).toHaveLength(1);
});

test("requires HTTPS and rejects URL credentials before resolving", async () => {
  const f = fixture();
  for (const url of ["http://mail.example.invalid", "https://reader:fixture@mail.example.invalid"]) {
    await expect(requestJmap(input(url), f.dependencies)).rejects.toMatchObject({ code: "JMAP_HTTPS_REQUIRED" });
  }
  expect(f.requests).toHaveLength(0);
});

test("production endpoint policy blocks loopback and private addresses", async () => {
  for (const host of ["127.0.0.1", "10.0.0.1", "[::1]", "localhost"]) {
    await expect(requestJmap(input(`https://${host}`))).rejects.toMatchObject({ code: "JMAP_TRANSPORT" });
  }
});

test("pins lookup and requires verified TLS without a shared agent", async () => {
  const f = fixture();
  let checked = false;
  await requestJmap(input(), {
    ...f.dependencies,
    request: (options, callback) => {
      expect(options).toMatchObject({
        protocol: "https:",
        hostname: "mail.example.invalid",
        servername: "mail.example.invalid",
        agent: false,
        rejectUnauthorized: true,
      });
      expect(options.lookup).toBeFunction();
      checked = true;
      return f.dependencies.request!(options, callback);
    },
  });
  expect(checked).toBe(true);
});

test("cancels an unresolved DNS lookup without opening a connection", async () => {
  const controller = new AbortController();
  const work = requestJmap(
    { ...input(), signal: controller.signal },
    {
      resolveEndpoint: async () => {
        controller.abort();
        return new Promise(() => {});
      },
      request: () => {
        throw new Error("must not connect");
      },
    },
  );
  await expect(work).rejects.toMatchObject({ code: "JMAP_ABORTED" });
});

test("cancels connection setup and a partial response", async () => {
  const f = fixture();
  const connecting = new AbortController();
  await expect(
    requestJmap(
      { ...input(), signal: connecting.signal },
      {
        ...f.dependencies,
        request: (options, callback) => {
          const outgoing = f.dependencies.request!(options, callback);
          connecting.abort();
          return outgoing;
        },
      },
    ),
  ).rejects.toMatchObject({ code: "JMAP_ABORTED" });
  const reading = new AbortController();
  f.controls.handle = () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("{"));
        },
      }),
    );
  await expect(
    requestJmap(
      { ...input(), signal: reading.signal },
      {
        ...f.dependencies,
        request: (options, callback) =>
          f.dependencies.request!(options, (response) => {
            callback(response);
            response.once("data", () => reading.abort());
          }),
      },
    ),
  ).rejects.toMatchObject({ code: "JMAP_ABORTED" });
});

test("rejects invalid budgets and redacts network errors", async () => {
  await expect(requestJmap({ ...input(), maxBytes: Infinity })).rejects.toMatchObject({ code: "JMAP_BYTE_BUDGET" });
  const f = fixture();
  await expect(
    requestJmap(input(), {
      ...f.dependencies,
      request: () => {
        throw new Error("Authorization: private fixture");
      },
    }),
  ).rejects.toThrow("JMAP_TRANSPORT");
});

const dnsTimeout = async (): Promise<never> => {
  throw new EndpointPolicyError("Endpoint DNS lookup timed out", "ENDPOINT_DNS_TIMEOUT");
};
const noConnection: NonNullable<JmapTransportDependencies["request"]> = () => {
  throw new Error("must not connect");
};

test("an expired DNS, connection or response deadline is JMAP_TIMEOUT", async () => {
  // DNS: resolvePublicEndpoint's own deadline.
  await expect(requestJmap(input(), { resolveEndpoint: dnsTimeout, request: noConnection })).rejects.toMatchObject({
    code: "JMAP_TIMEOUT",
    message: "JMAP_TIMEOUT",
  });
  const f = fixture();
  const factory = f.dependencies.request;
  if (!factory) throw new Error("Missing test factory");
  // Connection: the socket gave up.
  await expect(
    requestJmap(input(), {
      ...f.dependencies,
      request: () => {
        throw Object.assign(new Error("connect ETIMEDOUT 192.0.2.1:443"), { code: "ETIMEDOUT" });
      },
    }),
  ).rejects.toMatchObject({ code: "JMAP_TIMEOUT", message: "JMAP_TIMEOUT" });
  // The 15 s request deadline, expired by hand: once during DNS, once in a response that stops.
  const timers = spyOn(globalThis, "setTimeout");
  // The latest armed request deadline; the real timer is cleared once the request settles.
  const expire = () => {
    const deadline = timers.mock.calls.findLast(([, timeout]) => timeout === 15_000)?.[0];
    if (typeof deadline !== "function") throw new Error("Expected the request deadline");
    deadline();
  };
  try {
    await expect(
      requestJmap(input(), {
        resolveEndpoint: async () => {
          expire();
          return new Promise(() => {});
        },
        request: noConnection,
      }),
    ).rejects.toMatchObject({ code: "JMAP_TIMEOUT" });
    f.controls.handle = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("{"));
          },
        }),
      );
    await expect(
      requestJmap(input(), {
        ...f.dependencies,
        request: (options, callback) =>
          factory(options, (response: IncomingMessage) => {
            callback(response);
            response.once("data", () => expire());
          }),
      }),
    ).rejects.toMatchObject({ code: "JMAP_TIMEOUT" });
  } finally {
    timers.mockRestore();
  }
});

test("a download whose DNS lookup times out is JMAP_TIMEOUT, a cancelled one JMAP_ABORTED", async () => {
  const download = { ...input(), url: new URL("https://mail.example.invalid/jmap/download/a/b/message.eml") };
  await expect(
    consumeJmapDownload(download, async () => null, { resolveEndpoint: dnsTimeout, request: noConnection }),
  ).rejects.toMatchObject({
    code: "JMAP_TIMEOUT",
  });
  const controller = new AbortController();
  await expect(
    consumeJmapDownload({ ...download, signal: controller.signal }, async () => null, {
      resolveEndpoint: async () => {
        controller.abort();
        return dnsTimeout();
      },
      request: noConnection,
    }),
  ).rejects.toMatchObject({ code: "JMAP_ABORTED" });
});
