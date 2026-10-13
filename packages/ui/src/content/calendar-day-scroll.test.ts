import { describe, expect, test } from "bun:test";
import {
  brakedScroll,
  nearestStop,
  SETTLE_RADIUS,
  STOP_ZONE,
  settleTarget,
  snapToColumn,
  stopCrossing,
  stopFactor,
  wheelAxis,
  wheelDelta,
  wheelPixels,
} from "./calendar-day-scroll";
import { parseGoTo, shortcutKeys } from "./calendar-dialogs";

const stops = [0, 1000, 2000];

describe("day starts", () => {
  test("slow the wheel down near them and leave it alone far from them", () => {
    expect(stopFactor(stops, 500)).toBe(1);
    expect(stopFactor(stops, 1000)).toBeCloseTo(0.16);
    expect(stopFactor(stops, 1000 - STOP_ZONE / 2)).toBeGreaterThan(0.16);
    expect(stopFactor(stops, 1000 - STOP_ZONE / 2)).toBeLessThan(1);
    // Far from any start the browser scrolls as usual.
    expect(brakedScroll(stops, 300, 100)).toBeUndefined();
    // A step toward a start moves less than asked, and never past the start at full speed.
    const braked = brakedScroll(stops, 900, 100)!;
    expect(braked).toBeGreaterThan(900);
    expect(braked).toBeLessThan(1000);
    // The first stop at the top brakes nothing: there is no day before it to leave.
    expect(brakedScroll(stops, 60, -60)).toBeUndefined();
  });

  test("a resting scroll close to one glides onto it, a wheel closer than a finger", () => {
    expect(nearestStop(stops, 1310)).toBe(1000);
    expect(settleTarget(stops, 1030, SETTLE_RADIUS.wheel)).toBe(1000);
    expect(settleTarget(stops, 1060, SETTLE_RADIUS.wheel)).toBeUndefined();
    expect(settleTarget(stops, 1060, SETTLE_RADIUS.touch)).toBe(1000);
    expect(settleTarget(stops, 1000, SETTLE_RADIUS.touch)).toBeUndefined();
  });

  test("fill the line of a heading while it passes", () => {
    expect(stopCrossing(1000, 1000)).toBe(1);
    expect(stopCrossing(1000, 1000 - STOP_ZONE / 2)).toBe(0.5);
    expect(stopCrossing(1000, 800)).toBe(0);
  });
});

describe("week gestures", () => {
  test("keep the axis they start on; Shift turns the wheel sideways", () => {
    expect(wheelAxis(30, 5, false)).toBe("x");
    expect(wheelAxis(6, 40, false)).toBe("y");
    expect(wheelAxis(0, 100, true)).toBe("x");
    expect(wheelDelta("x", 0, 100, true)).toBe(100);
    expect(wheelDelta("x", 30, 5, false)).toBe(30);
    expect(wheelDelta("y", 6, 40, false)).toBe(40);
    expect(wheelPixels(3, 1, 800)).toBe(120);
    expect(wheelPixels(1, 2, 800)).toBe(800);
  });

  test("settle on the nearer day edge with room beside the drawer", () => {
    expect(snapToColumn(205, 100, 250)).toBe(200);
    expect(snapToColumn(245, 100, 250)).toBe(250);
    expect(snapToColumn(225, 100, 250)).toBe(200);
    expect(snapToColumn(245, 100)).toBe(200);
    expect(snapToColumn(245, 0, 250)).toBe(245);
  });

  test("settle on the nearest day start", () => {
    expect(snapToColumn(290, 197)).toBe(197);
    expect(snapToColumn(300, 197)).toBe(394);
    expect(snapToColumn(300, 0)).toBe(300);
  });
});

