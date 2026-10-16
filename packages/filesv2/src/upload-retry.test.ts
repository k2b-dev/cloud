import { afterEach, expect, jest, spyOn, test } from "bun:test";
import {
  classifyUploadFailure,
  createUploadRetryBudget,
  nextUploadRetry,
  RATE_LIMIT_WAITS,
  RETRY_AFTER_CEILING_MS,
  sleepUploadRetry,
  UPLOAD_RETRY_DELAYS_MS,
} from "./upload-retry";
import { UploadTransferError, type UploadTransferKind } from "./upload-transfer";

const failure = (kind: UploadTransferKind, retryAfter?: number) => new UploadTransferError("failed", kind, undefined, retryAfter);
afterEach(() => jest.useRealTimers());

test("fetch and control deadlines are classified without changing structured transport errors", () => {
  const busy = failure("busy", 3000);
  expect(classifyUploadFailure(busy)).toBe(busy);
  for (const [error, kind] of [
    [new TypeError("offline"), "network"],
    [new DOMException("deadline", "TimeoutError"), "stalled"],
  ] as const) {
    expect(classifyUploadFailure(error)).toMatchObject({ kind, origin: "cloud", cause: error });
  }
  for (const error of [undefined, "failed", new Error("failed"), new DOMException("cancel", "AbortError")])
    expect(classifyUploadFailure(error)).toBeUndefined();
});

test("stalled, busy, and bounded network share exactly five delays and one budget", () => {
  expect(UPLOAD_RETRY_DELAYS_MS).toEqual([2000, 5000, 15000, 30000, 60000]);
  const budget = createUploadRetryBudget();
  const kinds = ["stalled", "busy", "network", "busy", "stalled"] as const;
  expect(kinds.map((kind) => nextUploadRetry(failure(kind), budget, false))).toEqual(
    UPLOAD_RETRY_DELAYS_MS.map((delay, i) => ({ kind: kinds[i]!, delay, attempt: i + 1, of: 5 })),
  );
  expect(nextUploadRetry(failure("busy"), budget, false)).toBeNull();
  expect(createUploadRetryBudget()).toEqual({ retries: 0, rateLimited: 0, probes: 0 });
});

test.each([true, false] as const)("Retry-After is a minimum, with a five-minute automatic ceiling (%s)", (pause) => {
  for (const [hint, delay] of [
    [1000, 2000],
    [3000, 3000],
    [300_000, 300_000],
  ] as const)
    expect(nextUploadRetry(failure("busy", hint), createUploadRetryBudget(), pause)?.delay).toBe(delay);
  expect(RETRY_AFTER_CEILING_MS).toBe(300_000);
  for (const kind of ["busy", "stalled", "rate_limited"] as const) {
    const budget = createUploadRetryBudget();
    expect(nextUploadRetry(failure(kind, 300_001), budget, pause)).toBeNull();
    expect(budget).toEqual(createUploadRetryBudget());
  }
});

test.each([true, false] as const)("rate limits have ten separate waits, including zero, without spending retries (%s)", (pause) => {
  const budget = createUploadRetryBudget();
  expect(RATE_LIMIT_WAITS).toBe(10);
  for (let i = 0; i < 10; i++)
    expect(nextUploadRetry(failure("rate_limited", i), budget, pause)).toEqual({ kind: "rate_limited", delay: i });
  expect(budget.retries).toBe(0);
  expect(nextUploadRetry(failure("rate_limited", 0), budget, pause)).toBeNull();
  expect(nextUploadRetry(failure("rate_limited"), budget, pause)).toEqual({ kind: "busy", delay: 2000, attempt: 1, of: 5 });
  expect(budget.rateLimited).toBe(10);
});

test("paused network probes double to 30 seconds without spending or resetting any budget", () => {
  const budget = createUploadRetryBudget();
  nextUploadRetry(failure("busy"), budget, true);
  nextUploadRetry(failure("rate_limited", 10), budget, true);
  const probes = Array.from({ length: 100 }, () => nextUploadRetry(failure("network"), budget, true));
  expect(probes.slice(0, 6)).toEqual([2000, 4000, 8000, 16000, 30000, 30000].map((delay) => ({ kind: "network", delay })));
  expect(probes.at(-1)).toEqual({ kind: "network", delay: 30000 });
  expect(budget).toEqual({ probes: 100, retries: 1, rateLimited: 1 });
  expect(nextUploadRetry(failure("busy"), budget, true)?.delay).toBe(5000);
});

test.each([true, false] as const)("server, final and unknown errors never retry (%s)", (pause) => {
  const budget = createUploadRetryBudget();
  for (const error of [failure("server"), failure("final"), undefined, new Error("failed")])
    expect(nextUploadRetry(error, budget, pause)).toBeNull();
  expect(budget).toEqual(createUploadRetryBudget());
});

test("abortable sleep clears its timer and listener on elapsed time, abort, and an already aborted signal", async () => {
  jest.useFakeTimers();
  for (const end of ["timer", "abort", "already"] as const) {
    const controller = new AbortController();
    const remove = spyOn(controller.signal, "removeEventListener");
    if (end === "already") controller.abort();
    let settled = false;
    const run = sleepUploadRetry(60_000, controller.signal).then(() => {
      settled = true;
    });
    if (end === "abort") controller.abort();
    else if (end === "timer") jest.advanceTimersByTime(60_000);
    await run;
    expect(settled).toBe(true);
    if (end !== "already") expect(remove).toHaveBeenCalledTimes(1);
    remove.mockRestore();
  }
});
