import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { createPacedUploadRequest } from "./upload-pacing";

const originalFetch = globalThis.fetch;
const OriginalRequest = globalThis.Request;
const realNow = performance.now.bind(performance);
let clock = 0;
let restore = () => {};
beforeEach(() => {
  clock = 0;
  globalThis.Request = class extends OriginalRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      if (init) Reflect.get(init, "duplex");
      super(input, init);
    }
  };
  const time = spyOn(performance, "now").mockImplementation(() => realNow() + clock);
  restore = () => time.mockRestore();
});
afterEach(() => {
  restore();
  globalThis.fetch = originalFetch;
  globalThis.Request = OriginalRequest;
});
const bytes = new Blob([new Uint8Array(128 * 1024)]);
const put = (request: typeof fetch, body = bytes, signal?: AbortSignal) =>
  request("https://files.test/part", { method: "PUT", body, signal });
function transport(handler: (init?: RequestInit) => Promise<Response>) {
  globalThis.fetch = Object.assign(async (_input: RequestInfo | URL, init?: RequestInit) => handler(init), {
    preconnect: originalFetch.preconnect,
  });
}

async function consume(body: RequestInit["body"], delayed = false) {
  if (!(body instanceof ReadableStream)) throw new Error("Expected paced bytes");
  const reader = body.getReader();
  let size = 0;
  for (;;) {
    const item = await reader.read();
    if (item.done) return size;
    size += item.value.byteLength;
    if (delayed && size < bytes.size) await Bun.sleep(100);
  }
}

test("calibrates with a Blob, preserves bytes and does not decay on timer-delayed paced samples", async () => {
  const samples: number[] = [];
  let calls = 0;
  transport(async (init) => {
    calls++;
    if (calls === 1) {
      expect(init?.body).toBe(bytes);
      clock += 1000;
    } else {
      const started = performance.now();
      expect(await consume(init?.body, true)).toBe(bytes.size);
      // A busy/background tab can take longer without any bottleneck queue.
      // This delay precedes the last enqueue, rather than an ACK tail.
      samples.push(performance.now() - started);
    }
    return new Response(null, { status: 204 });
  });
  const request = createPacedUploadRequest();
  await put(request);
  await put(request);
  await put(request);
  expect(samples).toHaveLength(2);
  expect(samples[0]).toBeGreaterThanOrEqual(1000 / 0.85);
  expect(Math.abs(samples[1]! - samples[0]!)).toBeLessThan(250);
}, 10_000);

test("a bottleneck ACK tail lowers the next target; failed responses do not calibrate", async () => {
  const durations: number[] = [];
  let calls = 0;
  transport(async (init) => {
    calls++;
    if (calls === 1) {
      clock += 5000;
      return new Response(null, { status: 503 });
    }
    if (calls === 2) {
      expect(init?.body).toBe(bytes);
      clock += 1000;
    } else {
      const started = performance.now();
      await consume(init?.body);
      durations.push(performance.now() - started);
      if (calls === 4) clock += 1500;
    }
    return new Response(null, { status: 204 });
  });
  const request = createPacedUploadRequest();
  await put(request);
  await put(request);
  await put(request);
  await put(request);
  await put(request);
  expect(durations[2]).toBeGreaterThan(durations[1]! * 1.4);
  expect(durations[2]).toBeLessThan(2500); // Never pace below the supported 64 KiB/s.
}, 10_000);

