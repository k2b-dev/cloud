import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-period-picker-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { LocaleProvider, PeriodPicker, periodPresets } = await import("../index");

const presets = [
  periodPresets.today,
  periodPresets.thisWeek,
  periodPresets.thisMonth,
  periodPresets.lastMonth,
  periodPresets.thisYear,
  periodPresets.all({ since: "2019-03-14" }),
];
const now = new Date("2026-11-07T11:00:00Z");
const render = (props: Partial<Parameters<typeof PeriodPicker>[0]>, locale = "de") =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(PeriodPicker, {
          "aria-label": "Zeitraum",
          value: { preset: "this-month" },
          presets,
          now,
          dateConfig: { timeZone: "Europe/Berlin" },
          ...props,
        });
      },
    }),
  );
const visible = (html: string) =>
  html.match(/<span id="[^"]+-value"[^>]*>([\s\S]*?)<\/span><span aria-hidden/)?.[1]?.replace(/<[^>]+>/g, "");
const reserved = (html: string) => [...html.matchAll(/<span aria-hidden="true">([^<]*)<\/span>/g)].map((match) => match[1]);

describe("PeriodPicker on the server", () => {
  test("shows the preset with its days and names the control with its value", () => {
    const html = render({});
    expect(visible(html)).toBe("Dieser Monat · 1.–30. Nov.");
    expect(html).toContain('aria-label="Zeitraum: Dieser Monat · 1.–30. Nov."');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-expanded="false"');
  });

  test("shows explicit days with their count", () => {
    expect(visible(render({ value: { start: "2026-11-01", end: "2026-11-07" } }))).toBe("01.–07.11.2026 · 7 Tage");
    expect(visible(render({ value: { start: "2026-11-07", end: "2026-11-07" } }))).toBe("07.11.2026 · 1 Tag");
  });

  test("all time names its first day; week resolves in the base time zone", () => {
    expect(visible(render({ value: { preset: "all" } }))).toBe("Gesamt · seit 14.03.2019");
    // 23:30 UTC on Saturday is already Sunday in Berlin: still the same Monday week, now ending today.
    expect(visible(render({ value: { preset: "this-week" }, now: new Date("2026-11-07T23:30:00Z") }))).toBe("Diese Woche · 2.–8. Nov.");
    expect(visible(render({ value: { preset: "this-week" }, dateConfig: { timeZone: "Europe/Berlin", weekStartsOn: 0 } }))).toBe(
      "Diese Woche · 1.–7. Nov.",
    );
  });

  test("reserves the width of every text it can show, so a new choice never moves its neighbours", () => {
    const html = render({});
    expect(reserved(html)).toEqual([
      "Heute · Sa., 7. Nov.",
      "Diese Woche · 2.–8. Nov.",
      "Dieser Monat · 1.–30. Nov.",
      "Letzter Monat · 1.–31. Okt.",
      "Dieses Jahr · 2026",
      "Gesamt · seit 14.03.2019",
      "28.10. – 31.12.2026 · 65 Tage",
      "Zeitraum wählen",
    ]);
    // Without a custom range there is no range sample to reserve.
    expect(reserved(render({ custom: false }))).not.toContain("28.10. – 31.12.2026 · 65 Tage");
  });

  test("an unknown or missing value shows the placeholder instead of another period", () => {
    for (const value of [{ preset: "season-2025" }, null]) {
      const html = render({ value });
      expect(visible(html)).toBe("Zeitraum wählen");
      expect(html).toContain('data-placeholder="true"');
    }
  });

  test("English labels and app presets", () => {
    const html = render(
      {
        "aria-label": "Period",
        value: { preset: "fiscal-year" },
        presets: [{ key: "fiscal-year", label: "Fiscal year", resolve: () => ({ start: "2026-04-01", end: "2027-03-31" }) }],
      },
      "en",
    );
    expect(visible(html)).toBe("Fiscal year · Apr 1, 2026 – Mar 31, 2027");
  });

  test("a saving picker is busy and cannot open; it keeps its glyph slot", () => {
    const html = render({ loading: true });
    expect(html).toContain('aria-busy="true"');
    expect(html).toMatch(/<button[^>]*disabled/);
    expect(html).toContain("ti-loader-2");
  });
});
