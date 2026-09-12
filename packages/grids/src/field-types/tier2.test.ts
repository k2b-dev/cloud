import { expect, test } from "bun:test";
import { durationHandler, percentHandler } from "./tier2";

// ── percent ───────────────────────────────────────────────────────
test("percent: 0..100 default range", () => {
  expect(percentHandler.validate(50, {}, false)).toEqual({ ok: true, value: 50 });
  expect(percentHandler.validate(101, {}, false).ok).toBe(false);
  expect(percentHandler.validate(-1, {}, false).ok).toBe(false);
});
test("percent: fraction range 0..1", () => {
  expect(percentHandler.validate(0.5, { range: "fraction" }, false)).toEqual({ ok: true, value: 0.5 });
  expect(percentHandler.validate(2, { range: "fraction" }, false).ok).toBe(false);
});
test("percent: decimal ties round like PostgreSQL numeric without binary floating point drift", () => {
  for (const value of [1.075, "1.075", 2.675, "2.675"]) {
    expect(percentHandler.validate(value, { decimals: 2 }, false)).toEqual({ ok: true, value: Number(value) < 2 ? 1.08 : 2.68 });
  }
  for (const value of [true, [], {}, " ", "NaN", "Infinity"]) {
    expect(percentHandler.validate(value, {}, false).ok).toBe(false);
  }
});

// ── duration ──────────────────────────────────────────────────────
test("duration: plain seconds", () => {
  expect(durationHandler.validate(3600, {}, false)).toEqual({ ok: true, value: 3600 });
  expect(durationHandler.validate("3600", {}, false)).toEqual({ ok: true, value: 3600 });
});
test("duration: HH:MM:SS", () => {
  expect(durationHandler.validate("1:30:00", {}, false)).toEqual({ ok: true, value: 5400 });
  expect(durationHandler.validate("0:45:30", {}, false)).toEqual({ ok: true, value: 2730 });
});
test("duration: MM:SS", () => {
  expect(durationHandler.validate("5:30", {}, false)).toEqual({ ok: true, value: 330 });
});
test("duration: rejects negatives", () => {
  expect(durationHandler.validate(-1, {}, false).ok).toBe(false);
});

test("duration: rejects overflow after converting clock components to seconds", () => {
  for (const value of ["1e308:00:00", "1e308:00", "1e306:1e308:00"]) {
    expect(durationHandler.validate(value, {}, false).ok).toBe(false);
  }
  expect(durationHandler.validate("1000000:00:00", {}, false)).toEqual({ ok: true, value: 3600000000 });
});
