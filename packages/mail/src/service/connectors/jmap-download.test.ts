import { afterEach, expect, test } from "bun:test";
import { once } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import { type Readable, Transform } from "node:stream";
import { createJmapFixture } from "./jmap-fixture";
import { JMAP_JSON_BYTES } from "./jmap-http";
import { consumeJmapDownload, type JmapTransportDependencies } from "./jmap-transport";

const fixtures: ReturnType<typeof createJmapFixture>[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
});
function setup() {
  const fixture = createJmapFixture();
  fixtures.push(fixture);
  fixture.blobs.set("blob-one", [Buffer.from([0, 1, 2]), Buffer.from([253, 254, 255])]);
  const controller = new AbortController();
  const input = {
    url: new URL("/jmap/download/d333333/blob-one/message.eml?accept=message%2Frfc822", fixture.origin),
    method: "GET" as const,
    maxBytes: 1024,
    signal: controller.signal,
  };
  let outgoing: ClientRequest | undefined;
  let incoming: IncomingMessage | undefined;
  const dependencies: JmapTransportDependencies = {
    ...fixture.dependencies,
    request(options, callback) {
      const factory = fixture.dependencies.request;
      if (!factory) throw new Error("Missing test factory");
      outgoing = factory(options, (response) => {
        incoming = response;
        callback(response);
      });
      return outgoing;
    },
  };
  return { fixture, controller, input, dependencies, outgoing: () => outgoing, incoming: () => incoming };
}
async function collect(source: Readable) {
  const chunks: Buffer[] = [];
  for await (const chunk of source) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
function clock() {
  let now = 0;
  const timers: Array<{ expire: () => void; milliseconds: number; due: number; active: boolean }> = [];
  const downloadTimer = (expire: () => void, milliseconds: number) => {
    const timer = { expire, milliseconds, due: now + milliseconds, active: true };
    timers.push(timer);
    return () => {
      timer.active = false;
    };
  };
  const expire = () => {
    const active = timers.filter((timer) => timer.active);
    expect(active).toHaveLength(1);
    const timer = active[0];
    if (!timer) throw new Error("Missing active timer");
    timer.expire();
  };
  const advance = (milliseconds: number) => {
    now += milliseconds;
    for (const timer of [...timers]) if (timer.active && timer.due <= now) timer.expire();
  };
  return { timers, downloadTimer, expire, advance };
}

test("streams all binary byte values across chunks and keeps the connection until consume settles", async () => {
  const f = setup();
  const bytes = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
  f.fixture.blobs.set("blob-one", [bytes.subarray(0, 40), bytes.subarray(40, 150), bytes.subarray(150)]);
  const releases = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  f.fixture.download.afterChunk = async (index) => releases[index]?.promise;
  const time = clock();
  let chunks = 0;
  const result = await consumeJmapDownload(
    f.input,
    async (source) => {
      source.on("data", () => {
        releases[chunks++]?.resolve();
      });
      const result = await collect(source);
      expect(time.timers.every((timer) => !timer.active)).toBe(true);
      return result;
    },
    { ...f.dependencies, downloadTimer: time.downloadTimer },
  );
  expect(result).toEqual(bytes);
  expect(chunks).toBe(3);
  expect(f.outgoing()?.destroyed).toBe(true);
  expect(f.incoming()?.destroyed).toBe(true);
});

test("a paused consumer bounds buffered chunks and backpressures the response", async () => {
  const f = setup();
  const time = clock();
  const chunk = Buffer.alloc(64 * 1024, 42);
  const total = chunk.length * 128;
  f.fixture.blobs.set(
    "blob-one",
    Array.from({ length: 128 }, () => chunk),
  );
  let received = 0;
  let largestChunk = 0;
  const paused = Promise.withResolvers<void>();
  const factory = f.dependencies.request;
  if (!factory) throw new Error("Missing test factory");
  const result = await consumeJmapDownload(
    { ...f.input, maxBytes: total },
    async (source) => {
      await paused.promise;
      expect(f.incoming()?.isPaused()).toBe(true);
      expect(received).toBeLessThan(total);
      expect(source.readableLength).toBeLessThanOrEqual(source.readableHighWaterMark + largestChunk);
      if (!(source instanceof Transform)) throw new Error("Expected bounded download transform");
      expect(source.writableLength).toBeLessThanOrEqual(source.writableHighWaterMark + largestChunk);
      expect(source.readableHighWaterMark).toBeLessThan(total);
      expect(time.timers.every((timer) => !timer.active)).toBe(true);
      time.advance(120_000); // Longer than the network idle budget, entirely under backpressure.
      const bytes = await collect(source);
      expect(bytes.equals(Buffer.alloc(total, 42))).toBe(true);
      return bytes.length;
    },
    {
      ...f.dependencies,
      downloadTimer: time.downloadTimer,
      request: (options, callback) =>
        factory(options, (response) => {
          response.on("data", (value: Buffer) => {
            received += value.length;
            largestChunk = Math.max(largestChunk, value.length);
          });
          response.once("pause", () => paused.resolve());
          callback(response);
        }),
    },
  );
  expect(result).toBe(total);
});

test("enforces actual and advertised byte limits", async () => {
  for (const advertised of [undefined, 6, 4096]) {
    const f = setup();
    f.fixture.download.contentLength = advertised;
    let called = false;
    await expect(
      consumeJmapDownload(
        { ...f.input, maxBytes: 5 },
        async (source) => {
          called = true;
          return collect(source);
        },
        f.dependencies,
      ),
    ).rejects.toMatchObject({ code: "JMAP_TOO_LARGE" });
    if (advertised !== undefined) expect(called).toBe(false);
    expect(f.outgoing()?.destroyed).toBe(true);
  }
});

test("never calls consume for redirects, missing source, auth, rate limits or request problems", async () => {
  for (const [status, expected] of [
    [307, { code: "JMAP_REDIRECT" }],
    [404, { code: "JMAP_SOURCE_MISSING" }],
    [401, { code: "JMAP_HTTP", status: 401 }],
    [403, { code: "JMAP_HTTP", status: 403 }],
    [429, { code: "JMAP_RATE_LIMIT", retryAfter: "30" }],
    [500, { code: "JMAP_HTTP", status: 500 }],
  ] as const) {
    const f = setup();
    f.fixture.download.status = status;
    let called = false;
    await expect(
      consumeJmapDownload(
        f.input,
        async () => {
          called = true;
        },
        f.dependencies,
      ),
    ).rejects.toMatchObject(expected);
    expect(called).toBe(false);
    expect(f.fixture.requests).toHaveLength(1);
  }
  const f = setup();
  f.fixture.controls.handle = () => Response.json({ type: "urn:ietf:params:jmap:error:limit" }, { status: 400 });
  await expect(consumeJmapDownload(f.input, collect, f.dependencies)).rejects.toMatchObject({
    code: "JMAP_REQUEST",
    problemType: "urn:ietf:params:jmap:error:limit",
  });
});

test("bounds error bodies by the JSON budget even with a larger source budget", async () => {
  for (const contentLength of [false, true]) {
    const f = setup();
    f.fixture.controls.handle = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(JMAP_JSON_BYTES + 1));
            controller.close();
          },
        }),
        { status: 401, headers: contentLength ? { "content-length": String(JMAP_JSON_BYTES + 1) } : {} },
      );
    let called = false;
    await expect(
      consumeJmapDownload(
        { ...f.input, maxBytes: JMAP_JSON_BYTES * 2 },
        async () => {
          called = true;
        },
        f.dependencies,
      ),
    ).rejects.toMatchObject({ code: "JMAP_TOO_LARGE" });
    expect(called).toBe(false);
  }
});

