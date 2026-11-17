import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { renderedText, withoutComments } from "../../../../../scripts/fixtures/rendered-markup";
import { registerSsrTestPlugin } from "../../../../ui/test/ssr-test-plugin";
import { type SourceTabFixtureState, sourceTabFixture } from "./source-tab.fixture";

const root = mkdtempSync(resolve(tmpdir(), "cloud-code-source-tab-render-"));
registerSsrTestPlugin({ dev: true, rootDir: root });

process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { CodeSourceTab } = await import("./CodeSourceTab");
const { LocaleProvider } = await import("@k2b/ui");

const html = (state: SourceTabFixtureState, locale = "de") =>
  withoutComments(
    renderToString(() =>
      createComponent(LocaleProvider, {
        locale,
        get children() {
          return createComponent(CodeSourceTab, {
            data: sourceTabFixture(state),
            codeId: "c_lea",
            href: "/mail/m_info/code?tab=code",
            versionsHref: "/mail/m_info/code?tab=versions",
            dates: { timeZone: "Europe/Berlin" },
          });
        },
      }),
    ),
  );
const text = (state: SourceTabFixtureState, locale = "de") => renderedText(html(state, locale), " ").replaceAll(/\s+/g, " ");

describe("Code tab", () => {
  test("shows the code of the version that is switched on, read only, with the comparison first in the row", () => {
    const markup = html("code");
    const words = text("code");
    expect(words).toContain("Vergleichen mit");
    expect(words).toContain("Nichts");
    expect(markup.indexOf("k2b-code-diff__toolbar")).toBeLessThan(markup.indexOf('role="tablist"'));
    expect(markup.match(/role="tab"/g)).toHaveLength(2);
    expect(markup).toMatch(/aria-selected="true"[^>]*>(?:(?!<\/button>).)*code\.ts/);
    // Whole code: one number column, no signs or fills, highlighted, a stop in the tab order.
    expect(markup).toContain('data-whole="true"');
    expect(markup).not.toContain("k2b-code-diff__sign");
    expect(markup).toContain('<span class="hl-keyword">import</span>');
    expect(markup).toMatch(
      /class="k2b-code-diff__body" role="region" aria-label="Code der eingeschalteten Version, nur lesen · code\.ts[^"]*"[^>]*tabindex="0"/,
    );
    expect(words).toContain(
      "Nur lesen: der Code der eingeschalteten Version. Ändern geht mit Gustav oder am eigenen Rechner mit cld code pull .",
    );
    expect(markup).toContain('aria-label="Vergleichen mit"');
    expect(markup).toMatch(/aria-describedby="[^"]*code-source-foot-c_lea/);
    expect(markup).not.toContain("+2");
    // No comments, no "+" to add one, no editing.
    expect(markup).not.toMatch(/contenteditable|<textarea|Kommentar/);
  });

  test("a comparison shows the difference in the same field with the lines that came and went", () => {
    const markup = html("diff");
    const words = text("diff");
    expect(words).toContain("Version 3");
    expect(words).toContain("+2 −1");
    expect(words).toContain("2 Zeilen dazu, 1 Zeile weg");
    expect(markup).toMatch(/data-row="7" data-kind="del"/);
    expect(markup.match(/data-kind="add"/g)).toHaveLength(2);
    expect(markup).toContain('aria-label="Unterschied zu Version 3, nur lesen · code.ts"');
    expect(words).toContain("Nur lesen: der Unterschied zwischen Version 3 und der eingeschalteten Version. Rot ist weg, grün ist neu.");
  });

  test("with only one version the choice is there but off, and the line below says why", () => {
    const markup = html("one-version");
    expect(markup).toMatch(/role="combobox"[^>]*disabled/);
    expect(text("one-version")).toContain("Nur lesen. Es gibt erst diese eine Version; zum Vergleichen fehlt eine frühere.");
    expect(markup).not.toContain('role="tablist"');
  });

  test("without a version that is switched on the tab says so and leads to the versions", () => {
    const markup = html("none");
    const words = text("none");
    expect(words).toContain("Es ist noch keine Version eingeschaltet.");
    expect(words).toContain("Sobald eine Version eingeschaltet ist, steht ihr Code hier.");
    expect(markup).toMatch(/href="\/mail\/m_info\/code\?tab=versions"[^>]*>(?:(?!<\/a>).)*Zu den Versionen/);
    expect(markup).not.toContain("k2b-code-diff");
  });

  // F30: what Core refused never reaches the page; the error carries no source.
  test("an error keeps the field and says that nothing changes about the automation", () => {
    const markup = html("error");
    const words = text("error");
    expect(markup).toContain('role="alert"');
    expect(words).toContain("Der Code konnte nicht geladen werden");
    expect(words).toContain("An der Automation ändert das nichts. Übersicht, Läufe und Versionen sind davon nicht betroffen.");
    expect(words).toContain("Erneut versuchen");
    expect(markup).not.toContain("k2b-code-diff__line");
    expect(markup).toContain("k2b-code-diff__state");
  });

  test("a long file renders 400 lines at first and a long line stays one line", () => {
    const long = html("long-file");
    expect(long.match(/class="k2b-code-diff__line"/g)).toHaveLength(400);
    expect(text("long-file")).toContain("400 weitere Zeilen anzeigen");
    const line = html("long-line");
    expect(text("long-line")).toContain("Rückruf bitte bis Freitag bestätigen.");
    expect(line.match(/class="k2b-code-diff__line"/g)).toHaveLength(17);
  });

  test("speaks English with the page", () => {
    const words = text("diff", "en");
    expect(words).toContain("Compare with");
    expect(words).toContain("2 lines added, 1 line removed");
    expect(words).toContain("Read only: the difference between version 3 and the version that is switched on.");
  });
});
