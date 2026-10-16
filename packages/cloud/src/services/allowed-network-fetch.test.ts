import { afterEach, expect, mock, test } from "bun:test";
import { createServer, type RequestListener, type Server } from "node:http";
import { parseNetworkAllowlistEnv } from "../shared/network-address";
import { createAllowedNetworkFetch } from "./allowed-network-fetch";
import { NetworkTargetBlockedError } from "./network-security";

const allow = (...entries: string[]) => parseNetworkAllowlistEnv("TEST_ALLOWED_TARGETS", entries);
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});
const serve = async (handler: RequestListener, host = "127.0.0.1") => {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => resolve());
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected IP socket");
  return { server, port: address.port, url: `http://${host.includes(":") ? `[${host}]` : host}:${address.port}` };
};

for (const [name, addresses] of [
  ["private IPv4", [{ address: "127.0.0.1", family: 4 }]],
  ["mapped IPv4", [{ address: "::ffff:127.0.0.1", family: 6 }]],
  ["private IPv6", [{ address: "::1", family: 6 }]],
  [
    "mixed public/private",
    [
      { address: "8.8.8.8", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ],
  ],
] as const) {
  test(`refuses DNS ${name} before connecting`, async () => {
    const request = mock(() => {
      throw new Error("Must not connect");
    });
    const lookup = mock(async () => [...addresses]);
    await expect(createAllowedNetworkFetch(allow(), { lookup, request })("http://target.example/")).rejects.toBeInstanceOf(
      NetworkTargetBlockedError,
    );
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(request).not.toHaveBeenCalled();
  });
}
test("blocks literal loopback without contacting the server", async () => {
  const received = mock((_req, res) => res.end("unexpected"));
  const { url } = await serve(received);
  await expect(createAllowedNetworkFetch(allow())(url)).rejects.toBeInstanceOf(NetworkTargetBlockedError);
  expect(received).not.toHaveBeenCalled();
});
for (const entry of ["target.example", "127.0.0.0/8"]) {
  test(`allows ${entry} and pins the only DNS answer, preserving Host`, async () => {
    let host: string | undefined;
    const { port } = await serve((req, res) => {
      host = req.headers.host;
      res.end("pinned");
    });
    const lookup = mock(async () => [{ address: "127.0.0.1", family: 4 }]);
    lookup.mockImplementationOnce(async () => [{ address: "127.0.0.1", family: 4 }]);
    lookup.mockImplementation(async () => [{ address: "192.0.2.1", family: 4 }]);
    const response = await createAllowedNetworkFetch(allow(entry), { lookup })(`http://target.example:${port}/`);
    expect(await response.text()).toBe("pinned");
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(host).toBe(`target.example:${port}`);
  });
}
test("IPv6 loopback is blocked by default and allowed by CIDR when IPv6 is available", async () => {
  let endpoint: Awaited<ReturnType<typeof serve>>;
  try {
    endpoint = await serve((_req, res) => res.end("ipv6"), "::1");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && ["EAFNOSUPPORT", "EADDRNOTAVAIL"].includes(String(error.code))) return;
    throw error;
  }
  await expect(createAllowedNetworkFetch(allow())(endpoint.url)).rejects.toBeInstanceOf(NetworkTargetBlockedError);
  expect(await (await createAllowedNetworkFetch(allow("::1/128"))(endpoint.url)).text()).toBe("ipv6");
});
test("returns redirects without following; redirect error rejects without another request", async () => {
  const visited = mock((_req, res) => res.end("redirected"));
  const destination = await serve(visited);
  const source = await serve((_req, res) => {
    res.writeHead(302, { location: destination.url });
    res.end();
  });
  const fetch = createAllowedNetworkFetch(allow("127.0.0.1"));
  for (const redirect of [undefined, "manual", "follow"] as const) {
    const response = await fetch(source.url, { redirect });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(destination.url);
    await response.body?.cancel();
  }
  await expect(fetch(source.url, { redirect: "error" })).rejects.toThrow("302");
  expect(visited).not.toHaveBeenCalled();
});
for (const url of ["http://user:secret@target.example/", "ftp://target.example/"]) {
  test(`refuses unsupported URL before lookup: ${new URL(url).protocol}`, async () => {
    const lookup = mock(async () => []);
    await expect(createAllowedNetworkFetch(allow(), { lookup })(url)).rejects.toBeInstanceOf(TypeError);
    expect(lookup).not.toHaveBeenCalled();
  });
}
test("requests identity encoding and rejects compressed responses", async () => {
  const { url } = await serve((req, res) => {
    expect(req.headers["accept-encoding"]).toBe("identity");
    res.writeHead(200, { "content-encoding": "gzip" });
    res.end("compressed");
  });
  await expect(createAllowedNetworkFetch(allow("127.0.0.1"))(url)).rejects.toThrow("content encoding");
});
test("propagates guard errors unchanged and refuses empty and failed lookups", async () => {
  const blocked = new NetworkTargetBlockedError("fixture");
  await expect(
    createAllowedNetworkFetch(allow(), {
      resolve: async () => {
        throw blocked;
      },
    })("http://target.example"),
  ).rejects.toBe(blocked);
  await expect(createAllowedNetworkFetch(allow(), { lookup: async () => [] })("http://target.example")).rejects.toThrow("resolved");
  await expect(
    createAllowedNetworkFetch(allow(), {
      lookup: async () => {
        throw new Error("DNS failed");
      },
    })("http://target.example"),
  ).rejects.toThrow("DNS failed");
});
test("aborts pending lookup without ever connecting", async () => {
  const controller = new AbortController();
  const request = mock(() => {
    throw new Error("Must not connect");
  });
  let resolved!: () => void;
  const lookup = () =>
    new Promise<Array<{ address: string; family: number }>>((resolve) => {
      resolved = () => resolve([{ address: "127.0.0.1", family: 4 }]);
    });
  const pending = createAllowedNetworkFetch(allow("target.example"), { lookup, request })("http://target.example", {
    signal: controller.signal,
  });
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  resolved();
  expect(request).not.toHaveBeenCalled();
});
test("Request signal aborts a streaming response and closes the socket", async () => {
  let closed!: Promise<void>;
  const { url } = await serve((_req, res) => {
    closed = new Promise<void>((resolve) => res.once("close", resolve));
    res.write("first");
  });
  const controller = new AbortController();
  const response = await createAllowedNetworkFetch(allow("127.0.0.1"))(new Request(url, { signal: controller.signal }));
  const reader = response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("first");
  const pending = reader.read();
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  await closed;
});
test("streams response before completion and preserves repeated headers and status text", async () => {
  let finish!: () => void;
  const { url } = await serve((_req, res) => {
    res.writeHead(201, "Created fixture", { "set-cookie": ["a=1", "b=2"], "x-repeat": ["first", "second"] });
    res.write("first");
    finish = () => res.end("last");
  });
  const response = await createAllowedNetworkFetch(allow("127.0.0.1"))(url);
  expect(response.status).toBe(201);
  expect(response.statusText).toBe("Created fixture");
  expect(response.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
  expect(response.headers.get("x-repeat")).toBe("first, second");
  const reader = response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("first");
  finish();
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("last");
  expect((await reader.read()).done).toBe(true);
});
for (const [name, body] of [
  ["string", "hello"],
  ["bytes", new Uint8Array([104, 101, 108, 108, 111])],
  ["Blob", new Blob(["hello"])],
  ["URLSearchParams", new URLSearchParams({ key: "hello" })],
  [
    "ReadableStream",
    new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode("hello"));
        c.close();
      },
    }),
  ],
] satisfies [string, BodyInit][]) {
  test(`sends a POST ${name} body`, async () => {
    let length: string | undefined;
    const { url } = await serve(async (req, res) => {
      expect(req.method).toBe("POST");
      length = req.headers["content-length"];
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      res.end(Buffer.concat(chunks));
    });
    const response = await createAllowedNetworkFetch(allow("127.0.0.1"))(url, { method: "POST", body });
    expect(await response.text()).toBe(name === "URLSearchParams" ? "key=hello" : "hello");
    expect(length).toBe(name === "ReadableStream" ? undefined : String(name === "URLSearchParams" ? 9 : 5));
  });
}
for (const [method, status] of [
  ["HEAD", 200],
  ["GET", 204],
  ["GET", 304],
] as const) {
  test(`returns null body for ${method} ${status}`, async () => {
    const { url } = await serve((_req, res) => {
      res.writeHead(status);
      res.end();
    });
    const response = await createAllowedNetworkFetch(allow("127.0.0.1"))(url, { method });
    expect(response.body).toBeNull();
  });
}