test("rejects before connection, during DNS and during connection setup", async () => {
  const f = setup();
  f.controller.abort();
  await expect(consumeJmapDownload(f.input, collect, f.dependencies)).rejects.toMatchObject({ code: "JMAP_ABORTED" });
  expect(f.fixture.requests).toHaveLength(0);
  const dns = setup();
  await expect(
    consumeJmapDownload(dns.input, collect, {
      ...dns.dependencies,
      resolveEndpoint: async () => {
        dns.controller.abort();
        return new Promise(() => {});
      },
    }),
  ).rejects.toMatchObject({ code: "JMAP_ABORTED" });
  expect(dns.outgoing()).toBeUndefined();
  const connecting = setup();
  const factory = connecting.dependencies.request;
  if (!factory) throw new Error("Missing test factory");
  await expect(
    consumeJmapDownload(connecting.input, collect, {
      ...connecting.dependencies,
      request(options, callback) {
        const outgoing = factory(options, callback);
        connecting.controller.abort();
        return outgoing;
      },
    }),
  ).rejects.toMatchObject({ code: "JMAP_ABORTED" });
  expect(connecting.outgoing()?.destroyed).toBe(true);
});

test("connection timeout covers DNS without opening a request", async () => {
  const f = setup();
  const time = clock();
  await expect(
    consumeJmapDownload(f.input, collect, {
      ...f.dependencies,
      downloadTimer: time.downloadTimer,
      resolveEndpoint: async () => {
        expect(time.timers[0]?.milliseconds).toBe(15_000);
        time.expire();
        return new Promise(() => {});
      },
    }),
  ).rejects.toMatchObject({ code: "JMAP_TIMEOUT" });
  expect(f.outgoing()).toBeUndefined();
  expect(time.timers.every((timer) => !timer.active)).toBe(true);
});

