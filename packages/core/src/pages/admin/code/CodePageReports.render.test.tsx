import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { renderedText } from "../../../../../../scripts/fixtures/rendered-markup";
import { registerSsrTestPlugin } from "../../../../../ui/test/ssr-test-plugin";

const root = mkdtempSync(join(tmpdir(), "core-code-page-reports-render-"));
registerSsrTestPlugin({ dev: true, rootDir: root });

process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const [{ LocaleProvider }, { default: CodePageReports }, { codePageReportMessages }] = await Promise.all([
  import("@k2b/ui"),
  import("./CodePageReports"),
  import("./report-messages"),
]);

const code = { id: "c_lieferung", title: "Lieferavise der Woche", state: "active", activeVersionNumber: 3 };
const report = (id: string, reason: "security" | null) => ({
  id,
  reporter: { id: "11111111-1111-4111-8111-111111111111", name: "Jana Probe" },
  path: "/woche",
  reason,
  text: "Die Seite fragt nach meinem Passwort.",
  createdAt: "2026-11-12T09:30:00.000Z",
  state: "open" as const,
  resolvedAt: null,
});
const render = (reports: Parameters<typeof CodePageReports>[0]["reports"], locale = "de") =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(CodePageReports, {
          reports,
          code,
          locale,
          dateConfig: { locale: locale === "de" ? "de-DE" : "en-GB", timeZone: "Europe/Berlin" },
        });
      },
    }),
  );

test("open reports show reason, text, page, who and when, with Mark done and Pause beside the automation", () => {
  const html = render({
    items: [report("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "security"), report("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", null)],
    nextCursor: null,
  });
  const text = renderedText(html);
  expect(text).toContain("Gemeldete Seiten");
  expect(text).toContain("Der Besitzer bekommt davon nichts.");
  expect(text).toContain("Sicherheitsproblem");
  expect(text).toContain("Ohne Grund");
  expect(text).toContain("Die Seite fragt nach meinem Passwort.");
  expect(text).toContain("Jana Probe · 12. Nov. 2026, 10:30");
  expect(html).toContain('href="/code/c_lieferung/woche"');
  expect(html.match(/data-code-page-report=/g)).toHaveLength(2);
  expect(text.match(/Erledigt/g)).toHaveLength(2);
  expect(text).toContain("Pausieren");
  expect(html).not.toContain("<details");
  expect(html).not.toContain("<hr");
  expect(html).not.toContain("<table");
  expect(renderedText(render({ items: [report("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "security")], nextCursor: null }, "en"))).toContain(
    "Security problem",
  );
});

test("no open reports take no space; a failed read says so in place", () => {
  for (const nothing of [null, undefined, "missing" as const, { items: [], nextCursor: null }])
    expect(renderedText(render(nothing))).toBe("");
  expect(renderedText(render("failed"))).toContain("Die Meldungen lassen sich gerade nicht laden.");
});

test("report texts exist in every language", () => {
  expect(codePageReportMessages.check()).toEqual([]);
});
