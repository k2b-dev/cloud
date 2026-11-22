// Expected tables are written out by hand from the published state tables at
// kalenderpedia.de (e.g. /feiertage/feiertage-berlin-2028.html,
// /feiertage/feiertage-sachsen-2026.html, /feiertage/feiertage-brandenburg-2024.html)
// and checked against the state holiday laws: Berlin "Gesetz über die Sonn- und
// Feiertage" (2025 and 2028 one-time days added in GVBl. 2024 S. 460), Brandenburg "Feiertagsgesetz"
// § 2, Sächsisches "Gesetz über Sonn- und Feiertage", Thüringer
// "Feiertagsgesetz", and de.wikipedia.org "Gesetzliche Feiertage in Deutschland"
// for introduction years.
import { describe, expect, it } from "bun:test";
import { publicHolidays } from "./holidays";
import type { Holiday, HolidayKey, HolidayRegion } from "./holidays";
import { publicHolidays as namedPublicHolidays } from "./dates";
import { dates, publicHolidays as rootPublicHolidays } from "./index";

const stateRegions: readonly HolidayRegion[] = [
  "DE-BW", "DE-BY", "DE-BE", "DE-BB", "DE-HB", "DE-HH", "DE-HE", "DE-MV",
  "DE-NI", "DE-NW", "DE-RP", "DE-SL", "DE-SN", "DE-ST", "DE-SH", "DE-TH",
];

const holidayKeys: ReadonlySet<string> = new Set<HolidayKey>([
  "new-year", "epiphany", "womens-day", "good-friday", "easter-sunday", "easter-monday",
  "labour-day", "liberation-day", "ascension-day", "whit-sunday", "whit-monday",
  "corpus-christi", "uprising-1953", "assumption-day", "childrens-day", "german-unity-day",
  "reformation-day", "all-saints-day", "repentance-day", "christmas-day", "boxing-day",
]);

const holiday = (year: number, region: HolidayRegion, key: HolidayKey): Holiday | undefined =>
  publicHolidays(year, region).find((entry) => entry.key === key);

