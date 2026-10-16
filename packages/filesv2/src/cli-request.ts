import { type CloudCliContext, cliText } from "@k2b/cloud/cli";

export const REQUEST_TIMEOUT_MS = 60_000;
type CloudResponse = Parameters<CloudCliContext["readJson"]>[0];

export function cloudRequestError(ctx: Pick<CloudCliContext, "options">, error: unknown): never {
  if (error instanceof DOMException && error.name === "TimeoutError")
    throw new Error(
      cliText(ctx, {
        en: "No response from Cloud within 60 seconds.",
        de: "Keine Antwort von Cloud innerhalb von 60 Sekunden.",
      }),
    );
  throw error;
}

/**
 * Reads a Cloud response that ran under `signal`. `readJson` turns an unreadable body into `null`,
 * so a deadline that fires while the body streams is checked after reading.
 */
export async function readWithin<T>(
  ctx: Pick<CloudCliContext, "readJson">,
  signal: AbortSignal,
  response: Promise<CloudResponse>,
): Promise<T> {
  const result = await ctx.readJson<T>(await response);
  signal.throwIfAborted();
  return result;
}

/** One Cloud control request with the 60 s deadline, covering its response body. */
export async function cloudRequest<T>(
  ctx: Pick<CloudCliContext, "options" | "readJson">,
  send: (signal: AbortSignal) => Promise<CloudResponse>,
): Promise<T> {
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return readWithin<T>(ctx, signal, send(signal)).catch((error: unknown) => cloudRequestError(ctx, error));
}
