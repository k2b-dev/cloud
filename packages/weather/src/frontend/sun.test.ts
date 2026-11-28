import { describe, expect, test } from "bun:test";
import { isNight, sunElevation } from "./sun";

// Ulm (48.40 N, 9.99 E). Sunrise and sunset in UTC as this function puts them, within a few minutes of the published
// tables: midsummer 03:18 and 19:25, midwinter 07:09 and 15:28, the day summer time begins (29.03.2026) 05:08 and
// 17:45, the day it ends (25.10.2026) 05:53 and 16:15. Each moment below stands at least 25 minutes from a sunrise or
// sunset.
const ULM = [48.4, 9.99] as const;
const at = (iso: string) => new Date(iso);
const night = (iso: string) => isNight(...ULM, at(iso));

describe("day and night in Ulm from the sun's place", () => {
  test("midsummer: a short night", () => {
    expect(night("2026-06-21T02:30:00Z")).toBe(true);
    expect(night("2026-06-21T03:45:00Z")).toBe(false);
    expect(night("2026-06-21T18:55:00Z")).toBe(false);
    expect(night("2026-06-21T20:00:00Z")).toBe(true);
  });

  test("midwinter: a long night", () => {
    expect(night("2026-12-21T06:40:00Z")).toBe(true);
    expect(night("2026-12-21T07:45:00Z")).toBe(false);
    expect(night("2026-12-21T15:00:00Z")).toBe(false);
    expect(night("2026-12-21T16:00:00Z")).toBe(true);
  });

  test("the days the clocks change: the sun does not move with them", () => {
    expect(night("2026-03-29T04:30:00Z")).toBe(true);
    expect(night("2026-03-29T05:40:00Z")).toBe(false);
    expect(night("2026-03-29T17:15:00Z")).toBe(false);
    expect(night("2026-03-29T18:15:00Z")).toBe(true);
    expect(night("2026-10-25T05:15:00Z")).toBe(true);
    expect(night("2026-10-25T06:40:00Z")).toBe(false);
    expect(night("2026-10-25T15:30:00Z")).toBe(false);
    expect(night("2026-10-25T16:50:00Z")).toBe(true);
  });

  test("the sun stands highest about noon and lowest about midnight", () => {
    const noon = sunElevation(...ULM, at("2026-06-21T11:20:00Z"));
    expect(noon).toBeGreaterThan(64);
    expect(noon).toBeLessThan(66);
    expect(sunElevation(...ULM, at("2026-12-21T23:20:00Z"))).toBeLessThan(-60);
  });
});