describe("publicHolidays reference tables", () => {
  it("returns all holidays for DE 2025", () => {
    expect(publicHolidays(2025, "DE")).toEqual([
      { date: "2025-01-01", key: "new-year", nationwide: true },
      { date: "2025-04-18", key: "good-friday", nationwide: true },
      { date: "2025-04-21", key: "easter-monday", nationwide: true },
      { date: "2025-05-01", key: "labour-day", nationwide: true },
      { date: "2025-05-29", key: "ascension-day", nationwide: true },
      { date: "2025-06-09", key: "whit-monday", nationwide: true },
      { date: "2025-10-03", key: "german-unity-day", nationwide: true },
      { date: "2025-12-25", key: "christmas-day", nationwide: true },
      { date: "2025-12-26", key: "boxing-day", nationwide: true },
    ]);
  });

  it("returns all holidays for DE-BY 2025", () => {
    expect(publicHolidays(2025, "DE-BY")).toEqual([
      { date: "2025-01-01", key: "new-year", nationwide: true },
      { date: "2025-01-06", key: "epiphany", nationwide: false },
      { date: "2025-04-18", key: "good-friday", nationwide: true },
      { date: "2025-04-21", key: "easter-monday", nationwide: true },
      { date: "2025-05-01", key: "labour-day", nationwide: true },
      { date: "2025-05-29", key: "ascension-day", nationwide: true },
      { date: "2025-06-09", key: "whit-monday", nationwide: true },
      { date: "2025-06-19", key: "corpus-christi", nationwide: false },
      { date: "2025-10-03", key: "german-unity-day", nationwide: true },
      { date: "2025-11-01", key: "all-saints-day", nationwide: false },
      { date: "2025-12-25", key: "christmas-day", nationwide: true },
      { date: "2025-12-26", key: "boxing-day", nationwide: true },
    ]);
  });

  it("returns all holidays for DE-BE 2025", () => {
    expect(publicHolidays(2025, "DE-BE")).toEqual([
      { date: "2025-01-01", key: "new-year", nationwide: true },
      { date: "2025-03-08", key: "womens-day", nationwide: false },
      { date: "2025-04-18", key: "good-friday", nationwide: true },
      { date: "2025-04-21", key: "easter-monday", nationwide: true },
      { date: "2025-05-01", key: "labour-day", nationwide: true },
      { date: "2025-05-08", key: "liberation-day", nationwide: false },
      { date: "2025-05-29", key: "ascension-day", nationwide: true },
      { date: "2025-06-09", key: "whit-monday", nationwide: true },
      { date: "2025-10-03", key: "german-unity-day", nationwide: true },
      { date: "2025-12-25", key: "christmas-day", nationwide: true },
      { date: "2025-12-26", key: "boxing-day", nationwide: true },
    ]);
  });

  it("returns all holidays for DE-BE 2028", () => {
    expect(publicHolidays(2028, "DE-BE")).toEqual([
      { date: "2028-01-01", key: "new-year", nationwide: true },
      { date: "2028-03-08", key: "womens-day", nationwide: false },
      { date: "2028-04-14", key: "good-friday", nationwide: true },
      { date: "2028-04-17", key: "easter-monday", nationwide: true },
      { date: "2028-05-01", key: "labour-day", nationwide: true },
      { date: "2028-05-25", key: "ascension-day", nationwide: true },
      { date: "2028-06-05", key: "whit-monday", nationwide: true },
      { date: "2028-06-17", key: "uprising-1953", nationwide: false },
      { date: "2028-10-03", key: "german-unity-day", nationwide: true },
      { date: "2028-12-25", key: "christmas-day", nationwide: true },
      { date: "2028-12-26", key: "boxing-day", nationwide: true },
    ]);
  });

  it("returns all holidays for DE-BB 2024", () => {
    expect(publicHolidays(2024, "DE-BB")).toEqual([
      { date: "2024-01-01", key: "new-year", nationwide: true },
      { date: "2024-03-29", key: "good-friday", nationwide: true },
      { date: "2024-03-31", key: "easter-sunday", nationwide: false },
      { date: "2024-04-01", key: "easter-monday", nationwide: true },
      { date: "2024-05-01", key: "labour-day", nationwide: true },
      { date: "2024-05-09", key: "ascension-day", nationwide: true },
      { date: "2024-05-19", key: "whit-sunday", nationwide: false },
      { date: "2024-05-20", key: "whit-monday", nationwide: true },
      { date: "2024-10-03", key: "german-unity-day", nationwide: true },
      { date: "2024-10-31", key: "reformation-day", nationwide: false },
      { date: "2024-12-25", key: "christmas-day", nationwide: true },
      { date: "2024-12-26", key: "boxing-day", nationwide: true },
    ]);
  });

  it("returns all holidays for DE-SN 2026", () => {
    expect(publicHolidays(2026, "DE-SN")).toEqual([
      { date: "2026-01-01", key: "new-year", nationwide: true },
      { date: "2026-04-03", key: "good-friday", nationwide: true },
      { date: "2026-04-06", key: "easter-monday", nationwide: true },
      { date: "2026-05-01", key: "labour-day", nationwide: true },
      { date: "2026-05-14", key: "ascension-day", nationwide: true },
      { date: "2026-05-25", key: "whit-monday", nationwide: true },
      { date: "2026-10-03", key: "german-unity-day", nationwide: true },
      { date: "2026-10-31", key: "reformation-day", nationwide: false },
      { date: "2026-11-18", key: "repentance-day", nationwide: false },
      { date: "2026-12-25", key: "christmas-day", nationwide: true },
      { date: "2026-12-26", key: "boxing-day", nationwide: true },
    ]);
  });

  it("returns all holidays for DE-TH 2027", () => {
    expect(publicHolidays(2027, "DE-TH")).toEqual([
      { date: "2027-01-01", key: "new-year", nationwide: true },
      { date: "2027-03-26", key: "good-friday", nationwide: true },
      { date: "2027-03-29", key: "easter-monday", nationwide: true },
      { date: "2027-05-01", key: "labour-day", nationwide: true },
      { date: "2027-05-06", key: "ascension-day", nationwide: true },
      { date: "2027-05-17", key: "whit-monday", nationwide: true },
      { date: "2027-09-20", key: "childrens-day", nationwide: false },
      { date: "2027-10-03", key: "german-unity-day", nationwide: true },
      { date: "2027-10-31", key: "reformation-day", nationwide: false },
      { date: "2027-12-25", key: "christmas-day", nationwide: true },
      { date: "2027-12-26", key: "boxing-day", nationwide: true },
    ]);
  });

  it("returns all holidays for DE-NW 2030", () => {
    expect(publicHolidays(2030, "DE-NW")).toEqual([
      { date: "2030-01-01", key: "new-year", nationwide: true },
      { date: "2030-04-19", key: "good-friday", nationwide: true },
      { date: "2030-04-22", key: "easter-monday", nationwide: true },
      { date: "2030-05-01", key: "labour-day", nationwide: true },
      { date: "2030-05-30", key: "ascension-day", nationwide: true },
      { date: "2030-06-10", key: "whit-monday", nationwide: true },
      { date: "2030-06-20", key: "corpus-christi", nationwide: false },
      { date: "2030-10-03", key: "german-unity-day", nationwide: true },
      { date: "2030-11-01", key: "all-saints-day", nationwide: false },
      { date: "2030-12-25", key: "christmas-day", nationwide: true },
      { date: "2030-12-26", key: "boxing-day", nationwide: true },
    ]);
  });

  it("returns all holidays for DE-HB 2029", () => {
    expect(publicHolidays(2029, "DE-HB")).toEqual([
      { date: "2029-01-01", key: "new-year", nationwide: true },
      { date: "2029-03-30", key: "good-friday", nationwide: true },
      { date: "2029-04-02", key: "easter-monday", nationwide: true },
      { date: "2029-05-01", key: "labour-day", nationwide: true },
      { date: "2029-05-10", key: "ascension-day", nationwide: true },
      { date: "2029-05-21", key: "whit-monday", nationwide: true },
      { date: "2029-10-03", key: "german-unity-day", nationwide: true },
      { date: "2029-10-31", key: "reformation-day", nationwide: false },
      { date: "2029-12-25", key: "christmas-day", nationwide: true },
      { date: "2029-12-26", key: "boxing-day", nationwide: true },
    ]);
  });

  it("returns all holidays for DE-SL 2026", () => {
    expect(publicHolidays(2026, "DE-SL")).toEqual([
      { date: "2026-01-01", key: "new-year", nationwide: true },
      { date: "2026-04-03", key: "good-friday", nationwide: true },
      { date: "2026-04-06", key: "easter-monday", nationwide: true },
      { date: "2026-05-01", key: "labour-day", nationwide: true },
      { date: "2026-05-14", key: "ascension-day", nationwide: true },
      { date: "2026-05-25", key: "whit-monday", nationwide: true },
      { date: "2026-06-04", key: "corpus-christi", nationwide: false },
      { date: "2026-08-15", key: "assumption-day", nationwide: false },
      { date: "2026-10-03", key: "german-unity-day", nationwide: true },
      { date: "2026-11-01", key: "all-saints-day", nationwide: false },
      { date: "2026-12-25", key: "christmas-day", nationwide: true },
      { date: "2026-12-26", key: "boxing-day", nationwide: true },
    ]);
  });

  it("returns all holidays for DE-MV 2024", () => {
    expect(publicHolidays(2024, "DE-MV")).toEqual([
      { date: "2024-01-01", key: "new-year", nationwide: true },
      { date: "2024-03-08", key: "womens-day", nationwide: false },
      { date: "2024-03-29", key: "good-friday", nationwide: true },
      { date: "2024-04-01", key: "easter-monday", nationwide: true },
      { date: "2024-05-01", key: "labour-day", nationwide: true },
      { date: "2024-05-09", key: "ascension-day", nationwide: true },
      { date: "2024-05-20", key: "whit-monday", nationwide: true },
      { date: "2024-10-03", key: "german-unity-day", nationwide: true },
      { date: "2024-10-31", key: "reformation-day", nationwide: false },
      { date: "2024-12-25", key: "christmas-day", nationwide: true },
      { date: "2024-12-26", key: "boxing-day", nationwide: true },
    ]);
  });

  it("returns all holidays for DE-HE 2027", () => {
    expect(publicHolidays(2027, "DE-HE")).toEqual([
      { date: "2027-01-01", key: "new-year", nationwide: true },
      { date: "2027-03-26", key: "good-friday", nationwide: true },
      { date: "2027-03-29", key: "easter-monday", nationwide: true },
      { date: "2027-05-01", key: "labour-day", nationwide: true },
      { date: "2027-05-06", key: "ascension-day", nationwide: true },
      { date: "2027-05-17", key: "whit-monday", nationwide: true },
      { date: "2027-05-27", key: "corpus-christi", nationwide: false },
      { date: "2027-10-03", key: "german-unity-day", nationwide: true },
      { date: "2027-12-25", key: "christmas-day", nationwide: true },
      { date: "2027-12-26", key: "boxing-day", nationwide: true },
    ]);
  });
});

