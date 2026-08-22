import { afterEach, describe, expect, test } from "bun:test";
import { parseAiSse, subscribeAiStream } from "./transport";

const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;

afterEach(() => {
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
});

describe("AI stream transport lifecycle", () => {
  test("parses split SSE chunks and ignores heartbeat comments", async () => {
    const encoder = new TextEncoder();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(': heartbeat\n\nevent: turn_started\ndata: {"v":1,"type":"turn_started","con'));
          controller.enqueue(
            encoder.encode(
              'versationId":"Chat01","turnId":"Turn01","attempt":1,"seq":1,"modelProfileId":"m","providerModel":"p"}\n\nevent: turn_finished\ndata: {"v":1,"type":"turn_finished","conversationId":"Chat01","turnId":"Turn01","attempt":1,"seq":2,"status":"completed","error":null}\n\n',
            ),
          );
          controller.close();
        },
      }),
    );
    const events = [];

    for await (const event of parseAiSse(response, new AbortController().signal)) events.push(event);

    expect(events.map((event) => event.type)).toEqual(["turn_started", "turn_finished"]);
  });

  test("emits nothing after close when an in-flight connection resolves late", async () => {
    let resolveFetch!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const statuses: string[] = [];
    const events: unknown[] = [];

    const stream = subscribeAiStream({
      url: "/stream",
      fetch: () => response,
      onStatus: (status) => statuses.push(status),
      onEvent: (event) => events.push(event),
    });

    expect(statuses).toEqual(["connecting"]);
    stream.close();
    resolveFetch(new Response(new ReadableStream(), { status: 200 }));
    await Promise.resolve();
    await Promise.resolve();

    expect(statuses).toEqual(["connecting"]);
    expect(events).toEqual([]);
  });

  test("abandons a stuck connection attempt and continues reconnecting", async () => {
    const timers: Array<{ callback: () => void; delay: number } | null> = [];
    globalThis.setTimeout = ((callback: () => void, delay = 0) => {
      timers.push({ callback, delay });
      return timers.length;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((id: number) => {
      timers[id - 1] = null;
    }) as typeof clearTimeout;

    const attempts: AbortSignal[] = [];
    const statuses: string[] = [];
    const stream = subscribeAiStream({
      url: "/stream",
      fetch: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init.signal!;
          attempts.push(signal);
          signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        }),
      onStatus: (status) => statuses.push(status),
      onEvent: () => undefined,
    });

    expect(attempts).toHaveLength(1);
    expect(timers[0]?.delay).toBe(10_000);
    timers[0]?.callback();
    await Promise.resolve();
    await Promise.resolve();

    const reconnectTimer = timers.find((timer) => timer?.delay === 500);
    expect(reconnectTimer).toBeDefined();
    reconnectTimer?.callback();
    await Promise.resolve();

    expect(attempts).toHaveLength(2);
    expect(statuses).toEqual(["connecting", "reconnecting"]);
    stream.close();
  });
});