test("caller abort during the body and from consume is a stream error, never a silent end", async () => {
  for (const abortInConsume of [false, true]) {
    const f = setup();
    f.fixture.download.afterChunk = async () => new Promise(() => {});
    let ended = false;
    const streamError = Promise.withResolvers<unknown>();
    const work = consumeJmapDownload(
      f.input,
      async (source) => {
        source.once("end", () => {
          ended = true;
        });
        const error = once(source, "error").then(([value]) => {
          streamError.resolve(value);
        });
        if (abortInConsume) f.controller.abort();
        else source.once("data", () => f.controller.abort());
        await error;
      },
      f.dependencies,
    );
    await expect(work).rejects.toMatchObject({ code: "JMAP_ABORTED" });
    expect(await streamError.promise).toMatchObject({ code: "JMAP_ABORTED" });
    expect(ended).toBe(false);
    expect(f.outgoing()?.destroyed).toBe(true);
    expect(f.incoming()?.destroyed).toBe(true);
  }
});

test("consumer errors retain their identity and code and close every owned stream", async () => {
  const f = setup();
  let source: Readable | undefined;
  const failure = Object.assign(new Error("Hydration claim lost"), { code: "HYDRATION_NOT_CLAIMED" });
  const work = consumeJmapDownload(
    f.input,
    async (value) => {
      source = value;
      throw failure;
    },
    f.dependencies,
  );
  await expect(work).rejects.toBe(failure);
  await expect(work).rejects.toMatchObject({ code: "HYDRATION_NOT_CLAIMED" });
  expect(source?.destroyed).toBe(true);
  expect(f.outgoing()?.destroyed).toBe(true);
  expect(f.incoming()?.destroyed).toBe(true);
});

test("a connection cut mid-body errors the consumer", async () => {
  const f = setup();
  f.fixture.download.afterChunk = async () => new Promise(() => {});
  const consumer = Promise.withResolvers<unknown>();
  let ended = false;
  await expect(
    consumeJmapDownload(
      f.input,
      async (source) => {
        source.once("end", () => {
          ended = true;
        });
        source.once("data", () => f.fixture.close());
        try {
          await collect(source);
          consumer.resolve(null);
        } catch (error) {
          consumer.resolve(error);
          throw error;
        }
      },
      f.dependencies,
    ),
  ).rejects.toMatchObject({ code: "JMAP_TRANSPORT" });
  expect(await consumer.promise).toMatchObject({ code: "JMAP_TRANSPORT" });
  expect(ended).toBe(false);
});

