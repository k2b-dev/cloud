import type { Context } from "hono";

/** Idle timeout of every Cloud app server and the gateway: Bun's default, kept explicit. */
export const REQUEST_IDLE_TIMEOUT_SECONDS = 10;
/** Longest a request may stay silent: the gateway waits this long for an app's response headers. */
export const REQUEST_IDLE_TIMEOUT_MAX_SECONDS = 300;

/**
 * Restart this request's bounded idle timer while waiting to answer.
 * Bun retains the raised timeout on the keep-alive socket after the response,
 * so restore REQUEST_IDLE_TIMEOUT_SECONDS once the handler starts answering.
 */
export const setRequestTimeout = (c: Context, seconds: number): void => {
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > REQUEST_IDLE_TIMEOUT_MAX_SECONDS)
    throw new RangeError(`Request idle timeout must be an integer between 1 and ${REQUEST_IDLE_TIMEOUT_MAX_SECONDS} seconds`);
  const server: unknown = c.env;
  if (typeof server === "object" && server !== null && "timeout" in server && typeof server.timeout === "function")
    server.timeout(c.req.raw, seconds);
};