const movableDates = [
  { year: 2024, easter: "2024-03-31", goodFriday: "2024-03-29", easterMonday: "2024-04-01", ascension: "2024-05-09", whitSunday: "2024-05-19", whitMonday: "2024-05-20", corpusChristi: "2024-05-30", repentance: "2024-11-20" },
  { year: 2025, easter: "2025-04-20", goodFriday: "2025-04-18", easterMonday: "2025-04-21", ascension: "2025-05-29", whitSunday: "2025-06-08", whitMonday: "2025-06-09", corpusChristi: "2025-06-19", repentance: "2025-11-19" },
  { year: 2026, easter: "2026-04-05", goodFriday: "2026-04-03", easterMonday: "2026-04-06", ascension: "2026-05-14", whitSunday: "2026-05-24", whitMonday: "2026-05-25", corpusChristi: "2026-06-04", repentance: "2026-11-18" },
  { year: 2027, easter: "2027-03-28", goodFriday: "2027-03-26", easterMonday: "2027-03-29", ascension: "2027-05-06", whitSunday: "2027-05-16", whitMonday: "2027-05-17", corpusChristi: "2027-05-27", repentance: "2027-11-17" },
  { year: 2028, easter: "2028-04-16", goodFriday: "2028-04-14", easterMonday: "2028-04-17", ascension: "2028-05-25", whitSunday: "2028-06-04", whitMonday: "2028-06-05", corpusChristi: "2028-06-15", repentance: "2028-11-22" },
  { year: 2029, easter: "2029-04-01", goodFriday: "2029-03-30", easterMonday: "2029-04-02", ascension: "2029-05-10", whitSunday: "2029-05-20", whitMonday: "2029-05-21", corpusChristi: "2029-05-31", repentance: "2029-11-21" },
  { year: 2030, easter: "2030-04-21", goodFriday: "2030-04-19", easterMonday: "2030-04-22", ascension: "2030-05-30", whitSunday: "2030-06-09", whitMonday: "2030-06-10", corpusChristi: "2030-06-20", repentance: "2030-11-20" },
];