test("idle deadline resets on data, expires a stalled response and ends at response end", async () => {
  const f = setup();
  const time = clock();
  f.fixture.download.afterChunk = async () => new Promise(() => {});
  const consumer = Promise.withResolvers<unknown>();
  await expect(
    consumeJmapDownload(
      f.input,
      async (source) => {
        source.once("data", () => {
          expect(time.timers.filter((timer) => timer.milliseconds === 60_000).length).toBeGreaterThanOrEqual(2);
          time.expire();
        });
        try {
          await collect(source);
          consumer.resolve(null);
        } catch (error) {
          consumer.resolve(error);
          throw error;
        }
      },
      { ...f.dependencies, downloadTimer: time.downloadTimer },
    ),
  ).rejects.toMatchObject({ code: "JMAP_TIMEOUT" });
  expect(await consumer.promise).toMatchObject({ code: "JMAP_TIMEOUT" });
  expect(time.timers.every((timer) => !timer.active)).toBe(true);
});

test("download retains HTTPS, pinning, TLS verification, redaction and identity encoding", async () => {
  const f = setup();
  const factory = f.dependencies.request;
  if (!factory) throw new Error("Missing test factory");
  await consumeJmapDownload(f.input, collect, {
    ...f.dependencies,
    request(options, callback) {
      expect(options).toMatchObject({
        protocol: "https:",
        hostname: "mail.example.invalid",
        servername: "mail.example.invalid",
        agent: false,
        rejectUnauthorized: true,
      });
      expect(options.lookup).toBeFunction();
      expect(options.headers).toMatchObject({ "accept-encoding": "identity" });
      return factory(options, callback);
    },
  });
  for (const url of ["http://mail.example.invalid", "https://user:pass@mail.example.invalid"])
    await expect(consumeJmapDownload({ ...f.input, url: new URL(url) }, collect, f.dependencies)).rejects.toMatchObject({
      code: "JMAP_HTTPS_REQUIRED",
    });
  await expect(consumeJmapDownload({ ...f.input, maxBytes: Infinity }, collect, f.dependencies)).rejects.toMatchObject({
    code: "JMAP_BYTE_BUDGET",
  });
  await expect(
    consumeJmapDownload(f.input, collect, {
      ...f.dependencies,
      request() {
        throw new Error("Authorization: private");
      },
    }),
  ).rejects.toMatchObject({ code: "JMAP_TRANSPORT", message: "JMAP_TRANSPORT" });
  f.fixture.controls.handle = () => new Response("compressed", { headers: { "content-encoding": "gzip" } });
  await expect(consumeJmapDownload(f.input, collect, f.dependencies)).rejects.toMatchObject({ code: "JMAP_TRANSPORT" });
  await expect(consumeJmapDownload({ ...f.input, url: new URL("https://127.0.0.1") }, collect)).rejects.toMatchObject({
    code: "JMAP_TRANSPORT",
  });
});

test("counts received bytes even when a response header understates the size", async () => {
  const f = setup();
  const factory = f.dependencies.request;
  if (!factory) throw new Error("Missing test factory");
  await expect(
    consumeJmapDownload({ ...f.input, maxBytes: 5 }, collect, {
      ...f.dependencies,
      request(options, callback) {
        return factory(options, (response) => {
          // Inject a misleading parsed header without changing HTTP framing.
          response.headers["content-length"] = "1";
          callback(response);
        });
      },
    }),
  ).rejects.toMatchObject({ code: "JMAP_TOO_LARGE" });
});

test("a completed response keeps the consumer under the caller signal with no idle timer", async () => {
  const f = setup();
  const time = clock();
  const consumed = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let settled = false;
  const work = consumeJmapDownload(
    f.input,
    async (source) => {
      await collect(source);
      consumed.resolve();
      await release.promise;
      return "processed";
    },
    { ...f.dependencies, downloadTimer: time.downloadTimer },
  ).finally(() => {
    settled = true;
  });
  await consumed.promise;
  expect(settled).toBe(false);
  expect(time.timers.every((timer) => !timer.active)).toBe(true);
  release.resolve();
  expect(await work).toBe("processed");
});

