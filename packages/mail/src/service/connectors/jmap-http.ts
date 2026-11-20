import { z } from "zod";
import type { JmapResponse } from "./jmap-transport";

// Default metadata budget, matching MAX_AUTOCONFIG_BYTES in onboarding-discovery.ts.
// Object-list callers supply a bounded budget derived from the requested properties and count.
export const JMAP_JSON_BYTES = 256 * 1024;

export class JmapHttpError extends Error {
  readonly code = "JMAP_HTTP";
  constructor(readonly status: number) {
    super("JMAP HTTP request failed");
    this.name = "JmapHttpError";
  }
}
export class JmapRateLimitError extends Error {
  readonly code = "JMAP_RATE_LIMIT";
  constructor(readonly retryAfter: string | null) {
    super("JMAP request rate limited");
    this.name = "JmapRateLimitError";
  }
}
export class JmapRequestError extends Error {
  readonly code = "JMAP_REQUEST";
  constructor(readonly problemType: string) {
    super("JMAP request rejected");
    this.name = "JmapRequestError";
  }
}
export function checkJmapHttp(response: JmapResponse): void {
  if (response.status === 429) {
    // Retain Retry-After syntax only, never arbitrary reflected response text.
    const value = response.retryAfter;
    const retryAfter =
      value && (/^\d+$/.test(value) || /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value))
        ? value
        : null;
    throw new JmapRateLimitError(retryAfter);
  }
  if (response.status >= 200 && response.status < 300) return;
  // A refused login stays an HTTP status whatever body the server adds: servers such as Stalwart
  // answer every error as problem+json, which would otherwise turn it into a request error.
  if (response.status === 401 || response.status === 403) throw new JmapHttpError(response.status);
  let problem: unknown;
  try {
    problem = JSON.parse(response.body);
  } catch {
    /* HTTP failures need not be JSON. */
  }
  const parsed = z.object({ type: z.string() }).safeParse(problem);
  if (parsed.success) {
    const known = [
      "about:blank",
      "urn:ietf:params:jmap:error:unknownCapability",
      "urn:ietf:params:jmap:error:notJSON",
      "urn:ietf:params:jmap:error:notRequest",
      "urn:ietf:params:jmap:error:limit",
    ];
    throw new JmapRequestError(known.includes(parsed.data.type) ? parsed.data.type : "unknown");
  }
  throw new JmapHttpError(response.status);
}