for (const [url, hostname, servername] of [
  ["https://target.example:8443/path?q=fixture", "target.example", "target.example"],
  ["https://[::1]:8443/path", "::1", undefined],
] as const) {
  test(`pins request options and TLS identity for ${hostname} before I/O`, async () => {
    const stop = new Error("Stopped before I/O");
    const lookup = mock(async () => [{ address: "127.0.0.1", family: 4 }]);
    await expect(
      createAllowedNetworkFetch(allow(hostname), {
        lookup,
        request: (options) => {
          expect(options).toMatchObject({ hostname, servername, agent: false, port: "8443" });
          expect(options.lookup).toBeFunction();
          expect(options.headers).toMatchObject({ host: new URL(url).host, "accept-encoding": "identity" });
          throw stop;
        },
      })(url),
    ).rejects.toBe(stop);
    expect(lookup).toHaveBeenCalledTimes(hostname === "::1" ? 0 : 1);
  });
}

test("abort before response headers destroys the connected socket", async () => {
  let connected!: () => void;
  const ready = new Promise<void>((resolve) => {
    connected = resolve;
  });
  let closed!: Promise<void>;
  const { url } = await serve((_req, res) => {
    closed = new Promise<void>((resolve) => res.once("close", resolve));
    connected();
  });
  const controller = new AbortController();
  const pending = createAllowedNetworkFetch(allow("127.0.0.1"))(url, { signal: controller.signal });
  await ready;
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  await closed;
});

test("streams an upload before the producer finishes", async () => {
  let arrived!: () => void;
  const firstChunk = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const chunks: Buffer[] = [];
  const { url } = await serve(async (req, res) => {
    for await (const chunk of req) {
      chunks.push(chunk);
      arrived();
    }
    res.end(Buffer.concat(chunks));
  });
  let producer!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      producer = controller;
    },
  });
  const pending = createAllowedNetworkFetch(allow("127.0.0.1"))(url, { method: "POST", body });
  producer.enqueue(new TextEncoder().encode("first"));
  await firstChunk;
  producer.enqueue(new TextEncoder().encode("last"));
  producer.close();
  expect(await (await pending).text()).toBe("firstlast");
});
