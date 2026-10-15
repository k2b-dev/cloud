import { afterEach, expect, spyOn, test } from "bun:test";
import { createServer, type Socket } from "node:net";
import { FilegateError } from "@k2b/filegate/utils";
import type { UploadSession } from "./contracts";
import { transferUpload, UploadTransferError } from "./upload-transfer";

const nativeFetch = globalThis.fetch;
const nativeTimeout = AbortSignal.timeout;
let restoreTimeout = () => {};
const controllers: AbortController[] = [];
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.abort();
  restoreTimeout();
  globalThis.fetch = nativeFetch;
});
const session: UploadSession = {
  id: "upload",
  path: "file",
  size: 0,
  chunkSize: 8 * 1024 * 1024,
  state: "open",
  url: "https://filegate.test/lease-secret",
  expires: "2099-01-01",
};

test("SDK transport retry budget is not multiplied by the application", async () => {
  let requests = 0,
    renews = 0;
  globalThis.fetch = Object.assign(
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests++;
      expect(init?.credentials).toBe("omit");
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      return Response.json({ error: "busy", message: "lease-secret" }, { status: 503, headers: { "Retry-After": "0" } });
    },
    { preconnect: nativeFetch.preconnect },
  );
  await expect(
    transferUpload(new Blob([]), session, {
      signal: new AbortController().signal,
      renew: async () => {
        renews++;
        return { url: session.url! };
      },
      failure: "Upload failed",
    }),
  ).rejects.toThrow("Upload failed");
  expect(requests).toBe(3);
  expect(renews).toBe(0);
});

test("long Retry-After returns control without an application retry", async () => {
  let requests = 0;
  globalThis.fetch = Object.assign(
    async () => {
      requests++;
      return Response.json({ error: "busy" }, { status: 429, headers: { "Retry-After": "5" } });
    },
    { preconnect: nativeFetch.preconnect },
  );
  await expect(
    transferUpload(new Blob([]), session, {
      signal: new AbortController().signal,
      renew: async () => {
        throw new Error("must not renew");
      },
      failure: "Upload failed",
    }),
  ).rejects.toThrow("Upload failed");
  expect(requests).toBe(1);
});

test("a committed creation replay requires no lease or transfer", async () => {
  globalThis.fetch = Object.assign(
    async () => {
      throw new Error("must not fetch");
    },
    { preconnect: nativeFetch.preconnect },
  );
  const { url: _url, ...terminal } = session;
  await transferUpload(
    new Blob([]),
    { ...terminal, state: "committed" },
    {
      signal: new AbortController().signal,
      renew: async () => {
        throw new Error("must not renew");
      },
      failure: "Upload failed",
    },
  );
});

function options() {
  const controller = new AbortController();
  controllers.push(controller);
  return {
    signal: controller.signal,
    renew: async () => {
      throw new Error("must not renew");
    },
    failure: "Upload failed",
  };
}
function shortenDeadlines() {
  const deadlines: number[] = [];
  const spy = spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    deadlines.push(ms);
    return nativeTimeout(40);
  });
  restoreTimeout = () => spy.mockRestore();
  return deadlines;
}
function mockFetch(request: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  globalThis.fetch = Object.assign(request, { preconnect: nativeFetch.preconnect });
}
function pendingResponse(signal?: AbortSignal | null): Promise<Response> {
  return new Promise((_, reject) => {
    signal?.throwIfAborted();
    // Some runtimes reject an aborted fetch with a generic AbortError.
    signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  });
}
const status = (size: number, received = 0) => ({
  id: session.id,
  root: "cloud",
  size,
  chunkSize: session.chunkSize,
  expires: session.expires,
  state: "open",
  uploadedSegments: 0,
  received,
});
async function transferError(run: Promise<void>): Promise<UploadTransferError> {
  try {
    await run;
  } catch (error) {
    expect(error).toBeInstanceOf(UploadTransferError);
    if (error instanceof UploadTransferError) return error;
    throw error;
  }
  throw new Error("Expected transfer failure");
}

test.each(["status", "segments", "PUT"])("a stalled %s request ends the transfer after one attempt", async (target) => {
  const deadlines = shortenDeadlines();
  const file = new Blob([new Uint8Array(8 * 1024 * 1024)]);
  const requests: string[] = [];
  mockFetch(async (input, init) => {
    const kind = init?.method === "PUT" ? "PUT" : new URL(String(input)).searchParams.has("segments") ? "segments" : "status";
    requests.push(kind);
    if (kind === target) return pendingResponse(init?.signal);
    return Response.json(kind === "segments" ? { items: [] } : status(file.size));
  });
  const error = await transferError(transferUpload(file, { ...session, size: file.size }, options()));
  expect(error.kind).toBe("stalled");
  expect(error.message).toBe("Upload failed");
  expect(error.cause).toBeInstanceOf(DOMException);
  expect(error.cause).toHaveProperty("name", "TimeoutError");
  expect(requests.filter((kind) => kind === target)).toHaveLength(1);
  expect(deadlines).toEqual(target === "PUT" ? [30_000, 30_000, 188_000] : target === "segments" ? [30_000, 30_000] : [30_000]);
});

