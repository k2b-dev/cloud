import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { RunLogProps, RunStepEntry } from "./RunLog";

const root = mkdtempSync(resolve(tmpdir(), "k2b-run-log-render-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
const { RunLog } = await import("./RunLog");
const { LocaleProvider } = await import("../intl/locale");
const AT = "2026-11-17T16:42:07Z";
const step: RunStepEntry = { kind: "step", id: "read", at: AT, label: "Beleg lesen", status: "running", icon: "ti ti-file-text", description: "Liest das PDF" };
const render = (props: Partial<RunLogProps> = {}, locale = "de") => renderToString(() => createComponent(LocaleProvider, {
  locale,
  get children() { return createComponent(RunLog, { state: "running", entries: [step], ...props }); },
}));

test("the five run states and inherited locale render without time or connection ownership", () => {
  for (const [state, text] of [["idle", "Noch nicht ausgeführt"], ["starting", "Startet …"], ["running", "Läuft seit 0:06"], ["succeeded", "Fertig nach 0:06"], ["failed", "Gescheitert nach 0:06"]] as const) {
    const html = render({ state, duration: 6000, meta: "Verbindung weg, verbinde neu …" });
    expect(html).toContain(text);
    expect(html).toContain('role="status"');
    expect(html).toContain("Verbindung weg, verbinde neu …");
    expect(html.includes('class="k2b-run-log__steps"')).toBe(state !== "idle" && state !== "starting");
  }
  expect(render({ duration: 6000 }, "en")).toContain("Running for 0:06");
  expect(render({ duration: 6000 }, "de-AT")).toContain("Läuft seit 0:06");
});

test("a step id updates its original row, unknown kinds disappear, and successful pending steps become skipped", () => {
  const entries = [step, { kind: "step", id: "write", at: AT, label: "Daten erfassen", status: "pending" }, { ...step, status: "succeeded", startedAt: AT, endedAt: "2026-11-17T16:42:10Z" }, { kind: "future" }] satisfies RunLogProps["entries"];
  const html = render({ state: "succeeded", entries });
  expect((html.match(/class="k2b-run-log__step"/g) ?? []).length).toBe(2);
  expect(html).toContain('data-status="skipped"');
  expect(html).toContain("3 s");
  expect(html.indexOf("Beleg lesen")).toBeLessThan(html.indexOf("Daten erfassen"));
  expect(html).not.toContain("future");
  expect(render({ state: "failed", entries })).toContain('data-status="pending"');
});

test("output is text, has no live announcements, and exposes counts, levels, and history", () => {
  const html = render({ output: "open", olderCount: 312, entries: [step,
    { kind: "log", id: "log", at: AT, level: "warn", text: '<script>alert("x")</script>' },
    { kind: "log", id: "error", at: AT, level: "error", text: "Kein Einlieferer" },
  ] });
  expect(html).toContain('role="log" aria-live="off"');
  expect(html).toContain('data-level="warn"');
  expect(html).toContain('data-level="error"');
  expect(html).toContain("314 Zeilen · 1 Warnung · 1 Fehler");
  expect(html).toContain("312 ältere Zeilen anzeigen");
  expect(html).toContain("16:42:07");
  expect(html).not.toContain("<script>");
  expect(render({ output: "hidden" })).not.toContain('role="log"');
});

test("compact disclosure, reasons and description controls are present in the initial server HTML", () => {
  const html = render({ size: "compact", entries: [{ ...step, status: "failed", message: "Kundennummer fehlt" }] });
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain('aria-controls=');
  expect(html).toContain('inert');
  expect(html).toContain("Details zu Beleg lesen");
  expect(html).toContain("Kundennummer fehlt");
  expect(html).toContain('role="tooltip"');
});

test("many steps keep the approved five-row window and show how to reach the earlier rows", () => {
  const entries = Array.from({ length: 13 }, (_, i) => ({ ...step, id: String(i), label: `Schritt ${i + 1}` }));
  const html = render({ entries });
  expect((html.match(/class="k2b-run-log__step"/g) ?? []).length).toBe(5);
  expect(html).toContain("8 frühere Schritte anzeigen");
});
