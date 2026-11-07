import type { TransportReport } from "@k2b/nessi/ai";

export type TransportObserver = { onTransport?: (report: TransportReport) => void };

/**
 * Adds `observe` to the request's transport hook. nessi reports the one request
 * a model call sends once it settles, before an error reaches the caller; every
 * wrapper around the same adapter sees that report. Nothing here logs: the
 * report carries no body or headers, but callers must not log requests either.
 */
export const observeTransport = <T>(request: T & TransportObserver, observe: (report: TransportReport) => void): T & TransportObserver => ({
  ...request,
  onTransport: (report) => {
    observe(report);
    request.onTransport?.(report);
  },
});

/**
 * A client error, 503, or Anthropic's overloaded 529 says the provider did not
 * process the request. Other server errors, such as a gateway's 502 or 504, can
 * follow processing upstream.
 */
const refusedStatus = (status: number) => (status >= 400 && status < 500) || status === 503 || status === 529;

/** Bun's codes for a request that never left: no connection, or no address for the host. */
// Bun before 1.4.3 reports a refused connection as `ConnectionRefused`.
const unsentCodes = new Set(["ECONNREFUSED", "ConnectionRefused", "ENOTFOUND"]);

/**
 * The provider certainly did not process the request: it never left, or its
 * status says so. A reset, an abort, or a timeout can follow delivery.
 */
export const transportRefused = (report: TransportReport | undefined): boolean =>
  report !== undefined &&
  (report.status !== undefined
    ? refusedStatus(report.status)
    : report.connectionCode !== undefined && unsentCodes.has(report.connectionCode));

/** No response arrived: the connection failed, or the request was aborted or timed out before headers. */
export const transportFailed = (report: TransportReport | undefined): boolean => report !== undefined && report.headersAt === undefined;
