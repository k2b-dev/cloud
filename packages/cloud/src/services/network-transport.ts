import type { ClientRequest, IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";

/** Stop waiting even when a resolver cannot cancel its underlying DNS work. */
export const awaitNetworkOperation = <T>(work: Promise<T>, signal: AbortSignal): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", abort);
    const abort = () => {
      cleanup();
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    work.then(
      (value) => {
        cleanup();
        if (signal.aborted) reject(signal.reason);
        else resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
    if (signal.aborted) abort();
  });

/** One caller-owned budget, shared by lookup, address attempts, redirects and body reads. */
export const withNetworkDeadline = async <T>(
  timeoutMs: number,
  callerSignal: AbortSignal | undefined,
  timeoutError: Error,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> => {
  const controller = new AbortController();
  const abort = () => controller.abort(callerSignal?.reason);
  callerSignal?.addEventListener("abort", abort, { once: true });
  if (callerSignal?.aborted) abort();
  const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs);
  try {
    controller.signal.throwIfAborted();
    return await awaitNetworkOperation(work(controller.signal), controller.signal);
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", abort);
  }
};

export type NetworkRequestFactory = (options: RequestOptions, callback: (response: IncomingMessage) => void) => ClientRequest;

/** Lifecycle for already validated/pinned request options. Does not resolve or authorize targets. */
export const readNetworkResponse = <T>(input: {
  request: NetworkRequestFactory;
  options: RequestOptions;
  signal: AbortSignal;
  body?: Uint8Array;
  read: (response: IncomingMessage, resolve: (value: T) => void, reject: (error: Error) => void) => void;
}): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    input.signal.throwIfAborted();
    let settled = false;
    let outgoing: ClientRequest | undefined;
    let incoming: IncomingMessage | undefined;
    const finish = (result: { value: T } | { error: Error }) => {
      if (settled) return;
      settled = true;
      input.signal.removeEventListener("abort", abort);
      // Discarded bodies must never be drained after the operation has settled.
      incoming?.destroy();
      outgoing?.destroy();
      if ("error" in result) reject(result.error);
      else resolve(result.value);
    };
    const fail = (error: Error) => finish({ error });
    const abort = () => fail(input.signal.reason);
    input.signal.addEventListener("abort", abort, { once: true });
    try {
      outgoing = input.request(input.options, (response) => {
        incoming = response;
        response.on("error", fail);
        response.once("aborted", () => fail(new Error("Network response was aborted")));
        if (settled) {
          response.destroy();
          return;
        }
        try {
          input.read(response, (value) => finish({ value }), fail);
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      });
      outgoing.on("error", fail);
      if (settled || input.signal.aborted) {
        if (input.signal.aborted) abort();
        outgoing.destroy();
      } else outgoing.end(input.body);
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  });
