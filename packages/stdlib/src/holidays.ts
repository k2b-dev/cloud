/** German federal state codes. */
export type GermanState = "BW" | "BY" | "BE" | "BB" | "HB" | "HH" | "HE" | "MV" | "NI" | "NW" | "RP" | "SL" | "SN" | "ST" | "SH" | "TH";

/** ISO 3166 / 3166-2 region code. "DE" means holidays that apply in every state. */
export type HolidayRegion = "DE" | `DE-${GermanState}`;

/** Stable holiday keys for application message catalogs. */
export type HolidayKey = "new-year" | "epiphany" | "womens-day" | "good-friday" | "easter-sunday" | "easter-monday" | "labour-day" | "liberation-day" | "ascension-day" | "whit-sunday" | "whit-monday" | "corpus-christi" | "uprising-1953" | "assumption-day" | "childrens-day" | "german-unity-day" | "reformation-day" | "all-saints-day" | "repentance-day" | "christmas-day" | "boxing-day";

/** A statutory public holiday for the requested region. */
export type Holiday = {
  /** Calendar date, "YYYY-MM-DD". */
  date: string;
  /** Stable key; applications translate it in their own message catalogs. */
  key: HolidayKey;
  /** True when the holiday applies in all 16 states that year. */
  nationwide: boolean;
};

const regions: ReadonlySet<string> = new Set<HolidayRegion>([
  "DE", "DE-BW", "DE-BY", "DE-BE", "DE-BB", "DE-HB", "DE-HH", "DE-HE", "DE-MV",
  "DE-NI", "DE-NW", "DE-RP", "DE-SL", "DE-SN", "DE-ST", "DE-SH", "DE-TH",
]);

// Anonymous Gregorian algorithm (Meeus/Jones/Butcher).
const easterSunday = (year: number): number => {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = (h + l - 7 * m + 114) % 31 + 1;
  return Date.UTC(year, month - 1, day);
};

const fromEaster = (days: number) => (_year: number, easter: number): number => easter + days * 86_400_000;

const repentanceDay = (year: number): number => {
  const november23 = new Date(Date.UTC(year, 10, 23));
  const daysBefore = (november23.getUTCDay() - 3 + 7) % 7 || 7;
  return Date.UTC(year, 10, 23 - daysBefore);
};

type HolidayRule = {
  readonly key: HolidayKey;
  readonly states: "all" | readonly GermanState[];
  readonly date: readonly [month: number, day: number] | ((year: number, easter: number) => number);
  readonly from?: number;
  readonly onlyYears?: readonly number[];
};

// Sources: the 16 state holiday laws (e.g. Berlin Gesetz über die Sonn- und
// Feiertage with its one-time days in 2020, 2025 and 2028, Brandenburg
// Feiertagsgesetz § 2, Sächsisches Gesetz über Sonn- und Feiertage, Thüringer
// Feiertagsgesetz) and the federal Einigungsvertrag for German Unity Day.
// Not modelled: Assumption Day in Bavarian municipalities with a predominantly
// Catholic population; municipal Corpus Christi in Saxony and Thuringia;
// Augsburg Peace Festival (08-08, city only); days without a statutory day off,
// such as Christmas Eve and New Year's Eve.
const rules: readonly HolidayRule[] = [
  { key: "new-year", states: "all", date: [1, 1] },
  { key: "epiphany", states: ["BW", "BY", "ST"], date: [1, 6] },
  { key: "womens-day", states: ["BE"], date: [3, 8], from: 2019 },
  { key: "womens-day", states: ["MV"], date: [3, 8], from: 2023 },
  { key: "good-friday", states: "all", date: fromEaster(-2) },
  { key: "easter-sunday", states: ["BB"], date: fromEaster(0) },
  { key: "easter-monday", states: "all", date: fromEaster(1) },
  { key: "labour-day", states: "all", date: [5, 1] },
  { key: "liberation-day", states: ["BE"], date: [5, 8], onlyYears: [2020, 2025] },
  { key: "ascension-day", states: "all", date: fromEaster(39) },
  { key: "whit-sunday", states: ["BB"], date: fromEaster(49) },
  { key: "whit-monday", states: "all", date: fromEaster(50) },
  { key: "corpus-christi", states: ["BW", "BY", "HE", "NW", "RP", "SL"], date: fromEaster(60) },
  { key: "uprising-1953", states: ["BE"], date: [6, 17], onlyYears: [2028] },
  { key: "assumption-day", states: ["SL"], date: [8, 15] },
  { key: "childrens-day", states: ["TH"], date: [9, 20], from: 2019 },
  { key: "german-unity-day", states: "all", date: [10, 3] },
  { key: "reformation-day", states: "all", date: [10, 31], onlyYears: [2017] },
  { key: "reformation-day", states: ["BB", "MV", "SN", "ST", "TH"], date: [10, 31] },
  { key: "reformation-day", states: ["HB", "HH", "NI", "SH"], date: [10, 31], from: 2018 },
  { key: "all-saints-day", states: ["BW", "BY", "NW", "RP", "SL"], date: [11, 1] },
  { key: "repentance-day", states: ["SN"], date: repentanceDay },
  { key: "christmas-day", states: "all", date: [12, 25] },
  { key: "boxing-day", states: "all", date: [12, 26] },
];

/** German public holidays by state, sorted by date. Supports integer years 1995–9999; invalid input throws RangeError. */
export const publicHolidays = (year: number, region: HolidayRegion): Holiday[] => {
  if (!Number.isInteger(year) || year < 1995 || year > 9999) {
    throw new RangeError(`Unsupported holiday year ${year}; expected an integer from 1995 to 9999`);
  }
  if (!regions.has(region)) throw new RangeError(`Unsupported holiday region "${region}"`);

  const easter = easterSunday(year);
  const holidays: Holiday[] = [];
  for (const rule of rules) {
    if (rule.from !== undefined && year < rule.from) continue;
    if (rule.onlyYears && !rule.onlyYears.includes(year)) continue;
    const nationwide = rule.states === "all";
    if (!nationwide && (region === "DE" || !rule.states.some((state) => region === `DE-${state}`))) continue;
    // The nationwide 2017 rule precedes overlapping state Reformation Day rules.
    if (holidays.some((holiday) => holiday.key === rule.key)) continue;
    const timestamp = typeof rule.date === "function"
      ? rule.date(year, easter)
      : Date.UTC(year, rule.date[0] - 1, rule.date[1]);
    holidays.push({ date: new Date(timestamp).toISOString().slice(0, 10), key: rule.key, nationwide });
  }
  return holidays.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
};
