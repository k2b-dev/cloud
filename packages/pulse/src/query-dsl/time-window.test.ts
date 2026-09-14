import { expect, test } from "bun:test";
import { dashboardEventQueryText, dashboardMetricQueryText } from "../frontend/workspace/dashboard-query-text";
import { compilePulseQueryText } from "./index";
import { resolveQueryTimeRange, validateEventBucket } from "./time-window";

test("absolute query windows round-trip with offset and reject ambiguous or mixed input", () => {
  const text =
    "events page.viewed unique actor every day timezone Europe/Berlin from 2026-03-28T00:00:00+01:00 to 2026-03-31T00:00:00+02:00";
  const result = compilePulseQueryText("abc123", text);
  expect(result.ok).toBe(true);
  if (!result.ok || result.data.kind !== "events") throw Error("compile failed");
  expect(result.data.since).toBeUndefined();
  expect(result.data.timeZone).toBe("Europe/Berlin");
  expect(compilePulseQueryText("abc123", dashboardEventQueryText(result.data))).toEqual(result);
  const metric = compilePulseQueryText("abc123", "metric load avg every 1h from 2026-09-01T00:00:00Z to 2026-09-02T00:00:00Z");
  if (!metric.ok || metric.data.kind !== "metric") throw Error("metric compile failed");
  expect(compilePulseQueryText("abc123", dashboardMetricQueryText(metric.data))).toEqual(metric);
  for (const suffix of [
    "from 2026-01-01 to 2026-01-02",
    "from 2026-01-01T00:00:00Z",
    "from 2026-01-02T00:00:00Z to 2026-01-01T00:00:00Z",
    "since 1d from 2026-01-01T00:00:00Z to 2026-01-02T00:00:00Z",
  ]) {
    expect(compilePulseQueryText("abc123", `events page.viewed ${suffix}`).ok).toBe(false);
  }
  expect(resolveQueryTimeRange({ since: "1h" }, 3600000)).toEqual({
    ok: true,
    data: { from: new Date(0), to: new Date(3600000), durationMs: 3600000 },
  });
  expect(validateEventBucket("day").ok).toBe(false);
  expect(validateEventBucket("day", "Invalid/Zone").ok).toBe(false);
  expect(validateEventBucket("1h", "Europe/Berlin").ok).toBe(false);
});

test("calendar zones reject numeric offsets even when Intl accepts them", () => {
  expect(validateEventBucket("day", "+01:00").ok).toBe(false);
  expect(validateEventBucket("day", "-05:00").ok).toBe(false);
  expect(validateEventBucket("day", "Etc/GMT+1").ok).toBe(true);
});
