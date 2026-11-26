import { describe, expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";
import { createWebhookQueries, type WebhookQuerySource } from "./webhook-queries";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
};

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("Webhook tester owner-local queries", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }

  test("aborts stale URL-owned log reads and disposes the current owner", async () => {
    const dom = createDomTestHarness();
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; signal: AbortSignal; response: ReturnType<typeof deferred<Response>> }> = [];
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : null;
      const response = deferred<Response>();
      requests.push({ url: request?.url ?? String(input), signal: (init?.signal ?? request?.signal) as AbortSignal, response });
      return response.promise;
    }) as typeof fetch;

    let dispose: (() => void) | undefined;
    try {
      let setSource!: (source: WebhookQuerySource) => void;
      let controls!: ReturnType<typeof createWebhookQueries>;
      dispose = render(() => {
        const [source, updateSource] = createSignal<WebhookQuerySource>({
          mode: "receive",
          endpointId: null,
          method: null,
          query: "",
          requestId: null,
        });
        setSource = updateSource;
        controls = createWebhookQueries(source);
        return dom.document.createTextNode("");
      }, dom.root);
      await flush();
      const endpoints = requests.find((request) => request.url.includes("/endpoints"))!;
      const incoming = requests.find((request) => request.url.includes("/incoming-logs"))!;
      endpoints.response.resolve(Response.json({ items: [] }));
      await flush();

      setSource({ mode: "send", endpointId: null, method: null, query: "", requestId: null });
      await flush();
      expect(incoming.signal.aborted).toBe(true);
      const outgoing = requests.find((request) => request.url.includes("/outgoing-logs"))!;
      expect(outgoing).toBeDefined();
      expect(controls.logs.data()).toBeUndefined();

      dispose();
      dispose = undefined;
      expect(outgoing.signal.aborted).toBe(true);
    } finally {
      dispose?.();
      dom.cleanup();
      globalThis.fetch = originalFetch;
    }
  });

  test("does not project last-good logs under a new query source", async () => {
    const dom = createDomTestHarness();
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; response: ReturnType<typeof deferred<Response>> }> = [];
    globalThis.fetch = ((input: string | URL | Request) => {
      const request = input instanceof Request ? input : null;
      const response = deferred<Response>();
      requests.push({ url: request?.url ?? String(input), response });
      return response.promise;
    }) as typeof fetch;

    let dispose: (() => void) | undefined;
    try {
      let setSource!: (source: WebhookQuerySource) => void;
      let controls!: ReturnType<typeof createWebhookQueries>;
      dispose = render(() => {
        const [source, updateSource] = createSignal<WebhookQuerySource>({
          mode: "receive",
          endpointId: null,
          method: null,
          query: "",
          requestId: null,
        });
        setSource = updateSource;
        controls = createWebhookQueries(source);
        return dom.document.createTextNode("");
      }, dom.root);
      await flush();
      requests.find((request) => request.url.includes("/endpoints"))!.response.resolve(Response.json({ items: [] }));
      requests.find((request) => request.url.includes("/incoming-logs"))!.response.resolve(Response.json({ items: [{ id: "old" }] }));
      for (let attempt = 0; attempt < 10 && !controls.logs.data(); attempt++) await flush();
      expect(controls.logs.data()?.map((log) => log.id)).toEqual(["old"]);

      setSource({ mode: "send", endpointId: null, method: null, query: "", requestId: null });
      await flush();
      expect(controls.logs.refreshing()).toBe(true);
      expect(controls.logs.data()).toBeUndefined();
    } finally {
      dispose?.();
      dom.cleanup();
      globalThis.fetch = originalFetch;
    }
  });
});