describe("Go to", () => {
  const today = "2026-10-09";

  test("reads German and English dates, ISO dates, and week numbers", () => {
    expect(parseGoTo("15.3.", today)).toBe("2026-03-15");
    expect(parseGoTo("15.3.2027", today)).toBe("2027-03-15");
    expect(parseGoTo("15.03.27", today)).toBe("2027-03-15");
    expect(parseGoTo("2027-03-15", today)).toBe("2027-03-15");
    expect(parseGoTo("3/15", today)).toBe("2026-03-15");
    expect(parseGoTo("KW 12", today)).toBe("2026-03-16");
    expect(parseGoTo("w12", today)).toBe("2026-03-16");
    expect(parseGoTo("week 1", today)).toBe("2025-12-29");
    expect(parseGoTo("heute", today)).toBe(today);
    expect(parseGoTo("tomorrow", today)).toBe("2026-10-10");
  });

  test("reads German and English weekdays, including today unless next is requested", () => {
    expect(parseGoTo("fr", today)).toBe("2026-10-09");
    expect(parseGoTo("Freitag", today)).toBe("2026-10-09");
    expect(parseGoTo("nächsten Fr", today)).toBe("2026-10-16");
    expect(parseGoTo("next friday", today)).toBe("2026-10-16");
    expect(parseGoTo("Montag", today)).toBe("2026-10-12");
    expect(parseGoTo("mon", today)).toBe("2026-10-12");
    expect(parseGoTo("am Fr.", today)).toBe(today);
    expect(parseGoTo("ON FRIDAY.", today)).toBe(today);
    for (const prefix of ["nächste", "nächsten", "nächster", "naechsten", "kommende", "kommenden", "next"]) {
      expect(parseGoTo(`${prefix} Fr.`, today)).toBe("2026-10-16");
      expect(parseGoTo(`${prefix} mon`, today)).toBe("2026-10-12");
    }
  });

  test("reads month names and dates with month names", () => {
    expect(parseGoTo("Dezember", today)).toBe("2026-12-01");
    expect(parseGoTo("März", today)).toBe("2027-03-01");
    expect(parseGoTo("march 2026", today)).toBe("2026-03-01");
    expect(parseGoTo("15. März", today)).toBe("2026-03-15");
    expect(parseGoTo("March 15", today)).toBe("2026-03-15");
    expect(parseGoTo("15 march 2027", today)).toBe("2027-03-15");
    expect(parseGoTo("15 März 2027", today)).toBe("2027-03-15");
    expect(parseGoTo("15 march", today)).toBe("2026-03-15");
    expect(parseGoTo("march 15 2027", today)).toBe("2027-03-15");
    expect(parseGoTo("March 15, 2027", today)).toBe("2027-03-15");
    expect(parseGoTo(" OKT. ", today)).toBe("2026-10-01");
    expect(parseGoTo("maerz. 2027", today)).toBe("2027-03-01");
    expect(parseGoTo("15. MÄR.", today)).toBe("2026-03-15");
    expect(parseGoTo("February 29, 2028", today)).toBe("2028-02-29");
  });

  test("reads every German and English weekday name and abbreviation", () => {
    const weekdays = [
      { names: "montag mo monday mon", key: "2026-10-12" },
      { names: "dienstag di tuesday tue tues", key: "2026-10-13" },
      { names: "mittwoch mi wednesday wed", key: "2026-10-14" },
      { names: "donnerstag do thursday thu thur thurs", key: "2026-10-15" },
      { names: "freitag fr friday fri", key: "2026-10-09" },
      { names: "samstag sa saturday sat", key: "2026-10-10" },
      { names: "sonntag so sunday sun", key: "2026-10-11" },
    ];
    for (const { names, key } of weekdays) {
      for (const name of names.split(" ")) expect(parseGoTo(`${name.toUpperCase()}.`, today)).toBe(key);
    }
  });

  test("reads every German and English month name and abbreviation", () => {
    const months = [
      { names: "januar jan january", key: "2027-01-01" },
      { names: "februar feb february", key: "2027-02-01" },
      { names: "märz maerz mär mrz march mar", key: "2027-03-01" },
      { names: "april apr", key: "2027-04-01" },
      { names: "mai may", key: "2027-05-01" },
      { names: "juni jun june", key: "2027-06-01" },
      { names: "juli jul july", key: "2027-07-01" },
      { names: "august aug", key: "2027-08-01" },
      { names: "september sep sept", key: "2027-09-01" },
      { names: "oktober okt october oct", key: "2026-10-01" },
      { names: "november nov", key: "2026-11-01" },
      { names: "dezember dez december dec", key: "2026-12-01" },
    ];
    for (const { names, key } of months) {
      for (const name of names.split(" ")) expect(parseGoTo(`${name.toUpperCase()}.`, today)).toBe(key);
    }
  });

  test("refuses what is no date", () => {
    expect(parseGoTo("", today)).toBeNull();
    expect(parseGoTo("31.2.", today)).toBeNull();
    expect(parseGoTo("KW 60", today)).toBeNull();
    expect(parseGoTo("frobnicate", today)).toBeNull();
    expect(parseGoTo("31. Februar", today)).toBeNull();
    expect(parseGoTo("next", today)).toBeNull();
    expect(parseGoTo("February 29, 2027", today)).toBeNull();
    expect(parseGoTo("March 0", today)).toBeNull();
  });

  test("names the keys of a shortcut", () => {
    expect(shortcutKeys("h")).toEqual(["H"]);
    expect(shortcutKeys("shift+n").at(-1)).toBe("N");
    expect(shortcutKeys("shift+n")).toHaveLength(2);
    expect(shortcutKeys("arrowright")).toEqual(["→"]);
    expect(shortcutKeys("arrowleft")).toEqual(["←"]);
  });
});