test("response headers with a stalled body end the transfer after one attempt", async () => {
  shortenDeadlines();
  let requests = 0;
  mockFetch(async (_input, init) => {
    requests++;
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"state":'));
          init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true });
        },
      }),
    );
  });
  const error = await transferError(transferUpload(new Blob([]), session, options()));
  expect(error.kind).toBe("stalled");
  expect(error.cause).toHaveProperty("name", "TimeoutError");
  expect(requests).toBe(1);
});

test("a finished request's deadline cannot abort a later request", async () => {
  const deadlines: AbortController[] = [];
  const spy = spyOn(AbortSignal, "timeout").mockImplementation(() => {
    const controller = new AbortController();
    deadlines.push(controller);
    return controller.signal;
  });
  restoreTimeout = () => spy.mockRestore();
  const segmentsStarted = Promise.withResolvers<void>();
  const segmentsResponse = Promise.withResolvers<Response>();
  let segmentsSignal: AbortSignal | null | undefined;
  mockFetch(async (input, init) => {
    if (new URL(String(input)).searchParams.has("segments")) {
      segmentsSignal = init?.signal;
      segmentsStarted.resolve();
      return segmentsResponse.promise;
    }
    return Response.json(status(1, init?.method === "PUT" ? 1 : 0));
  });
  const run = transferUpload(new Blob(["a"]), { ...session, size: 1 }, options());
  await segmentsStarted.promise;
  deadlines[0]!.abort(new DOMException("Status deadline", "TimeoutError"));
  expect(segmentsSignal?.aborted).toBe(false);
  segmentsResponse.resolve(Response.json({ items: [] }));
  await expect(run).resolves.toBeUndefined();
  expect(deadlines).toHaveLength(3);
});

test.each([
  { code: 503, body: "upload_capacity", header: "0", kind: "busy", attempts: 3, retryAfter: 0 },
  { code: 429, body: "busy", header: "5", kind: "busy", attempts: 1, retryAfter: 5000 },
  { code: 408, body: "timeout", header: null, kind: "busy", attempts: 1, retryAfter: undefined },
  { code: 500, body: "server_error", header: "invalid", kind: "busy", attempts: 1, retryAfter: undefined },
  { code: 400, body: "bad_request", header: null, kind: "final", attempts: 1, retryAfter: undefined },
])("HTTP $code is $kind after $attempts attempts", async ({ code, body, header, kind, attempts, retryAfter }) => {
  let requests = 0;
  mockFetch(async () => {
    requests++;
    return Response.json({ error: body }, { status: code, headers: header === null ? {} : { "Retry-After": header } });
  });
  const error = await transferError(transferUpload(new Blob([]), session, options()));
  expect(error.kind).toBe(kind);
  expect(error.retryAfter).toBe(retryAfter);
  expect(error.cause).toBeInstanceOf(FilegateError);
  expect(requests).toBe(attempts);
});

test.each([204, 205, 304])("an empty HTTP %s response is buffered without retrying a constructor error", async (code) => {
  let requests = 0;
  mockFetch(async () => {
    requests++;
    return new Response(null, { status: code });
  });
  const error = await transferError(transferUpload(new Blob([]), session, options()));
  expect(error.kind).toBe("final");
  expect(requests).toBe(1);
});

test("Retry-After HTTP dates are retained in milliseconds", async () => {
  const now = spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 9, 15));
  try {
    mockFetch(async () => Response.json({ error: "busy" }, { status: 429, headers: { "Retry-After": "Thu, 15 Oct 2026 00:00:05 GMT" } }));
    const error = await transferError(transferUpload(new Blob([]), session, options()));
    expect(error.kind).toBe("busy");
    expect(error.retryAfter).toBe(5000);
  } finally {
    now.mockRestore();
  }
});

test("a fetch TypeError is a network failure with the original cause", async () => {
  const cause = new TypeError("Connection failed");
  let requests = 0;
  mockFetch(async () => {
    requests++;
    throw cause;
  });
  const error = await transferError(transferUpload(new Blob([]), session, options()));
  expect(error.kind).toBe("network");
  expect(error.cause).toBe(cause);
  expect(requests).toBe(3);
});

test.each(["not a URL", "ftp://filegate.test/lease", "https://user:secret@filegate.test/lease"])(
  "an invalid lease %s is final without a request",
  async (url) => {
    let requests = 0;
    mockFetch(async () => {
      requests++;
      throw new Error("must not fetch");
    });
    const error = await transferError(transferUpload(new Blob([]), { ...session, url }, options()));
    expect(error.kind).toBe("final");
    expect(requests).toBe(0);
  },
);

