import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { registerSsrTestPlugin } from "../../test/ssr-test-plugin";

const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-stat-cell-tests-"));
registerSsrTestPlugin({ dev: true, rootDir: root });

process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { StatCell } = await import("./StatCell");
const { StatGrid } = await import("./StatGrid");
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

test("flat chat figures keep compact support, value tones and loading slots alongside plain page figures", () => {
  const grid = (surface: "flat" | "muted", props: Props, variant?: "plain") =>
    renderToString(() =>
      createComponent(StatGrid, {
        surface,
        variant,
        get children() {
          return createComponent(StatCell, props);
        },
      }),
    );
  const flat = grid("flat", { label: "Balance", value: -12, valueTone: "danger", sub: "This month" });
  expect(flat).toContain('class="k2b-stat-cell" data-size="md" data-surface="flat"');
  expect(flat).toContain("data-plain");
  expect(flat).toContain('data-tone="danger"');
  expect(flat).not.toContain('data-variant="plain"');
  const loading = { label: "Balance", value: -12, status: "loading" as const };
  expect(grid("flat", loading)).not.toContain('data-part="support"');
  expect(grid("flat", { ...loading, sub: "This month" })).toContain('data-part="support"');
  expect(grid("muted", loading, "plain")).toContain('data-part="support"');
  const changed = grid("flat", { label: "Balance", value: 12, delta: { value: 0.1 } });
  expect(changed).not.toContain("data-plain");
  expect(changed.indexOf("k2b-stat-cell__delta")).toBeLessThan(changed.indexOf("k2b-stat-cell__support"));
});