describe("movable holidays", () => {
  it.each(movableDates)("matches literal reference dates for $year", (reference) => {
    const { year } = reference;
    expect(holiday(year, "DE-BB", "easter-sunday")?.date).toBe(reference.easter);
    expect(holiday(year, "DE-BB", "whit-sunday")?.date).toBe(reference.whitSunday);
    expect(holiday(year, "DE-BY", "good-friday")?.date).toBe(reference.goodFriday);
    expect(holiday(year, "DE-BY", "easter-monday")?.date).toBe(reference.easterMonday);
    expect(holiday(year, "DE-BY", "ascension-day")?.date).toBe(reference.ascension);
    expect(holiday(year, "DE-BY", "whit-monday")?.date).toBe(reference.whitMonday);
    expect(holiday(year, "DE-BY", "corpus-christi")?.date).toBe(reference.corpusChristi);
    expect(holiday(year, "DE-SN", "repentance-day")?.date).toBe(reference.repentance);
  });

  it.each([
    { year: 2285, easter: "2285-03-22", goodFriday: "2285-03-20" },
    { year: 2038, easter: "2038-04-25", goodFriday: "2038-04-23" },
    { year: 2008, easter: "2008-03-23", goodFriday: "2008-03-21" },
    { year: 2011, easter: "2011-04-24", goodFriday: "2011-04-22" },
  ])("handles Easter edge year $year", ({ year, easter, goodFriday }) => {
    expect(holiday(year, "DE-BB", "easter-sunday")?.date).toBe(easter);
    expect(holiday(year, "DE", "good-friday")?.date).toBe(goodFriday);
  });

  it("moves Repentance Day a full week back when 23 November is a Wednesday", () => {
    expect(holiday(2022, "DE-SN", "repentance-day")?.date).toBe("2022-11-16");
  });

  it("keeps both holidays on 2008-05-01 in rule-table order", () => {
    const expected: Holiday[] = [
      { date: "2008-05-01", key: "labour-day", nationwide: true },
      { date: "2008-05-01", key: "ascension-day", nationwide: true },
    ];
    for (let call = 0; call < 3; call++) {
      expect(publicHolidays(2008, "DE").filter((entry) => entry.date === "2008-05-01")).toEqual(expected);
    }
  });
});

