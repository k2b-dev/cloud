import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-stat-cell-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { StatCell } = await import("./StatCell");
const { LocaleProvider } = await import("../intl/locale");
type Props = Parameters<typeof StatCell>[0];

const cell = (props: Props, locale = "en") =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(StatCell, props);
      },
    }),
  );
// The value span and what it holds, up to its own closing tag.
const value = (html: string) =>
  /<span[^>]*class="k2b-stat-cell__value[^>]*>(?:<span[^>]*>[^<]*<\/span>|[^<])*<\/span>/.exec(html)?.[0] ?? "";

test("a missing figure shows the shared empty dash, named in the reader's language", () => {
  for (const missing of [null, undefined, ""]) {
    const shown = value(cell({ label: "Revenue", value: missing }));
    expect(shown).toContain(">—<");
    expect(shown).toContain('role="img"');
    expect(shown).toContain('aria-label="No value"');
  }
  expect(value(cell({ label: "Umsatz", value: null }, "de"))).toContain('aria-label="Kein Wert"');
});

test("a figure keeps its text and no label of its own", () => {
  const shown = value(cell({ label: "Revenue", value: "€4,610" }));
  expect(shown).toContain(">€4,610<");
  expect(shown).not.toContain("aria-label");
  expect(shown).not.toContain('role="img"');
});
