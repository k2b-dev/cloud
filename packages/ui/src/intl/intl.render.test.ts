import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent, type JSX } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-intl-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const domBeforeImport = typeof document;
const { Format, LocaleProvider, NumberInput, useLocale } = await import("../index");

const ShowLocale = (): JSX.Element => {
  const locale = useLocale();
  return `[${locale()}]`;
};

// Children must be thunks: an eagerly created component would run outside the
// provider scope and never see the context.
const provided = (locale: string, ...children: Array<() => JSX.Element>): JSX.Element =>
  createComponent(LocaleProvider, {
    locale,
    get children() {
      return children.map((child) => child());
    },
  });

describe("LocaleProvider / useLocale SSR", () => {
  test("importing the public module never touches the DOM", () => {
    expect(domBeforeImport).toBe("undefined");
    expect(typeof LocaleProvider).toBe("function");
    expect(typeof useLocale).toBe("function");
  });

  test("defaults to en without a provider on the server", () => {
    expect(renderToString(() => createComponent(ShowLocale, {}))).toContain("[en]");
  });

  test("nearest provider wins, including nested providers", () => {
    const html = renderToString(() =>
      provided(
        "de",
        () => createComponent(ShowLocale, {}),
        () => provided("fr-CH", () => createComponent(ShowLocale, {})),
      ),
    );
    expect(html).toContain("[de]");
    expect(html).toContain("[fr-CH]");
  });

  test("keeps independent render trees isolated", () => {
    expect(renderToString(() => provided("de", () => createComponent(ShowLocale, {})))).toContain("[de]");
    expect(renderToString(() => createComponent(ShowLocale, {}))).toContain("[en]");
  });
});

describe("Format components SSR", () => {
  const instant = new Date("2025-03-05T13:53:20Z");

  test("formats numbers with inherited and overridden locale", () => {
    const html = renderToString(() =>
      provided(
        "de",
        () => createComponent(Format.Number, { value: 1234567.89, decimals: 2 }),
        () => createComponent(Format.Number, { value: 1234567.89, decimals: 2, locale: "en-US" }),
      ),
    );
    expect(html).toContain("1.234.567,89");
    expect(html).toContain("1,234,567.89");
  });

  test("formats percent from a ratio and clamps on request", () => {
    const html = renderToString(() => [
      createComponent(Format.Percent, { value: 0.1234, locale: "en" }),
      createComponent(Format.Percent, { value: 1.4, clamp: true, locale: "en" }),
    ]);
    expect(html).toContain("12%");
    expect(html).toContain("100%");
  });

  test("formats currency with a required ISO code", () => {
    const html = renderToString(() => provided("de", () => createComponent(Format.Currency, { value: 1234.5, currency: "EUR" })));
    expect(html).toContain("1.234,50");
    expect(html).toContain("€");
  });

  test("formats bytes and falls back for invalid input", () => {
    const html = renderToString(() => [
      createComponent(Format.Bytes, { value: 1536, locale: "de" }),
      createComponent(Format.Bytes, { value: 1500, mode: "si" as const, locale: "en" }),
      createComponent(Format.Bytes, { value: null }),
      createComponent(Format.Bytes, { value: Number.NaN, fallback: "n/a" }),
    ]);
    expect(html).toContain("1,5 KiB");
    expect(html).toContain("1.5 KB");
    expect(html).toContain("—");
    expect(html).toContain("n/a");
  });

  test("renders temporal values as time with canonical datetime in UTC by default", () => {
    const html = renderToString(() => [
      createComponent(Format.Date, { value: instant }),
      createComponent(Format.Time, { value: instant }),
      createComponent(Format.DateTime, { value: instant }),
    ]);
    expect(html).toContain('datetime="2025-03-05T13:53:20.000Z"');
    expect(html).toContain("05 Mar 2025");
    expect(html).toContain("13:53");
    expect(html).toContain("05 Mar 2025, 13:53");
    expect(html.match(/<time/g)?.length).toBe(3);
  });

  test("keeps Format.Time independent of the process timezone", () => {
    const html = renderToString(() => createComponent(Format.Time, { value: instant }));
    // 13:53 is the UTC wall clock; a runtime-local default would drift with TZ.
    expect(html).toContain("13:53");
  });

  test("honors an explicit timezone while keeping the same instant", () => {
    const html = renderToString(() => [
      createComponent(Format.Time, { value: instant, timeZone: "America/New_York" }),
      createComponent(Format.DateTime, { value: instant, timeZone: "Europe/Berlin" }),
    ]);
    expect(html).toContain("08:53");
    expect(html).toContain("05 Mar 2025, 14:53");
  });

  test("renders a span fallback for null and invalid temporal input", () => {
    const html = renderToString(() => [
      createComponent(Format.Date, { value: null }),
      createComponent(Format.Time, { value: "not-a-date", fallback: "?" }),
    ]);
    expect(html).toContain("—");
    expect(html).toContain("?");
    expect(html).not.toContain("<time");
  });

  test("formats relative time against a deterministic base", () => {
    const html = renderToString(() =>
      provided(
        "de",
        () => createComponent(Format.RelativeTime, { value: "2025-03-05T12:00:00Z", base: "2025-03-05T14:00:00Z" }),
        () => createComponent(Format.RelativeTime, { value: "2025-03-05T12:00:00Z", base: "2025-03-05T14:00:00Z", locale: "en" }),
      ),
    );
    expect(html).toContain("vor 2 Stunden");
    expect(html).toContain("2 hours ago");
    expect(html).toContain('datetime="2025-03-05T12:00:00.000Z"');
  });

  test("formats durations from a range and from milliseconds", () => {
    const html = renderToString(() => [
      createComponent(Format.Duration, { from: "2025-03-05T12:00:00Z", to: "2025-03-05T14:30:00Z", locale: "de" }),
      createComponent(Format.Duration, { from: "2025-03-05T12:00:00Z", to: null }),
      createComponent(Format.DurationMs, { value: 90_000 }),
      createComponent(Format.DurationMs, { value: 0 }),
      createComponent(Format.DurationMs, { value: -5 }),
    ]);
    expect(html).toContain('datetime="PT2H30M"');
    expect(html).toContain("2 Stunden, 30 Minuten");
    expect(html).toContain('datetime="PT1M30S"');
    expect(html).toContain("1m 30s");
    expect(html).toContain('datetime="PT0S"');
    expect(html).toContain("0ms");
    expect(html).toContain("—");
  });

  test("NumberInput renders localized initial text on the server", () => {
    const german = renderToString(() =>
      provided("de", () => createComponent(NumberInput, { label: "Preis", decimalPlaces: 1, value: 1234.5 })),
    );
    expect(german).toContain('value="1234,5"');
    expect(german).toContain('aria-valuenow="1234.5"');

    const fallback = renderToString(() => createComponent(NumberInput, { label: "Price", decimalPlaces: 1, value: 1234.5 }));
    expect(fallback).toContain('value="1234.5"');
  });

  test("passes native attributes through to the rendered element", () => {
    const html = renderToString(() => [
      createComponent(Format.Number, { value: 1, class: "stat", "data-testid": "count" }),
      createComponent(Format.Date, { value: instant, class: "when", id: "created-at" }),
    ]);
    expect(html).toContain('class="stat');
    expect(html).toContain('data-testid="count"');
    expect(html).toContain('class="when');
    expect(html).toContain('id="created-at"');
  });
});
