import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Observes the provider request of the inference call that is currently
 * running, without touching the wire: when its headers and first body byte
 * arrived, whether the provider certainly did not process it, and how long a
 * rejecting provider asked the caller to wait. nessi adapters call the global
 * `fetch`; the wrapper is installed once, on first use, and only observes
 * requests made inside `runWithProviderFetchMarks`. Scopes nest, so an outer
 * retry policy and the inner per-call accounting each see the same request.
 *
 * Nothing here logs: frames may carry reasoning text and headers carry keys.
 */
export type ProviderFetchMarks = {
  headersAt?: number;
  firstByteAt?: number;
  /** The request never reached the provider, or the provider answered with a status that says it did not process it. */
  refused?: boolean;
  retryAfterMs?: number;
};

const scopes = new AsyncLocalStorage<readonly ProviderFetchMarks[]>();
let installed = false;

export const runWithProviderFetchMarks = <T>(store: ProviderFetchMarks, run: () => Promise<T>): Promise<T> => {
  install();
  return scopes.run([...(scopes.getStore() ?? []), store], run);
};

/** `retry-after-ms` (OpenAI) wins over the standard `retry-after` seconds or HTTP date. */
export const retryAfterMs = (headers: Headers, now = Date.now()): number | undefined => {
  const milliseconds = Number(headers.get("retry-after-ms")?.trim() || Number.NaN);
  if (Number.isFinite(milliseconds) && milliseconds >= 0) return milliseconds;
  const value = headers.get("retry-after")?.trim();
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds * 1_000 : undefined;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
};

/**
 * A client error, 503, or Anthropic's overloaded 529 says the provider did not
 * process the request. Other server errors, such as a gateway's 502 or 504, can
 * follow processing upstream.
 */
const refusedStatus = (status: number) => (status >= 400 && status < 500) || status === 503 || status === 529;

/** Bun's codes for a request that never left: no connection, or no address for the host. */
const unsentCodes = new Set(["ConnectionRefused", "ENOTFOUND"]);
const unsent = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" && unsentCodes.has(error.code);

const firstByteObserver = (stores: readonly ProviderFetchMarks[]) =>
  new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (chunk.byteLength > 0)
        for (const store of stores) {
          store.firstByteAt ??= Date.now();
        }
      controller.enqueue(chunk);
    },
  });

const install = (): void => {
  if (installed) return;
  installed = true;
  const realFetch = globalThis.fetch;
  const instrumented = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    // Only the first request of a scope is its provider request; a retry opens a new scope.
    const stores = (scopes.getStore() ?? []).filter((store) => store.headersAt === undefined);
    if (stores.length === 0) return realFetch(input, init);
    let response: Response;
    try {
      response = await realFetch(input, init);
    } catch (error) {
      // A reset, an abort, or a timeout can follow delivery, so only an unsent request counts as refused.
      if (unsent(error))
        for (const store of stores) {
          store.refused = true;
        }
      throw error;
    }
    const headersAt = Date.now();
    const wait = response.ok ? undefined : retryAfterMs(response.headers, headersAt);
    for (const store of stores) {
      store.headersAt = headersAt;
      store.refused = refusedStatus(response.status);
      if (wait !== undefined) store.retryAfterMs = wait;
    }
    if (!response.body) return response;
    return new Response(response.body.pipeThrough(firstByteObserver(stores)), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
  // Bun exposes helpers such as fetch.preconnect on the function object.
  for (const key of Object.keys(realFetch)) Object.defineProperty(instrumented, key, { value: (realFetch as never)[key] });
  globalThis.fetch = instrumented as typeof fetch;
};
