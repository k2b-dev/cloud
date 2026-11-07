import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { UPLOAD_BYTES } from "./engine";
import { createHttpTransport } from "./http";
import { createNodeTransport } from "./node";

const unusedUpload = async () => {};
test("HTTP errors never count their response bodies as throughput", async () => {
  let counted = 0;
  const transport = createHttpTransport(
    "https://example.com",
    unusedUpload,
    async () => new Response("limited", { status: 429, headers: { "retry-after": "60" } }),
  );
  await expect(
    transport.download(
      100,
      (bytes) => {
        counted += bytes;
      },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ status: 429, retryAfter: 60 });
  expect(counted).toBe(0);
});
test("HTTP transport omits Cloud credentials and counts each download chunk", async () => {
  const counted: number[] = [];
  const transport = createHttpTransport("https://example.com", unusedUpload, async (_url, init) => {
    expect(init?.credentials).toBe("omit");
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(7));
          controller.enqueue(new Uint8Array(11));
          controller.close();
        },
      }),
    );
  });
  await transport.download(18, (bytes) => counted.push(bytes), new AbortController().signal);
  expect(counted).toEqual([7, 11]);
});
test("native upload counts flowing bytes before request completion and respects socket backpressure", async () => {
  let received = 0;
  let sent = 0;
  let completed = false;
  const delays = new Set<ReturnType<typeof setTimeout>>();
  const server = createServer((request, response) => {
    request.on("data", (chunk: Buffer) => {
      received += chunk.byteLength;
      request.pause();
      const timer = setTimeout(() => {
        delays.delete(timer);
        request.resume();
      }, 40);
      delays.add(timer);
    });
    request.on("end", () => {
      completed = true;
      response.end("ok");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  const abort = new AbortController();
  const stop = setTimeout(() => abort.abort(), 250);
  try {
    const failure = await createNodeTransport(`http://127.0.0.1:${address.port}`)
      .upload(
        UPLOAD_BYTES,
        (bytes) => {
          sent += bytes;
        },
        abort.signal,
      )
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(completed).toBe(false);
    expect(received).toBeGreaterThan(0);
    expect(sent).toBeGreaterThan(0);
    expect(sent).toBeLessThan(UPLOAD_BYTES);
    // Both kernel socket queues can contain sent bytes before the server application reads them.
    // Other hosts use the documented 10 MiB combined TCP queue budget for this check.
    let socketBuffers = 10 * 1024 * 1024;
    try {
      socketBuffers = ["tcp_wmem", "tcp_rmem"].reduce(
        (sum, name) => sum + Number(readFileSync(`/proc/sys/net/ipv4/${name}`, "utf8").trim().split(/\s+/).at(-1)),
        0,
      );
    } catch {
      /* Non-Linux runner. */
    }
    expect(sent - received).toBeLessThanOrEqual(socketBuffers + 2 * 65_536);
  } finally {
    clearTimeout(stop);
    for (const timer of delays) clearTimeout(timer);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("Bun propagates a real download disconnect and releases the server slot", async () => {
  const { createSpeedtestHandler } = await import("./server");
  const handler = createSpeedtestHandler({ maxActive: 1, maxPeers: 4 });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => handler(request, "127.0.0.1") });
  const controller = new AbortController();
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/download`, { signal: controller.signal });
    const reader = response.body!.getReader();
    await reader.read();
    controller.abort();
    await reader.cancel().catch(() => {});
    let status = 429;
    for (let attempt = 0; attempt < 50 && status !== 204; attempt++) {
      status = (await fetch(`http://127.0.0.1:${server.port}/ping`)).status;
      if (status !== 204) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(status).toBe(204);
  } finally {
    controller.abort();
    await server.stop(true);
  }
});
