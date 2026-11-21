import { describe, expect, test } from "bun:test";
import { JmapError, JmapMethodError } from "./connectors/jmap-client";
import { JmapReconciliationRequiredError } from "./connectors/jmap-delta";
import { checkJmapHttp, JmapHttpError, JmapRateLimitError, JmapRequestError } from "./connectors/jmap-http";
import { JmapTransportError } from "./connectors/jmap-transport";
import { classifyJmapFailure, JMAP_RATE_LIMIT_FALLBACK_MS } from "./jmap-failure";
import { isProviderTimeout } from "./provider-errors";

// A fixed clock: no result depends on the day the test runs.
const now = Date.parse("2026-11-20T12:00:00Z");
const rateLimit = (retryAfter: string | undefined) => {
  try {
    checkJmapHttp({ status: 429, retryAfter, body: "" });
  } catch (error) {
    if (error instanceof JmapRateLimitError) return error;
  }
  throw new Error("expected a rate limit");
};

describe("Retry-After", () => {
  for (const [label, header, expected] of [
    ["delta seconds", "30", 30_000],
    ["delta seconds over the IMAP sync's 60 s cap", "3600", 3_600_000],
    ["zero seconds", "0", 0],
    ["a date in the future", "Fri, 20 Nov 2026 12:10:00 GMT", 600_000],
    ["a date two days ahead", "Sun, 22 Nov 2026 12:00:00 GMT", 172_800_000],
    ["a date in the past", "Fri, 20 Nov 2026 11:00:00 GMT", 0],
  ] as const) {
    test(`reads ${label} against the given clock`, () => {
      expect(rateLimit(header).retryAfterMs(now)).toBe(expected);
      expect(classifyJmapFailure(rateLimit(header), now)).toEqual({ kind: "rate_limited", retryAfterMs: expected });
    });
  }

  for (const [label, header] of [
    ["missing", undefined],
    ["empty", ""],
    ["negative", "-5"],
    ["fractional", "1.5"],
    ["an obsolete date format", "Friday, 20-Nov-26 12:10:00 GMT"],
    ["an impossible date", "Tue, 31 Feb 2026 12:00:00 GMT"],
    ["a weekday that does not fit the date", "Mon, 20 Nov 2026 12:10:00 GMT"],
    ["too large to count in milliseconds", "9".repeat(20)],
  ] as const) {
    test(`uses the fallback when Retry-After is ${label}`, () => {
      expect(rateLimit(header).retryAfterMs(now)).toBeNull();
      expect(classifyJmapFailure(rateLimit(header), now)).toEqual({ kind: "rate_limited", retryAfterMs: JMAP_RATE_LIMIT_FALLBACK_MS });
    });
  }
});

describe("JMAP failure classes", () => {
  for (const [label, error, kind] of [
    ["401", new JmapHttpError(401), "auth_required"],
    ["403", new JmapHttpError(403), "access_denied"],
    ["500", new JmapHttpError(500), "unavailable"],
    ["503", new JmapHttpError(503), "unavailable"],
    ["404", new JmapHttpError(404), "invalid"],
    ["a timeout", new JmapTransportError("JMAP_TIMEOUT"), "timeout"],
    ["a cancellation", new JmapTransportError("JMAP_ABORTED"), "aborted"],
    ["a broken connection", new JmapTransportError("JMAP_TRANSPORT"), "unavailable"],
    ["an oversized response", new JmapTransportError("JMAP_TOO_LARGE"), "invalid"],
    ["a redirect", new JmapTransportError("JMAP_REDIRECT"), "invalid"],
    ["serverUnavailable", new JmapMethodError("serverUnavailable"), "unavailable"],
    ["a rejected method", new JmapMethodError("invalidArguments"), "invalid"],
    ["cannotCalculateChanges as a method error", new JmapMethodError("cannotCalculateChanges"), "invalid"],
    ["a validated reconciliation", new JmapReconciliationRequiredError("cannot_calculate"), "reconciliation_required"],
    ["a rejected state", new JmapReconciliationRequiredError("state_rejected"), "reconciliation_required"],
    ["a changed Session", new JmapError("JMAP_SESSION_CHANGED"), "session_changed"],
    ["an invalid response", new JmapError("JMAP_INVALID_RESPONSE"), "invalid"],
    ["a call budget", new JmapError("JMAP_CALL_LIMIT"), "invalid"],
    ["a request problem", new JmapRequestError("urn:ietf:params:jmap:error:limit"), "invalid"],
  ] as const) {
    test(`${label} is ${kind}`, () => {
      expect(classifyJmapFailure(error, now)).toEqual({ kind });
    });
  }

  test("other failures are not JMAP failures", () => {
    for (const error of [new Error("database"), Object.assign(new Error("x"), { code: "JMAP_TIMEOUT" }), null, "text"]) {
      expect(classifyJmapFailure(error, now)).toBeNull();
    }
  });

  test("only the JMAP timeout counts as a provider timeout", () => {
    expect(isProviderTimeout(new JmapTransportError("JMAP_TIMEOUT"))).toBe(true);
    for (const code of ["JMAP_ABORTED", "JMAP_TRANSPORT"] as const) expect(isProviderTimeout(new JmapTransportError(code))).toBe(false);
    expect(isProviderTimeout(new JmapHttpError(503))).toBe(false);
  });
});
