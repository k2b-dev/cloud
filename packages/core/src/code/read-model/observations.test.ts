import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CodeTestCall } from "@k2b/cloud/code";
import { CodeTestDifferenceSchema, codeTestDifference, visitCronDaySlots } from "@k2b/cloud/code";
import { boundTimeline } from "./activity";
import { describeCalls } from "./describe-calls";
import { codeNoticeCodes, describeCodeNotices } from "./notices";
import { describeExpectedValue } from "./present";
import { presentRunObservations } from "./run";

test("observed successes, replay, refusal and unknown outcomes stay distinct", () => {
  const calls: Pick<CodeTestCall, "operation" | "result" | "replayed">[] = [
    { operation: "example.change", result: { ok: true, data: { requested: 900 } }, replayed: false },
    { operation: "example.change", result: { ok: true, data: {} }, replayed: true },
    { operation: "example.change", result: { ok: false, error: "forbidden" }, replayed: false },
    { operation: "example.change", result: { ok: false, error: "code_result_unknown" }, replayed: false },
  ];
  expect(describeCalls(calls, "de", () => "Aufgabe erstellen").map((row) => row.text)).toEqual([
    "Aufgabe erstellen · 1 im Beispiel erfolgreich",
    "1 wiederholte Aufrufe; keine weitere bestätigte Wirkung",
    "1 Aufruf abgelehnt",
    "1 Aufruf mit unklarem Ausgang",
  ]);
  expect(JSON.stringify(describeCalls(calls, "de"))).not.toContain("900");
  expect(
    presentRunObservations([{ operation: "x", confirmed: 2, replayed: 1, refused: 1, unknown: 1 }], "en", () => "Create task"),
  ).toHaveLength(4);
});
test("all emitted checker codes have a sentence and a consequence, without CLI coordinates", () => {
  const root = join(import.meta.dir, "../../../../cloud/src/code");
  for (const name of readdirSync(root).filter((name) => /^checker.*\.ts$/.test(name) && !name.includes(".test."))) {
    const source = readFileSync(join(root, name), "utf8");
    for (const match of source.matchAll(/(?:report|failure)\([^\n]*?"(code_[a-z_]+)"/g)) expect(codeNoticeCodes).toContain(match[1]!);
  }
  for (const locale of ["de", "en"])
    for (const notice of describeCodeNotices(
      codeNoticeCodes.map((code) => ({ code })),
      locale,
    )) {
      expect(notice.text.length).toBeGreaterThan(15);
      expect(notice.consequence.length).toBeGreaterThan(20);
      expect(JSON.stringify(notice)).not.toMatch(/code_[a-z_]+|code\.ts|:\d+/);
    }
});
test("expected/actual pairs stay bounded and technical values never enter the display", () => {
  expect(CodeTestDifferenceSchema.parse(codeTestDifference("value", "a".repeat(2000), "secret sp_1234")).expected).toHaveLength(240);
  expect(describeExpectedValue('"secret sp_1234 code.ts:19"', "de")).toBe("Text");
  expect(describeExpectedValue("3", "de")).toBe("3");
  expect(describeExpectedValue('["private",2]', "en")).toBe("List · 2");
});
test("one-day schedule projection preserves DST and groups over 200 timeline marks", () => {
  const from = new Date("2026-10-24T22:00:00Z"),
    to = new Date("2026-10-25T23:00:00Z");
  const slots: Date[] = [];
  visitCronDaySlots({ cron: "30 2 * * *", timezone: "Europe/Berlin" }, from, to, (slot) => slots.push(slot));
  expect(slots.map((slot) => slot.toISOString())).toEqual(["2026-10-25T00:30:00.000Z"]);
  const marks = Array.from({ length: 1000 }, (_, index) => ({
    at: new Date(+from + index * 60_000).toISOString(),
    state: "planned" as const,
    count: 1,
  }));
  const bounded = boundTimeline(marks, from, to);
  expect(bounded.length).toBeLessThanOrEqual(200);
  expect(bounded.reduce((sum, mark) => sum + mark.count, 0)).toBe(1000);
});

test("each checker code has its own text and route warnings do not block submission", () => {
  for (const locale of ["de", "en"]) {
    const rows = describeCodeNotices(
      codeNoticeCodes.map((code) => ({ code })),
      locale,
    );
    expect(new Set(rows.map((row) => row.text)).size).toBe(codeNoticeCodes.length);
    expect(describeCodeNotices([{ code: "code_route_before_middleware" }], locale)[0]?.severity).toBe("warning");
  }
});
