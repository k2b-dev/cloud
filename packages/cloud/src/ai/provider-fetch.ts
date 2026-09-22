import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Dates the provider response headers and the first body byte of the inference
 * call that is currently streaming, without touching the wire. nessi adapters
 * call the global `fetch`; the wrapper is installed once, on first use, and
 * only observes requests made inside `runWithProviderFetchMarks`.
 *
 * Nothing here logs: frames may carry reasoning text and headers carry keys.
 */
export type ProviderFetchMarks = { headersAt?: number; firstByteAt?: number };

const marks = new AsyncLocalStorage<ProviderFetchMarks>();
let installed = false;

export const runWithProviderFetchMarks = <T>(store: ProviderFetchMarks, run: () => Promise<T>): Promise<T> => {
  install();
  return marks.run(store, run);
};

const firstByteObserver = (store: ProviderFetchMarks) =>
  new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (chunk.byteLength > 0 && store.firstByteAt === undefined) store.firstByteAt = Date.now();
      controller.enqueue(chunk);
    },
  });

const install = (): void => {
  if (installed) return;
  installed = true;
  const realFetch = globalThis.fetch;
  const instrumented = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const store = marks.getStore();
    // Only the first request of a call is the provider request; nessi retries create a new call.
    if (store === undefined || store.headersAt !== undefined) return realFetch(input, init);
    const response = await realFetch(input, init);
    store.headersAt = Date.now();
    if (!response.body) return response;
    return new Response(response.body.pipeThrough(firstByteObserver(store)), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
  // Bun exposes helpers such as fetch.preconnect on the function object.
  for (const key of Object.keys(realFetch)) Object.defineProperty(instrumented, key, { value: (realFetch as never)[key] });
  globalThis.fetch = instrumented as typeof fetch;
};
