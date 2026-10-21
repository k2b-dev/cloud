import { expect, test } from "bun:test";
import { AlertThresholdSchema, type AlertThresholds } from "../alert-contracts";
import { nextAlertState, readAlertValues } from "./alert-state";

const rule: AlertThresholds = { comparison: "above", warn: 80, critical: 90, minDurationSeconds: 300, intervalSeconds: 300 };
const start = Date.parse("2026-10-20T10:00:00.000Z");
const at = (seconds: number) => new Date(start + seconds * 1000);

test("alert breaches wait for the minimum duration, escalate once and recover", () => {
  const pending = nextAlertState(rule, "disk", undefined, { value: 85 }, at(0));
  expect(pending.current.state).toBe("pending");
  expect(pending.notify).toBe(false);
  const still = nextAlertState(rule, "disk", pending.current, { value: 86 }, at(299));
  expect(still.changed).toBe(false);
  expect(still.current.pendingSince).toBe(at(0).toISOString());
  const firing = nextAlertState(rule, "disk", still.current, { value: 86 }, at(300));
  expect([firing.current.state, firing.current.severity, firing.notify]).toEqual(["firing", "warn", true]);
  const critical = nextAlertState(rule, "disk", firing.current, { value: 95 }, at(600));
  expect([critical.current.state, critical.current.severity, critical.notify]).toEqual(["firing", "critical", true]);
  const unchanged = nextAlertState(rule, "disk", critical.current, { value: 96 }, at(900));
  expect(unchanged.notify).toBe(false);
  expect(unchanged.current.since).toBe(at(600).toISOString());
  const downgraded = nextAlertState(rule, "disk", unchanged.current, { value: 85 }, at(1000));
  expect([downgraded.current.state, downgraded.current.severity, downgraded.changed, downgraded.notify]).toEqual([
    "firing",
    "warn",
    true,
    false,
  ]);
  const recovered = nextAlertState(rule, "disk", downgraded.current, { value: 80 }, at(1200));
  expect([recovered.current.state, recovered.current.pendingSince, recovered.notify]).toEqual(["ok", null, true]);
});

test("below thresholds and zero duration use strict threshold comparisons", () => {
  const below: AlertThresholds = { ...rule, comparison: "below", warn: 20, critical: 10, minDurationSeconds: 0 };
  expect(nextAlertState(below, "free", undefined, { value: 20 }, at(0)).current.state).toBe("ok");
  expect(nextAlertState(below, "free", undefined, { value: 10 }, at(0)).current.severity).toBe("warn");
  expect(nextAlertState(below, "free", undefined, { value: 9 }, at(0)).current.severity).toBe("critical");
});

test("missing data and failures interrupt pending and never report ok", () => {
  const pending = nextAlertState(rule, "disk", undefined, { value: 85 }, at(0));
  for (const observation of [{ value: null }, { value: null, error: "TIME_LIMIT" }, { value: null, error: "OVERDUE" }]) {
    const failed = nextAlertState(rule, "disk", pending.current, observation, at(300));
    expect(failed.current.state).toBe(observation.error ? "error" : "no_data");
    expect(failed.current.pendingSince).toBeNull();
    expect(failed.notify).toBe(true);
    const fresh = nextAlertState(rule, "disk", failed.current, { value: 85 }, at(600));
    expect(fresh.current.state).toBe("pending");
    expect(fresh.current.pendingSince).toBe(at(600).toISOString());
  }
});

test("alert results reject incomplete or ambiguous values before applying a partial result", () => {
  const result = (rows: unknown[][], type = "Float64", truncated = false) => ({
    columns: [
      { name: "key", type: "String" },
      { name: "value", type },
    ],
    rows,
    truncated,
  });
  expect(readAlertValues(result([]))).toEqual({ ok: true, values: new Map() });
  expect(
    readAlertValues(
      result([
        ["disk", 1],
        ["disk", 2],
      ]),
    ),
  ).toEqual({ ok: false, code: "DUPLICATE_KEY" });
  for (const bad of [null, undefined, true, "", "NaN", Number.NaN, Infinity])
    expect(readAlertValues(result([["disk", bad]]))).toEqual({ ok: false, code: "INVALID_VALUE" });
  expect(readAlertValues(result([["disk", "12"]], "String"))).toEqual({ ok: false, code: "INVALID_COLUMNS" });
  expect(readAlertValues(result([["disk", "12"]], "UInt64"))).toEqual({ ok: true, values: new Map([["disk", 12]]) });
  expect(readAlertValues(result([["disk", "9007199254740993"]], "UInt64"))).toEqual({ ok: false, code: "INVALID_VALUE" });
  for (const key of ["", "\0", "a\0b", "\ud800"]) expect(readAlertValues(result([[key, 1]]))).toEqual({ ok: false, code: "INVALID_KEY" });
  expect(readAlertValues(result(Array.from({ length: 101 }, (_, i) => [String(i), i])))).toEqual({ ok: false, code: "TOO_MANY_KEYS" });
  expect(readAlertValues(result([["disk", 1]], "Float64", true))).toEqual({ ok: false, code: "TOO_MANY_KEYS" });
});

test("alert thresholds require a real threshold, ordered severity and at least five minutes", () => {
  expect(AlertThresholdSchema.safeParse(rule).success).toBe(true);
  for (const invalid of [
    { warn: null, critical: null },
    { critical: 70 },
    { intervalSeconds: 299 },
    { minDurationSeconds: -1 },
    { warn: Infinity },
  ])
    expect(AlertThresholdSchema.safeParse({ ...rule, ...invalid }).success).toBe(false);
  expect(AlertThresholdSchema.safeParse({ ...rule, comparison: "below", warn: 20, critical: 10 }).success).toBe(true);
});

for (const observation of [{ value: null }, { value: null, error: "TIME_LIMIT" }]) {
  test(`recovery remains due through pending after ${observation.error ?? "no_data"}`, () => {
    const incident = nextAlertState(rule, "disk", undefined, observation, at(0));
    expect(incident.notify).toBe(true);
    const pending = nextAlertState(rule, "disk", incident.current, { value: 85 }, at(300));
    expect([pending.current.state, pending.current.incidentOpen, pending.notify]).toEqual(["pending", true, false]);
    const recovered = nextAlertState(rule, "disk", pending.current, { value: 50 }, at(600));
    expect([recovered.current.state, recovered.current.incidentOpen, recovered.notify]).toEqual(["ok", false, true]);
    expect(nextAlertState(rule, "disk", recovered.current, { value: 49 }, at(900)).notify).toBe(false);
  });
}
