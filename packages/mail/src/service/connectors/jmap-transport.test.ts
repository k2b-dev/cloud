import { afterEach, expect, test } from "bun:test";
import { createJmapFixture } from "./jmap-fixture";
import { requestJmap } from "./jmap-transport";

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
