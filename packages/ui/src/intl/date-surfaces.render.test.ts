import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { dates } from "@k2b/stdlib";
import { createComponent, type JSX } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-date-locale-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { Calendar, DatePicker, DateTimePicker, LocaleProvider } = await import("../index");

const provided = (locale: string, child: () => JSX.Element): JSX.Element =>
  createComponent(LocaleProvider, {
    locale,
    get children() {
      return child();
    },
  });

describe("date surfaces inherit the render locale", () => {
  test("DatePicker uses the provider locale for labels and weekdays", () => {
    const html = renderToString(() => provided("de", () => createComponent(DatePicker, { label: "Datum", value: "2026-07-27" })));
    const expected = dates.formatDate("2026-07-27T12:00", { locale: "de", weekStartsOn: 1 });
    const english = dates.formatDate("2026-07-27T12:00", { locale: "en", weekStartsOn: 1 });
    expect(expected).not.toBe(english);
    expect(html).toContain(expected);
    expect(html).not.toContain(english);
    // Weekday header row follows the same inherited locale and week start.
    for (const day of dates.weekdays({ locale: "de", weekStartsOn: 1 })) {
      expect(html).toContain(`<span>${day}</span>`);
    }
  });

  test("an explicit dateConfig.locale wins over the provider", () => {
    const html = renderToString(() =>
      provided("de", () => createComponent(DatePicker, { label: "Datum", value: "2026-07-27", dateConfig: { locale: "en" } })),
    );
    expect(html).toContain(dates.formatDate("2026-07-27T12:00", { locale: "en", weekStartsOn: 1 }));
  });

  test("keeps the fallback locale without a provider", () => {
    const html = renderToString(() => createComponent(DatePicker, { label: "Date", value: "2026-07-27" }));
    expect(html).toContain(dates.formatDate("2026-07-27T12:00", { locale: "en", weekStartsOn: 1 }));
  });

  test("DateTimePicker combines inherited locale with an explicit timezone", () => {
    const value = "2026-07-27T12:30:00.000Z";
    const dateConfig = { timeZone: "America/New_York" };
    const html = renderToString(() => provided("de", () => createComponent(DateTimePicker, { label: "Zeitpunkt", value, dateConfig })));
    const expected = dates.formatDateTime(value, { locale: "de", timeZone: "America/New_York", weekStartsOn: 1 });
    expect(html).toContain(expected);
    expect(html).toContain("America/New_York");
  });

  test("Calendar inherits the provider locale and preserves explicit overrides", () => {
    const date = new Date("2026-07-28T12:00:00Z");
    const inherited = renderToString(() =>
      provided("de", () => createComponent(Calendar, { date, events: [], view: "month" as const, timeZone: "UTC" })),
    );
    const german = dates.formatMonthYear(date, { locale: "de", timeZone: "UTC" });
    const english = dates.formatMonthYear(date, { locale: "en", timeZone: "UTC" });
    expect(german).not.toBe(english);
    expect(inherited).toContain(german);

    const overridden = renderToString(() =>
      provided("de", () =>
        createComponent(Calendar, {
          date,
          events: [],
          view: "month" as const,
          timeZone: "UTC",
          dateConfig: { locale: "en" },
        }),
      ),
    );
    expect(overridden).toContain(english);
  });
});
