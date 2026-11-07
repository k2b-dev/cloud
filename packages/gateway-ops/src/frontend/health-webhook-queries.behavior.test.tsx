import { describe, expect, test } from "bun:test";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";
import { createHealthWebhookQueries, type HealthWebhook } from "./health-webhook-queries";

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
};

const flush = async () => {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
};

const waitFor = async (condition: () => boolean, label: string) => {
  for (let index = 0; index < 50; index += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  if (!condition()) throw new Error(`Timed out waiting for ${label}`);
};

const webhook = (name: string): HealthWebhook => ({
  id: "00000000-0000-4000-8000-000000000001",
  name,
  url: "https://example.com/health",
  method: "POST",
  enabled: true,
  scopeKind: "all",
  scopeAppIds: [],
  sendOn: ["error", "recovery"],
  minStatus: "error",
  repeatIntervalMs: 1_800_000,
  timeoutMs: 5000,
  lastStatus: null,
  lastSentAt: null,
  lastError: null,
});

describe("Gateway health webhook queries", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }

  test("keeps last-good webhooks across a failed invalidation and aborts on disposal", async () => {
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
      let queries!: ReturnType<typeof createHealthWebhookQueries>;
      dispose = render(() => {
        queries = createHealthWebhookQueries();
        return null;
      }, dom.root);
      await flush();

      expect(requests).toHaveLength(3);
      requests
        .find((request) => request.url.endsWith("/health/webhooks"))!
        .response.resolve(
          new Response(JSON.stringify([webhook("Initial")]), { status: 200, headers: { "Content-Type": "application/json" } }),
        );
      requests
        .find((request) => request.url.endsWith("/settings"))!
        .response.resolve(new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } }));
      requests
        .find((request) => request.url.endsWith("/health"))!
        .response.resolve(new Response(JSON.stringify({ apps: [] }), { status: 200, headers: { "Content-Type": "application/json" } }));
      await flush();
      expect(queries.webhooks.data()?.[0]?.name).toBe("Initial");

      const invalidation = queries.webhooks.invalidate();
      await flush();
      requests[3]!.response.resolve(new Response(JSON.stringify({ message: "offline" }), { status: 503 }));
      await expect(invalidation).rejects.toThrow("offline");
      expect(queries.webhooks.data()?.[0]?.name).toBe("Initial");
      expect(queries.webhooks.error()?.message).toBe("offline");

      const refresh = queries.webhooks.refresh();
      await flush();
      requests[4]!.response.resolve(
        new Response(JSON.stringify([webhook("Fresh")]), { status: 200, headers: { "Content-Type": "application/json" } }),
      );
      await refresh;
      expect(queries.webhooks.data()?.[0]?.name).toBe("Fresh");

      const pending = queries.health.refresh();
      await flush();
      const pendingRequest = requests[5]!;
      dispose();
      dispose = undefined;
      expect(pendingRequest.signal.aborted).toBe(true);
      pendingRequest.response.reject(new DOMException("Aborted", "AbortError"));
      await pending;
    } finally {
      dispose?.();
      globalThis.fetch = originalFetch;
      dom.cleanup();
    }
  });

  test("retries only reconciliation after a persisted webhook write", async () => {
    const dom = createDomTestHarness();
    const { WebhookEditor } = await import("./webhook-editor");
    const originalFetch = globalThis.fetch;
    const write = deferred<Response>();
    let writeCount = 0;
    globalThis.fetch = (() => {
      writeCount += 1;
      return write.promise;
    }) as unknown as typeof fetch;
    const firstReconciliation = deferred<void>();
    let reconciliationCount = 0;
    let closeCount = 0;
    const onSaved = () => {
      reconciliationCount += 1;
      return reconciliationCount === 1 ? firstReconciliation.promise : Promise.resolve();
    };

    let dispose: (() => void) | undefined;
    try {
      dispose = render(() => <WebhookEditor apps={[]} close={() => (closeCount += 1)} onSaved={onSaved} />, dom.root);
      const form = dom.root.querySelector("form")!;
      form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event);
      await waitFor(() => writeCount === 1, "the webhook write");
      expect(writeCount).toBe(1);

      write.resolve(new Response(JSON.stringify(webhook("Saved")), { status: 200, headers: { "Content-Type": "application/json" } }));
      await waitFor(() => reconciliationCount === 1, "the first reconciliation");
      expect(reconciliationCount).toBe(1);
      expect(closeCount).toBe(0);

      firstReconciliation.reject(new Error("reload failed"));
      await waitFor(() => dom.root.textContent?.includes("Retry refresh") ?? false, "the reconciliation error");
      const retry = Array.from(dom.root.querySelectorAll("button")).find((button) => button.textContent?.includes("Retry refresh"));
      expect(retry).toBeDefined();
      retry!.click();
      await waitFor(() => reconciliationCount === 2, "the reconciliation retry");
      await flush();
      expect({ closeCount, reconciliationCount, writeCount }).toEqual({ closeCount: 1, reconciliationCount: 2, writeCount: 1 });
    } finally {
      dispose?.();
      globalThis.fetch = originalFetch;
      dom.cleanup();
    }
  });

  test("aborts a pending editor write and ignores its late response after disposal", async () => {
    const dom = createDomTestHarness();
    const { WebhookEditor } = await import("./webhook-editor");
    const originalFetch = globalThis.fetch;
    const write = deferred<Response>();
    let writeSignal: AbortSignal | undefined;
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : null;
      writeSignal = (init?.signal ?? request?.signal) as AbortSignal;
      return write.promise;
    }) as typeof fetch;
    let reconciliationCount = 0;
    let closeCount = 0;

    let dispose: (() => void) | undefined;
    try {
      dispose = render(
        () => (
          <WebhookEditor
            apps={[]}
            close={() => (closeCount += 1)}
            onSaved={() => {
              reconciliationCount += 1;
              return Promise.resolve();
            }}
          />
        ),
        dom.root,
      );
      const form = dom.root.querySelector("form")!;
      form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event);
      await waitFor(() => writeSignal !== undefined, "the pending webhook write");
      dispose();
      dispose = undefined;
      expect(writeSignal?.aborted).toBe(true);

      write.resolve(new Response(JSON.stringify(webhook("Late")), { status: 200, headers: { "Content-Type": "application/json" } }));
      await flush();
      expect(reconciliationCount).toBe(0);
      expect(closeCount).toBe(0);
    } finally {
      dispose?.();
      globalThis.fetch = originalFetch;
      dom.cleanup();
    }
  });
});
