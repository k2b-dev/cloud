import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import type { RunLogProps, RunStepEntry } from "./RunLog";

const root = mkdtempSync(resolve(tmpdir(), "k2b-run-log-render-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
// No shared SSR preload exists for this suite. Keep JSX modules behind the same compiler as our neighbours.
const { createComponent } = await import("solid-js");
const { renderToString } = await import("solid-js/web");
const { RunLog } = await import("./RunLog");
const { LocaleProvider } = await import("../intl/locale");
const { StepRowContent } = await import("../internal/step-row");
const AT = "2026-11-17T16:42:07Z";
const step: RunStepEntry = {
  kind: "step",
  id: "read",
  at: AT,
  label: "Beleg lesen",
  status: "running",
  icon: "ti ti-file-text",
  description: "Liest das PDF",
};
const render = (props: Partial<RunLogProps> = {}, locale = "de") =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(RunLog, { state: "running", entries: [step], ...props });
      },
    }),
  );

test("the five run states and inherited locale render without time or connection ownership", () => {
  for (const [state, text] of [
    ["idle", "Noch nicht ausgeführt"],
    ["starting", "Startet …"],
    ["running", "Läuft seit 0:06"],
    ["succeeded", "Fertig nach 0:06"],
    ["failed", "Gescheitert nach 0:06"],
  ] as const) {
    const html = render({ state, duration: 6000, meta: "Verbindung weg, verbinde neu …" });
    expect(html).toContain(text);
    expect(html).toContain('role="status"');
    expect(html).toContain("Verbindung weg, verbinde neu …");
    expect(html).toContain('class="k2b-run-log__steps"');
    if (state === "idle" || state === "starting")
      expect(render({ state, entries: [] })).not.toContain('class="k2b-run-log__steps"');
  }
  expect(render({ duration: 6000 }, "en")).toContain("Running for 0:06");
  expect(render({ duration: 6000 }, "de-AT")).toContain("Läuft seit 0:06");
});

test("a step id updates its original row, unknown kinds disappear, and successful pending steps become skipped", () => {
  const entries = [
    step,
    { kind: "step", id: "write", at: AT, label: "Daten erfassen", status: "pending" },
    { ...step, status: "succeeded", startedAt: AT, endedAt: "2026-11-17T16:42:10Z" },
    { kind: "future" },
  ] satisfies RunLogProps["entries"];
  const html = render({ state: "succeeded", entries });
  expect((html.match(/class="k2b-run-log__step"/g) ?? []).length).toBe(2);
  expect(html).toContain('data-status="skipped"');
  expect(html).toContain("3s");
  expect(html.indexOf("Beleg lesen")).toBeLessThan(html.indexOf("Daten erfassen"));
  expect(html).not.toContain("future");
  expect(render({ state: "failed", entries })).toContain('data-status="pending"');
});

test("output is text, has no live announcements, and exposes counts, levels, and history", () => {
  const html = render({
    output: "open",
    olderCount: 312,
    entries: [
      step,
      { kind: "log", id: "log", at: AT, level: "warn", text: '<script>alert("x")</script>' },
      { kind: "log", id: "error", at: AT, level: "error", text: "Kein Einlieferer" },
    ],
  });
  expect(html).toContain('role="log" aria-live="off"');
  expect(html).toContain('data-level="warn"');
  expect(html).toContain('data-level="error"');
  expect(html).toContain("314 Zeilen · 1 Warnung · 1 Fehler");
  expect(html).toContain("312 ältere Zeilen anzeigen");
  expect(html).toContain(new Intl.DateTimeFormat("de", { timeStyle: "medium" }).format(new Date(AT)));
  expect(html).toContain('role="img" aria-label="Warnung"');
  expect(html).toContain('role="img" aria-label="Fehler"');
  expect(html).not.toContain("<script>");
  expect(render({ output: "hidden" })).not.toContain('role="log"');
});

test("compact disclosure, reasons and description controls are present in the initial server HTML", () => {
  const html = render({ size: "compact", entries: [{ ...step, status: "failed", message: "Kundennummer fehlt" }] });
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain("aria-controls=");
  expect(html).toContain("inert");
  expect(html).toContain("Details zu Beleg lesen");
  expect(html).toContain("Kundennummer fehlt");
  expect(html).toContain('role="tooltip"');
});

test("many steps keep the approved five-row window and show how to reach the earlier rows", () => {
  const entries = Array.from({ length: 13 }, (_, i) => ({
    ...step,
    id: String(i),
    label: `Schritt ${i + 1}`,
    status: "pending" as const,
  }));
  const html = render({ entries });
  expect((html.match(/class="k2b-run-log__step"/g) ?? []).length).toBe(5);
  expect(html).toContain("8 frühere Schritte anzeigen");
});

test("started steps add one chronological output marker without changing their row position", () => {
  const html = render({
    output: "open",
    entries: [
      { ...step, startedAt: "2026-11-17T16:42:08Z" },
      { kind: "log", id: "before", at: AT, level: "info", text: "Vor dem Schritt" },
      { ...step, startedAt: "2026-11-17T16:42:08Z", status: "succeeded" },
      { kind: "log", id: "after", at: "2026-11-17T16:42:09Z", level: "info", text: "Nach dem Schritt" },
    ],
  });
  expect((html.match(/data-level="step"/g) ?? []).length).toBe(1);
  const marker = html.indexOf('data-level="step"');
  expect(marker).toBeGreaterThan(html.indexOf("Vor dem Schritt"));
  expect(marker).toBeLessThan(html.indexOf("Nach dem Schritt"));
  expect(html).toContain("▸ ");
  expect(html).toContain("3 Zeilen");
});

test("the default window includes the first running or failed step", () => {
  for (const status of ["running", "failed"] as const) {
    const html = render({
      entries: Array.from({ length: 13 }, (_, i) => ({
        ...step,
        id: String(i),
        label: `Schritt ${i + 1}`,
        status: i === 0 ? status : "pending",
      })),
    });
    expect(html).toContain('title="Schritt 1"');
    expect(html).not.toContain('title="Schritt 13"');
    expect(html).toContain("8 weitere Schritte anzeigen");
  }
});

test("only run state belongs to the live status, never duration or current step", () => {
  const status = (html: string) => /role="status">([^<]*)</.exec(html)?.[1];
  for (const size of ["full", "compact"] as const) {
    expect(status(render({ size, duration: 6000 }))).toBe("Läuft");
    expect(status(render({ size, duration: 7000 }))).toBe("Läuft");
    expect(status(render({ size, duration: 7000, state: "succeeded" }))).toBe("Fertig");
  }
});

test("step durations use the shared formatter for milliseconds, fractional seconds and minutes", () => {
  for (const [endedAt, expected] of [
    ["2026-11-17T16:42:07.400Z", "400ms"],
    ["2026-11-17T16:42:08.250Z", "1,25s"],
    ["2026-11-17T16:43:37Z", "1m 30s"],
  ] as const) {
    expect(render({ entries: [{ ...step, startedAt: AT, endedAt }] })).toContain(expected);
  }
});

test("an empty task status retains its screen-reader span for DOM parity", () => {
  const html = renderToString(() =>
    createComponent(StepRowContent, {
      classes: { leading: "leading", label: "label" },
      leading: "",
      label: "Task",
      statusLabel: "",
    }),
  );
  expect(html).toContain('<span class="k2b-sr-only"></span>');
});
