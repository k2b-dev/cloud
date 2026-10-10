import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { dates } from "@k2b/stdlib";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import {
  displayDate,
  filterTimeInput,
  formatDateOnlyRangeDuration,
  isCompleteTime,
  monthNames,
  msUntilNextDay,
  normalizeTimeInput,
  orderedRange,
  previewRange,
  resolveFocusDay,
  splitDateTime,
  toDateTimeValue,
} from "./date-picker";

const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-date-picker-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const ui = await import("../index");
const { DatePicker, DateRangePicker, DateTimePicker } = ui;
const { placeDatePopover } = await import("./DatePicker");
const uiCss = await Bun.file(resolve(import.meta.dir, "../styles/index.css")).text();

describe("@k2b/ui complete date picker migration", () => {
  test("normalizes time input without accepting impossible clock values", () => {
    expect(filterTimeInput("1a2345")).toBe("12:34");
    expect(filterTimeInput("09:3")).toBe("09:3");
    expect(normalizeTimeInput("25:90")).toBe("23:59");
    expect(normalizeTimeInput("7")).toBe("07:00");
    expect(isCompleteTime("09:30")).toBe(true);
    expect(isCompleteTime("24:00")).toBe(false);
    expect(isCompleteTime("09:60")).toBe(false);
    expect(isCompleteTime("9:30")).toBe(false);
    expect(toDateTimeValue("2026-07-27", "24:00")).toBeNull();
    expect(toDateTimeValue("2026-07-27", "09:60")).toBeNull();
  });

  test("round-trips wall-clock values through an explicit timezone", () => {
    const context = { timeZone: "Europe/Berlin", locale: "en" };
    const instant = toDateTimeValue("2026-07-27", "14:30", context);

    expect(instant).toBe("2026-07-27T12:30:00.000Z");
    expect(splitDateTime(instant, context)).toEqual({ date: "2026-07-27", time: "14:30" });
  });

  test("keeps date-only labels on their calendar day", () => {
    expect(displayDate("2026-07-27", { locale: "en" })).toBe("Jul 27, 2026");
    expect(displayDate("2026-07-27", { locale: "en", timeZone: "America/New_York" })).toBe("Jul 27, 2026");
  });

  test("orders and previews ranges while preserving inclusive duration", () => {
    expect(orderedRange("2026-07-29", "2026-07-27")).toEqual({
      start: "2026-07-27",
      end: "2026-07-29",
    });
    expect(previewRange({ start: "2026-07-27", end: null }, "2026-07-25")).toEqual({
      start: "2026-07-25",
      end: "2026-07-27",
    });
    expect(formatDateOnlyRangeDuration({ start: "2026-07-27", end: "2026-07-29" })).toBe("3 days");
    expect(formatDateOnlyRangeDuration({ start: "2026-03-28", end: "2026-03-30" }, { timeZone: "Europe/Berlin" })).toBe("3 days");
  });

  test("keeps the month panel on short, locale-aware names", () => {
    const english = monthNames({ locale: "en" });

    expect(english).toHaveLength(12);
    expect(english[0]).toBe("Jan");
    expect(english[8]).toBe("Sep");
    expect(monthNames({ locale: "de" })[11]).toBe("Dez");
    for (const name of english) expect(name.length).toBeLessThanOrEqual(4);
  });

  test("always keeps one tabbable day in the rendered month", () => {
    const july = ["2026-07-01", "2026-07-02", "2026-07-03"];

    expect(resolveFocusDay(july, "2026-07-02")).toBe("2026-07-02");
    // Selection outside the visible month must not leave the grid untabbable.
    expect(resolveFocusDay(july, "2026-01-14")).toBe("2026-07-01");
    expect(resolveFocusDay(july, null)).toBe("2026-07-01");
  });

  test("places the top-layer panel within the viewport and flips above", () => {
    const previousWindow = globalThis.window;
    // Keep the stub writable and configurable so later suites in the same
    // process can still replace or delete `window`.
    const stubWindow = (value: { innerWidth: number; innerHeight: number }) =>
      Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value });

    stubWindow({ innerWidth: 500, innerHeight: 400 });
    const style: Record<string, string> = {};
    const trigger = {
      getBoundingClientRect: () => ({ left: 430, right: 490, top: 330, bottom: 360, width: 60, height: 30 }),
    } as HTMLElement;
    const popover = {
      style,
      getBoundingClientRect: () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 336, height: 200 }),
    } as unknown as HTMLElement;

    placeDatePopover(trigger, popover, false);

    expect(style.width).toBe("336px");
    expect(style.left).toBe("156px");
    expect(style.top).toBe("126px");

    // A full-width trigger must not stretch the panel past its designed width.
    const wideTrigger = {
      getBoundingClientRect: () => ({ left: 20, right: 480, top: 10, bottom: 40, width: 460, height: 30 }),
    } as HTMLElement;
    placeDatePopover(wideTrigger, popover, false);
    expect(style.width).toBe("336px");

    // A viewport narrower than the panel clamps the width and the left edge.
    stubWindow({ innerWidth: 300, innerHeight: 800 });
    placeDatePopover(wideTrigger, popover, false);
    expect(style.width).toBe("284px");
    expect(style.left).toBe("8px");

    if (previousWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: previousWindow });
  });

  test("renders a controlled date picker with presets and calendar semantics", () => {
    const html = renderToString(() =>
      createComponent(DatePicker, {
        label: "Release date",
        value: "2026-07-27",
        clearable: true,
        required: true,
        presets: [{ label: "Launch", value: "2026-07-27" }],
      }),
    );

    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('popover="auto"');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('role="grid"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain("Launch");
    expect(html).toContain("Clear date");
    expect(html).toContain("k2b-input-clear-action");
    expect(html).toContain("k2b-field__required");
    // role="grid" needs rows, and exactly one day carries the roving tabindex.
    expect(html).toContain('role="row"');
    expect(html.match(/tabindex="0"/g)).toHaveLength(1);
    expect(html).toContain('data-date-day="2026-07-27"');
    const popoverRule = uiCss.match(/\.k2b-ui \.k2b-date-popover \{([^}]*)\}/)?.[1] ?? "";
    expect(popoverRule).toContain("transition: none");
  });

  test("keeps an empty range draft applicable so a clear preset can commit", () => {
    const empty = renderToString(() =>
      createComponent(DateRangePicker, {
        label: "Window",
        value: { start: null, end: null },
      }),
    );
    const complete = renderToString(() =>
      createComponent(DateRangePicker, {
        label: "Window",
        value: { start: "2026-07-27", end: "2026-07-29" },
      }),
    );

    const half = renderToString(() =>
      createComponent(DateRangePicker, {
        label: "Window",
        value: { start: "2026-07-27", end: null },
      }),
    );

    expect(empty).toContain('class="k2b-date-apply"');
    expect(empty).not.toContain('k2b-date-apply" disabled');
    expect(complete).not.toContain('k2b-date-apply" disabled');
    // A half-picked range still cannot be committed.
    expect(half).toContain('k2b-date-apply" disabled');
  });

  test("renders timezone-aware date-time controls with a committed draft", () => {
    const html = renderToString(() =>
      createComponent(DateTimePicker, {
        label: "Starts at",
        value: "2026-07-27T12:30:00.000Z",
        dateConfig: { timeZone: "Europe/Berlin", locale: "en" },
      }),
    );

    expect(html).toContain("Europe/Berlin");
    expect(html).toContain('aria-label="Time"');
    expect(html).toContain(">Apply</button>");
    expect(html).toContain("ti ti-calendar-time");
  });

  test("builds the timezone-aware month grid once per rendered panel", () => {
    const getMonthGrid = dates.getMonthGrid;
    const mutableDates = dates as { -readonly [Key in keyof typeof dates]: (typeof dates)[Key] };
    let calls = 0;
    mutableDates.getMonthGrid = (...args: Parameters<typeof getMonthGrid>) => {
      calls += 1;
      return getMonthGrid(...args);
    };

    try {
      renderToString(() =>
        createComponent(DateTimePicker, {
          label: "Starts at",
          value: "2026-07-27T12:30:00.000Z",
          dateConfig: { timeZone: "Europe/Berlin", locale: "en" },
        }),
      );
    } finally {
      mutableDates.getMonthGrid = getMonthGrid;
    }

    expect(calls).toBe(1);
  });

  test("renders date ranges, preview state, times, and duration presets", () => {
    const html = renderToString(() =>
      createComponent(DateRangePicker, {
        label: "Window",
        value: {
          start: "2026-07-27T07:00:00.000Z",
          end: "2026-07-27T08:00:00.000Z",
        },
        withTime: true,
        dateConfig: { timeZone: "Europe/Berlin", locale: "en" },
        durationPresets: [
          { label: "30 min", minutes: 30 },
          { label: "1 hour", minutes: 60 },
        ],
      }),
    );

    expect(html).toContain("k2b-date-range-value");
    expect(html).toContain('aria-label="Start time"');
    expect(html).toContain('aria-label="End time"');
    expect(html).toContain('aria-label="Duration presets"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("1 hour");
    expect(html).toMatch(/class="k2b-date-actions"[^>]*>[\s\S]*class="k2b-date-durations"[\s\S]*>Apply<\/button>/);
  });

  describe("today", () => {
    afterEach(() => setSystemTime());

    /** The rendered day button for a date key, or an empty string. */
    const dayButton = (html: string, key: string): string => html.match(new RegExp(`<button[^>]*data-date-day="${key}"[^>]*>`))?.[0] ?? "";
    const todayButtons = (html: string): string[] => html.match(/<button[^>]*data-today="true"[^>]*>/g) ?? [];

    test("marks today with aria-current and a name that says so", () => {
      setSystemTime(new Date("2026-10-09T10:00:00.000Z"));
      const html = renderToString(() =>
        createComponent(DatePicker, { label: "Due", value: null, dateConfig: { timeZone: "Europe/Berlin", locale: "en" } }),
      );

      expect(todayButtons(html)).toHaveLength(1);
      const today = dayButton(html, "2026-10-09");
      expect(today).toContain('data-today="true"');
      expect(today).toContain('aria-current="date"');
      expect(today).toContain('aria-label="Today, Friday, October 9, 2026"');
      expect(today).toContain('aria-selected="false"');
      // Without a value the roving tab stop starts on today.
      expect(today).toContain('tabindex="0"');
      expect(dayButton(html, "2026-10-08")).not.toContain("aria-current");
    });

    test("keeps the selection on today and names it in the render locale", () => {
      setSystemTime(new Date("2026-10-09T10:00:00.000Z"));
      const html = renderToString(() =>
        createComponent(DatePicker, { label: "Fällig", value: "2026-10-09", dateConfig: { timeZone: "Europe/Berlin", locale: "de" } }),
      );

      const today = dayButton(html, "2026-10-09");
      expect(today).toContain('aria-selected="true"');
      expect(today).toContain('data-today="true"');
      expect(today).toContain('aria-label="Heute, Freitag, 9. Oktober 2026"');
    });

    test("marks today on a day outside the visible month", () => {
      setSystemTime(new Date("2026-10-01T10:00:00.000Z"));
      const html = renderToString(() =>
        createComponent(DateRangePicker, {
          label: "Window",
          value: { start: "2026-09-14", end: "2026-09-18" },
          dateConfig: { timeZone: "Europe/Berlin", locale: "en" },
        }),
      );

      const today = dayButton(html, "2026-10-01");
      expect(today).toContain('data-outside="true"');
      expect(today).toContain('data-today="true"');
      expect(today).toContain('aria-current="date"');
    });

    test("reads today in the picker's time zone, not the server clock", () => {
      // 22:30 UTC is already the next day in Berlin and still the same day in New York.
      setSystemTime(new Date("2026-10-09T22:30:00.000Z"));
      const render = (timeZone: string) =>
        renderToString(() => createComponent(DateTimePicker, { label: "Send", value: null, dateConfig: { timeZone, locale: "en" } }));

      expect(dayButton(render("Europe/Berlin"), "2026-10-10")).toContain('aria-current="date"');
      expect(dayButton(render("America/New_York"), "2026-10-09")).toContain('aria-current="date"');
    });

    test("waits until the next midnight in the picker's time zone", () => {
      const now = new Date("2026-10-09T21:59:30.000Z");
      expect(msUntilNextDay(now, { timeZone: "Europe/Berlin" })).toBe(30_000);
      expect(msUntilNextDay(now, { timeZone: "America/New_York" })).toBe(6 * 3_600_000 + 30_000);
      // The night the clocks go back has a 25-hour day.
      expect(msUntilNextDay(new Date("2026-10-24T22:00:00.000Z"), { timeZone: "Europe/Berlin" })).toBe(25 * 3_600_000);
    });

    test("draws the today dot inside the cell", () => {
      const rule = uiCss.match(/\.k2b-ui \.k2b-date-grid button\[data-today="true"\]::after \{([^}]*)\}/)?.[1] ?? "";
      expect(rule).toContain("position: absolute");
      expect(rule).toContain("background: currentColor");
    });
  });

  test("does not expose the deprecated native compatibility wrapper", () => {
    expect("DateTimeInput" in ui).toBe(false);
  });
});