test("resuming a backpressured response rearms the idle deadline even without more server data", async () => {
  const f = setup();
  const time = clock();
  const chunk = Buffer.alloc(64 * 1024, 42);
  const delivered = chunk.length * 4;
  f.fixture.blobs.set(
    "blob-one",
    Array.from({ length: 128 }, () => chunk),
  );
  f.fixture.download.afterChunk = async (index) => {
    if (index === 3) await new Promise(() => {});
  };
  const paused = Promise.withResolvers<void>();
  const rearmed = Promise.withResolvers<void>();
  let waitingForServer = false;
  const factory = f.dependencies.request;
  if (!factory) throw new Error("Missing test factory");
  await expect(
    consumeJmapDownload(
      { ...f.input, maxBytes: chunk.length * 128 },
      async (source) => {
        await paused.promise;
        expect(time.timers.every((timer) => !timer.active)).toBe(true);
        time.advance(120_000);
        const drained = Promise.withResolvers<void>();
        let received = 0;
        source.on("data", (value: Buffer) => {
          received += value.length;
          if (received === delivered) drained.resolve();
        });
        const reading = collect(source);
        void reading.catch(drained.reject);
        await drained.promise;
        waitingForServer = true;
        const response = f.incoming();
        if (!response) throw new Error("Missing test response");
        // resume() changes isPaused() before its queued resume event rearms the timer.
        if (!time.timers.some((timer) => timer.active)) await rearmed.promise;
        expect(response.readableEnded).toBe(false);
        expect(time.timers.filter((timer) => timer.active).map((timer) => timer.milliseconds)).toEqual([60_000]);
        time.advance(60_001);
        return reading;
      },
      {
        ...f.dependencies,
        downloadTimer: (expire, milliseconds) => {
          const cancel = time.downloadTimer(expire, milliseconds);
          if (waitingForServer && milliseconds === 60_000) rearmed.resolve();
          return cancel;
        },
        request: (options, callback) =>
          factory(options, (response) => {
            response.once("pause", () => paused.resolve());
            callback(response);
          }),
      },
    ),
  ).rejects.toMatchObject({ code: "JMAP_TIMEOUT" });
  expect(f.outgoing()?.destroyed).toBe(true);
  expect(f.incoming()?.destroyed).toBe(true);
});

for (const reason of ["timeout", "abort"] as const) {
  test(`the first transport ${reason} wins over a subsequent consumer failure`, async () => {
    const f = setup();
    const time = clock();
    const followed = Promise.withResolvers<void>();
    const followup = Object.assign(new Error("Parser stopped after source failure"), { code: "HYDRATION_FAILED" });
    f.fixture.download.afterChunk = async () => new Promise(() => {});
    const work = consumeJmapDownload(
      f.input,
      async (source) => {
        const failed = once(source, "error");
        source.once("data", () => {
          if (reason === "abort") f.controller.abort();
          else time.expire();
        });
        await failed;
        followed.resolve();
        throw followup;
      },
      { ...f.dependencies, downloadTimer: time.downloadTimer },
    );
    await expect(work).rejects.toMatchObject({ code: reason === "abort" ? "JMAP_ABORTED" : "JMAP_TIMEOUT" });
    await followed.promise;
    await expect(work).rejects.not.toBe(followup);
    expect(f.outgoing()?.destroyed).toBe(true);
    expect(f.incoming()?.destroyed).toBe(true);
  });
}

test("a synchronous consumer failure keeps its identity unless the caller has aborted", async () => {
  for (const abort of [false, true]) {
    const f = setup();
    const failure = Object.assign(new Error("Transport changed"), { code: "MAILBOX_TRANSPORT_CHANGED" });
    const work = consumeJmapDownload(
      f.input,
      () => {
        if (abort) f.controller.abort();
        throw failure;
      },
      f.dependencies,
    );
    if (abort) await expect(work).rejects.toMatchObject({ code: "JMAP_ABORTED" });
    else await expect(work).rejects.toBe(failure);
    expect(f.outgoing()?.destroyed).toBe(true);
    expect(f.incoming()?.destroyed).toBe(true);
  }
});
