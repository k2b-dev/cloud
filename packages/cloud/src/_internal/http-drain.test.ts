import { expect, test } from "bun:test";
import { createHttpDrain } from "./http-drain";

test("drain closes admission before completing active responses", async () => {
  const drain = createHttpDrain();
  let finish: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const server = Bun.serve({
    port: 0,
    fetch: (req, server) =>
      drain.fetch(req, server, async () => {
        await held;
        return new Response("finished");
      }),
  });
  try {
    const request = fetch(server.url);
    while (server.pendingRequests === 0) await Bun.sleep(1);
    const stopped = drain.stop();
    expect(drain.stopping).toBe(true);
    let called = false;
    const ready = await drain.fetch(new Request(server.url), undefined, () => {
      called = true;
      return new Response("ready");
    });
    expect(ready.status).toBe(503);
    expect(called).toBe(false);
    finish();
    expect(await (await request).text()).toBe("finished");
    await stopped;
    await expect(fetch(server.url)).rejects.toThrow();
  } finally {
    finish();
    await server.stop(true);
  }
});

test("deadline aborts an open stream and request work before dependencies stop", async () => {
  const drain = createHttpDrain({ timeoutMs: 25 });
  let signal: AbortSignal | undefined;
  const server = Bun.serve({
    port: 0,
    fetch: (req, server) =>
      drain.fetch(req, server, (request) => {
        signal = request.signal;
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("open"));
            },
          }),
        );
      }),
  });
  try {
    const response = await fetch(server.url);
    const reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    const rest = reader.read().catch(() => ({ done: true }));
    await drain.stop();
    expect(signal?.aborted).toBe(true);
    await rest;
  } finally {
    await server.stop(true);
  }
});