test("a streaming TypeError leaves the bounded SDK retry a fresh replayable Blob", async () => {
  let calls = 0;
  const failure = new TypeError("HTTP/1.1 streaming unavailable");
  transport(async (init) => {
    calls++;
    if (calls === 1) clock += 1000;
    if (calls === 2) {
      expect(init?.body).toBeInstanceOf(ReadableStream);
      throw failure;
    }
    if (calls >= 3) {
      expect(init?.body).toBe(bytes);
      clock += 1000;
    }
    return new Response(null, { status: 204 });
  });
  const request = createPacedUploadRequest();
  await request("https://http1.files.test/part", { method: "PUT", body: bytes });
  await expect(request("https://http1.files.test/part", { method: "PUT", body: bytes })).rejects.toBe(failure);
  expect(calls).toBe(2); // No nested retries in the transport adapter.
  await request("https://http1.files.test/part", { method: "PUT", body: bytes });
  expect(calls).toBe(3);
  const next = createPacedUploadRequest();
  await next("https://http1.files.test/part", { method: "PUT", body: bytes });
  await next("https://http1.files.test/part", { method: "PUT", body: bytes });
  expect(calls).toBe(5);
});

test("cancellation stops a paced pull without offering another part", async () => {
  const controller = new AbortController();
  const reason = new DOMException("cancelled", "AbortError");
  let calls = 0;
  transport(async (init) => {
    calls++;
    if (calls === 1) clock += 1000;
    else {
      const consumed = consume(init?.body);
      const timer = setTimeout(() => controller.abort(reason), 5);
      try {
        await consumed;
      } finally {
        clearTimeout(timer);
      }
    }
    return new Response(null, { status: 204 });
  });
  const request = createPacedUploadRequest();
  await put(request);
  await expect(put(request, bytes, controller.signal)).rejects.toBe(reason);
  expect(calls).toBe(2);
});

test("subsecond parts and non-PUT requests remain unchanged", async () => {
  transport(async (init) => {
    if (init?.method === "PUT") expect(init.body).toBe(bytes);
    clock += 100;
    return new Response();
  });
  const request = createPacedUploadRequest();
  await request("https://files.test/status");
  await put(request);
  await put(request);
});

test("a browser that does not consume duplex keeps Blob bodies", async () => {
  globalThis.Request = OriginalRequest;
  transport(async (init) => {
    expect(init?.body).toBe(bytes);
    clock += 1000;
    return new Response();
  });
  const request = createPacedUploadRequest();
  await put(request);
  await put(request);
});

test("constant slow server acknowledgements cannot repeatedly reduce upload speed", async () => {
  let calls = 0;
  const durations: number[] = [];
  transport(async (init) => {
    calls++;
    if (calls === 1) clock += 1000;
    else {
      const start = performance.now();
      await consume(init?.body);
      durations.push(performance.now() - start);
      clock += 600; // Slow fsync on every PUT, without a growing queue.
    }
    return new Response();
  });
  const request = createPacedUploadRequest();
  for (let i = 0; i < 4; i++) await put(request);
  expect(Math.max(...durations) - Math.min(...durations)).toBeLessThan(250);
}, 10_000);

test("a delayed pacing timer releases the rest of the body instead of stalling", async () => {
  let calls = 0;
  transport(async (init) => {
    calls++;
    if (calls === 1) clock += 1000;
    else {
      const body = init?.body;
      if (!(body instanceof ReadableStream)) throw new Error("Expected stream");
      const reader = body.getReader();
      const start = performance.now();
      const pending = reader.read();
      // Simulate a timer that resumes a second later (hidden-tab batching).
      await Bun.sleep(5);
      clock += 1000;
      let size = (await pending).value?.byteLength ?? 0;
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.byteLength;
      }
      expect(size).toBe(bytes.size);
      expect(performance.now() - start).toBeLessThan(1500);
    }
    return new Response();
  });
  const request = createPacedUploadRequest();
  await put(request);
  await put(request);
});

test("a hidden tab retains Blob throughput without depending on pacing timers", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  let calls = 0;
  transport(async (init) => {
    calls++;
    expect(init?.body).toBe(bytes);
    clock += 1000;
    return new Response();
  });
  try {
    Object.defineProperty(globalThis, "document", { configurable: true, value: { hidden: true } });
    const request = createPacedUploadRequest();
    await put(request);
    await put(request);
    expect(calls).toBe(2);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "document", descriptor);
    else Reflect.deleteProperty(globalThis, "document");
  }
});