describe("holiday introduction years and regional scope", () => {
  it.each([
    { region: "DE-BE", key: "womens-day", before: 2018, since: 2019, date: "2019-03-08" },
    { region: "DE-MV", key: "womens-day", before: 2022, since: 2023, date: "2023-03-08" },
    { region: "DE-TH", key: "childrens-day", before: 2018, since: 2019, date: "2019-09-20" },
  ] satisfies { region: HolidayRegion; key: HolidayKey; before: number; since: number; date: string }[])(
    "$region introduces $key in $since", ({ region, key, before, since, date }) => {
      expect(holiday(before, region, key)).toBeUndefined();
      expect(holiday(since, region, key)).toEqual({ date, key, nationwide: false });
    },
  );

  it.each(["DE", ...stateRegions])("has nationwide Reformation Day in 2017 for %s", (region) => {
    const matching = publicHolidays(2017, region).filter((entry) => entry.key === "reformation-day");
    expect(matching).toEqual([{ date: "2017-10-31", key: "reformation-day", nationwide: true }]);
  });

  it.each(["DE", "DE-NI", "DE-HB", "DE-HH", "DE-SH", "DE-BW"] satisfies HolidayRegion[])(
    "has no Reformation Day in 2016 for %s", (region) => {
      expect(holiday(2016, region, "reformation-day")).toBeUndefined();
    },
  );

  it.each(["DE-HB", "DE-HH", "DE-NI", "DE-SH"] satisfies HolidayRegion[])(
    "introduces state Reformation Day in 2018 for %s", (region) => {
      expect(holiday(2018, region, "reformation-day")).toEqual({
        date: "2018-10-31", key: "reformation-day", nationwide: false,
      });
    },
  );

  it("does not add Reformation Day for Bavaria or nationwide after 2017", () => {
    expect(holiday(2018, "DE-BY", "reformation-day")).toBeUndefined();
    expect(holiday(2018, "DE", "reformation-day")).toBeUndefined();
  });

  it("has Berlin Liberation Day only in 2020 and 2025", () => {
    expect(holiday(2020, "DE-BE", "liberation-day")).toEqual({
      date: "2020-05-08", key: "liberation-day", nationwide: false,
    });
    expect(holiday(2025, "DE-BE", "liberation-day")).toEqual({
      date: "2025-05-08", key: "liberation-day", nationwide: false,
    });
    for (const year of [2019, 2021, 2024, 2026]) {
      expect(holiday(year, "DE-BE", "liberation-day")).toBeUndefined();
    }
    expect(holiday(2025, "DE-BB", "liberation-day")).toBeUndefined();
  });

  it("has the uprising anniversary only in Berlin in 2028", () => {
    expect(holiday(2027, "DE-BE", "uprising-1953")).toBeUndefined();
    expect(holiday(2029, "DE-BE", "uprising-1953")).toBeUndefined();
    expect(holiday(2028, "DE-BB", "uprising-1953")).toBeUndefined();
  });

  it("excludes municipal and non-statutory days off", () => {
    expect(holiday(2025, "DE-BY", "assumption-day")).toBeUndefined();
    expect(holiday(2025, "DE-SN", "corpus-christi")).toBeUndefined();
    expect(holiday(2025, "DE-TH", "corpus-christi")).toBeUndefined();
    expect(holiday(2025, "DE-HE", "easter-sunday")).toBeUndefined();
    expect(holiday(2025, "DE-HE", "whit-sunday")).toBeUndefined();
    expect(publicHolidays(2025, "DE-BY").some((entry) =>
      ["2025-08-08", "2025-12-24", "2025-12-31"].includes(entry.date),
    )).toBe(false);
  });
});

