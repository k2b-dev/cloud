import { setTimeout as delay } from "node:timers/promises";
import { fail, type Result } from "@k2b/stdlib";

/** Leaves 15 seconds of the query budget for transport and the final authorized read. */
const WAIT_MS = 30_000;
export async function waitForMessageHydration<T extends { hydrationStatus: string }>(options: {
  read: () => Promise<Result<T>>;
  terminal: () => Promise<boolean>;
  signal: AbortSignal;
  now?: () => number;
  wait?: (ms: number, signal: AbortSignal) => Promise<unknown>;
}): Promise<Result<T>> {
  const now = options.now ?? Date.now;
  const end = now() + WAIT_MS;
  const wait = options.wait ?? ((ms, signal) => delay(ms, undefined, { signal }));
  while (true) {
    options.signal.throwIfAborted();
    const result = await options.read();
    options.signal.throwIfAborted();
    if (!result.ok || result.data.hydrationStatus === "complete") return result;
    if (await options.terminal())
      return fail({
        code: "MAIL_MESSAGE_HYDRATION_FAILED",
        message: "Message content could not be loaded. Retry hydration in Mail before running this handler again.",
        status: 409,
      });
    const remaining = end - now();
    if (remaining <= 0) return result;
    await wait(Math.min(1_000, remaining), options.signal);
  }
}