test.each(["expired", "missing URL", "size mismatch", "received mismatch", "contents differ", "invalid page", "unknown"])(
  "%s remains a final failure",
  async (failure) => {
    const file = new Blob(["a"]);
    mockFetch(async (input, init) => {
      if (failure === "unknown") throw new Error("Unknown failure");
      if (new URL(String(input)).searchParams.has("segments")) {
        return Response.json(
          failure === "contents differ" ? { items: [{ index: 0, hash: "sha256:wrong" }] } : failure === "invalid page" ? {} : { items: [] },
        );
      }
      return Response.json(status(failure === "size mismatch" ? 2 : 1, init?.method === "PUT" && failure !== "received mismatch" ? 1 : 0));
    });
    const opened = {
      ...session,
      size: 1,
      ...(failure === "expired" ? { state: "expired" as const } : {}),
      ...(failure === "missing URL" ? { url: undefined } : {}),
    };
    const error = await transferError(transferUpload(file, opened, options()));
    expect(error.kind).toBe("final");
    expect(error.message).toBe("Upload failed");
    expect(error.cause).toBeInstanceOf(Error);
  },
);

test("expired capabilities renew at most three times, then fail as final", async () => {
  let renews = 0;
  const opts = options();
  mockFetch(async () => Response.json({ error: "expired_capability" }, { status: 401 }));
  const error = await transferError(
    transferUpload(new Blob([]), session, {
      ...opts,
      renew: async (_id, signal) => {
        renews++;
        expect(signal).not.toBe(opts.signal);
        return { url: session.url! };
      },
    }),
  );
  expect(error.kind).toBe("final");
  expect(renews).toBe(3);
  const cause = new Error("Renew failed");
  await expect(
    transferUpload(new Blob([]), session, {
      ...options(),
      renew: async () => {
        throw cause;
      },
    }),
  ).rejects.toBe(cause);
});

test("caller cancellation during PUT preserves its reason and starts no further request", async () => {
  const deadlines = shortenDeadlines();
  const controller = new AbortController();
  const cause = new DOMException("Cancelled by caller", "AbortError");
  let requests = 0;
  mockFetch(async (input, init) => {
    requests++;
    if (init?.method === "PUT") {
      const pending = pendingResponse(init.signal);
      controller.abort(cause);
      return pending;
    }
    return Response.json(new URL(String(input)).searchParams.has("segments") ? { items: [] } : status(1));
  });
  const run = transferUpload(new Blob(["a"]), { ...session, size: 1 }, { ...options(), signal: controller.signal });
  await expect(run).rejects.toBe(cause);
  await expect(run).rejects.not.toBeInstanceOf(UploadTransferError);
  expect(deadlines).toEqual([30_000, 30_000, 60_000 + 1000 / (64 * 1024)]);
  await Bun.sleep(300);
  expect(requests).toBe(3);
  await expect(transferUpload(new Blob([]), session, { ...options(), signal: controller.signal })).rejects.toBe(cause);
  expect(requests).toBe(3);
});

test("Bun fetch aborts a real server that accepts PUT bytes but never responds", async () => {
  shortenDeadlines();
  const sockets = new Set<Socket>();
  let stop = () => {};
  let puts = 0;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    let buffered = Buffer.alloc(0);
    socket.on("data", (data) => {
      buffered = Buffer.concat([buffered, typeof data === "string" ? Buffer.from(data) : data]);
      const end = buffered.indexOf("\r\n\r\n");
      if (end < 0) return;
      const headers = buffered.subarray(0, end).toString();
      const length = Number(/content-length: (\d+)/i.exec(headers)?.[1] ?? 0);
      if (buffered.length < end + 4 + length) return;
      if (headers.startsWith("PUT ")) {
        puts++;
        // Consume the whole body and leave the response pending.
        socket.removeAllListeners("data");
        return;
      }
      const json = JSON.stringify(headers.split("\r\n")[0]!.includes("segments=") ? { items: [] } : status(3));
      socket.end(
        `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(json)}\r\nConnection: close\r\n\r\n${json}`,
      );
    });
  });
  const controller = new AbortController();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const watchdog = setTimeout(() => controller.abort(new DOMException("Test deadline", "AbortError")), 4000);
    stop = () => clearTimeout(watchdog);
    const started = performance.now();
    const error = await transferError(
      transferUpload(
        new Blob(["abc"]),
        { ...session, size: 3, url: `http://127.0.0.1:${address.port}/lease` },
        { ...options(), signal: controller.signal },
      ),
    );
    expect(error.kind).toBe("stalled");
    expect(error.cause).toBeInstanceOf(DOMException);
    expect(error.cause).toHaveProperty("name", "TimeoutError");
    expect(performance.now() - started).toBeLessThan(5000);
    expect(puts).toBe(1);
  } finally {
    stop();
    controller.abort();
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("every direct Filegate transfer uses transferUpload's deadline request function", async () => {
  const root = new URL("./", import.meta.url).pathname;
  const owners: string[] = [];
  for await (const path of new Bun.Glob("**/*.{ts,tsx}").scan(root)) {
    if (/\.test\./.test(path)) continue;
    const source = await Bun.file(`${root}${path}`).text();
    if (/new DirectSession\s*\(/.test(source)) {
      owners.push(path);
      expect(source, "Every direct Filegate transfer must go through transferUpload's deadline request function").toMatch(
        /new DirectSession\(url, request\)/,
      );
    }
  }
  expect(owners, "Every direct Filegate transfer must go through transferUpload's deadline request function").toEqual([
    "upload-transfer.ts",
  ]);
});