describe("holiday input and output contract", () => {
  it.each([1994, 10000, 2025.5, NaN, Infinity, -1])("rejects unsupported year %s", (year) => {
    const call = () => publicHolidays(year, "DE");
    expect(call).toThrow(RangeError);
    expect(call).toThrow(`Unsupported holiday year ${year}; expected an integer from 1995 to 9999`);
  });

  it.each(["DE-XX", "de-by", "AT", "BY", ""])("rejects unsupported region %s", (region: string) => {
    const call = () => Reflect.apply(publicHolidays, undefined, [2025, region]);
    expect(call).toThrow(RangeError);
    expect(call).toThrow(`Unsupported holiday region "${region}"`);
  });

  it.each([
    { year: 1995, easter: "1995-04-16", repentance: "1995-11-22", last: "1995-12-26" },
    { year: 9999, easter: "9999-03-28", repentance: "9999-11-17", last: "9999-12-26" },
  ])("supports inclusive year boundary $year", ({ year, easter, repentance, last }) => {
    expect(holiday(year, "DE-BB", "easter-sunday")?.date).toBe(easter);
    expect(holiday(year, "DE-SN", "repentance-day")?.date).toBe(repentance);
    expect(publicHolidays(year, "DE").at(-1)?.date).toBe(last);
  });

  it("returns sorted, valid, unique holidays for every state in 2017–2030", () => {
    for (let year = 2017; year <= 2030; year++) {
      const nationwide = publicHolidays(year, "DE");
      for (const region of stateRegions) {
        const result = publicHolidays(year, region);
        const dates = result.map((entry) => entry.date);
        expect(dates).toEqual([...dates].sort());
        expect(new Set(result.map((entry) => entry.key)).size).toBe(result.length);
        expect(result.filter((entry) => entry.nationwide)).toEqual(nationwide);
        for (const entry of result) {
          expect(holidayKeys.has(entry.key)).toBe(true);
          expect(entry.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        }
      }
      for (const entry of nationwide) {
        expect(stateRegions.every((region) => holiday(year, region, entry.key)?.nationwide === true)).toBe(true);
      }
    }
  });

  it("returns a fresh array of fresh objects on every call", () => {
    const first = publicHolidays(2025, "DE-BY");
    const second = publicHolidays(2025, "DE-BY");
    expect(first).not.toBe(second);
    for (const [index, entry] of first.entries()) {
      expect(entry).not.toBe(second[index]);
      entry.date = "2000-01-01";
      entry.key = "liberation-day";
      entry.nationwide = !entry.nationwide;
    }
    first.splice(0, first.length);
    expect(publicHolidays(2025, "DE-BY")).toEqual(second);
  });

  it("exports the same function through dates and the root barrel", () => {
    expect(dates.publicHolidays).toBe(namedPublicHolidays);
    expect(rootPublicHolidays).toBe(publicHolidays);
    expect(namedPublicHolidays).toBe(publicHolidays);
  });
});
