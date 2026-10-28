import { AppPwaError, pwaFail } from "./contracts";

/** Shared by body reads and the whole transport: stalled cancellation hooks never hold the response open. */
export const untilAppPwaAbort = async <T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> => {
  let abort = () => {};
  const stopped = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new AppPwaError("UNAVAILABLE", 503));
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    if (signal.aborted) return pwaFail("UNAVAILABLE", 503);
    return await Promise.race([work(), stopped]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
};

export const readAppPwaJson = async (request: Request, maxBytes: number, signal: AbortSignal): Promise<unknown> => {
  const reader = request.body?.getReader();
  if (!reader) return pwaFail("INVALID_INPUT", 400);
  let finished = false;
  try {
    return await untilAppPwaAbort(signal, async () => {
      const declared = request.headers.get("content-length");
      if (declared !== null && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)))) pwaFail("INVALID_INPUT", 400);
      if (declared !== null && Number(declared) > maxBytes) pwaFail("TOO_LARGE", 413);
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const next = await reader.read();
        if (signal.aborted) pwaFail("UNAVAILABLE", 503);
        if (next.done) break;
        total += next.value.byteLength;
        if (total > maxBytes) pwaFail("TOO_LARGE", 413);
        chunks.push(next.value);
      }
      finished = true;
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      try {
        return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      } catch {
        return pwaFail("INVALID_INPUT", 400);
      }
    });
  } catch (error) {
    if (error instanceof AppPwaError) throw error;
    return pwaFail("INVALID_INPUT", 400);
  } finally {
    if (!finished) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
};
