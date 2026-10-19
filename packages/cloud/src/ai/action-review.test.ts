import { expect, test } from "bun:test";
import { type AiActionCheck, isUnknownActionOutcome, preferredActionCheck } from "./action-review";

const earlier = "2026-10-18T09:00:00.000Z";
const later = "2026-10-18T09:01:00.000Z";

test.each(["done", "not_done"] as const)("a settled %s check wins over every open check regardless of timestamp", (state) => {
  const settled: AiActionCheck = { state, at: earlier, receipt: { text: "Settled" } };
  for (const state of ["checking", "pending", "failed"] as const) {
    const open: AiActionCheck = { state, at: later };
    expect(preferredActionCheck(settled, open)).toBe(settled);
    expect(preferredActionCheck(open, settled)).toBe(settled);
  }
});

test.each([
  ["checking", "pending"],
  ["failed", "checking"],
  ["done", "not_done"],
] as const)("between %s and %s the later check wins", (currentState, incomingState) => {
  const current: AiActionCheck = { state: currentState, at: later };
  const incoming: AiActionCheck = { state: incomingState, at: earlier };
  expect(preferredActionCheck(current, incoming)).toBe(current);
  expect(preferredActionCheck(incoming, current)).toBe(current);
  expect(preferredActionCheck(current, { ...incoming, at: later })).toEqual({ ...incoming, at: later });
});

test("missing checks or timestamps prefer the incoming check within the same settlement class", () => {
  const incoming: AiActionCheck = { state: "pending", at: earlier };
  expect(preferredActionCheck(undefined, incoming)).toBe(incoming);
  expect(preferredActionCheck({ state: "checking" }, incoming)).toBe(incoming);
  expect(preferredActionCheck(incoming, { state: "failed" })).toEqual({ state: "failed" });
  expect(preferredActionCheck({ state: "done" }, { state: "pending" })).toEqual({ state: "done" });
});

test("timestamps compare instants across timezone offsets", () => {
  const current: AiActionCheck = { state: "done", at: "2026-10-18T10:00:00.000+02:00" };
  const incoming: AiActionCheck = { state: "not_done", at: earlier };
  expect(preferredActionCheck(current, incoming)).toBe(incoming);
});

test.each(["ACTION_OUTCOME_UNKNOWN", "IDEMPOTENCY_UNCERTAIN", "IDEMPOTENCY_IN_PROGRESS"])(
  "recognizes %s in string and structured errors",
  (code) => {
    expect(isUnknownActionOutcome(`  ${code}: Try checking again.  `)).toBe(true);
    expect(isUnknownActionOutcome({ code, message: "Try checking again." })).toBe(true);
  },
);

test("definitive or malformed results are not unknown outcomes", () => {
  for (const result of [
    null,
    undefined,
    {},
    { code: 123 },
    { code: "APP_UNAVAILABLE" },
    "APP_UNAVAILABLE: Offline",
    "Saved",
    "ACTION_OUTCOME_UNKNOWN",
  ]) {
    expect(isUnknownActionOutcome(result)).toBe(false);
  }
});
