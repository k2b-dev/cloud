import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createComponent, type JSX } from "solid-js";
import { renderToString } from "solid-js/web";
import { registerSsrTestPlugin } from "../../test/ssr-test-plugin";

// Spaces (W3): the counts of a sidebar and of tabs stood as raw numbers (12345). A number is written in the page's
// language, whole (12.345 in German, 12,345 in English), never cut to "9.999+"; words the app gives stay as they are.
const root = mkdtempSync(resolve(tmpdir(), "k2-v2-counts-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { Nav, Tabs } = await import("./components");
const { LocaleProvider } = await import("../intl/locale");

const inLocale = (locale: "de" | "en", element: () => JSX.Element) =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return element();
      },
    }),
  );
const counts = (markup: string, part: string) =>
  [...markup.matchAll(new RegExp(`class="${part}"[^>]*>([^<]*)<`, "g"))].map((match) => match[1]);

for (const [locale, big, huge] of [
  ["de", "12.345", "1.234.567"],
  ["en", "12,345", "1,234,567"],
] as const) {
  test(`a sidebar writes its counts in the page's language, whole (${locale})`, () => {
    const markup = inLocale(locale, () =>
      createComponent(Nav, {
        title: "Spaces",
        icon: "layout-grid",
        groups: [
          {
            label: "Räume",
            items: [
              { label: "Werkstatt", icon: "folder", href: "#a", count: 12345 },
              { label: "Archiv", icon: "folder", href: "#b", count: 1234567 },
              { label: "Neu", icon: "folder", href: "#c", count: 7 },
              { label: "Leer", icon: "folder", href: "#e", count: 0 },
              { label: "Viele", icon: "folder", href: "#d", count: "99+" },
            ],
          },
        ],
      }),
    );
    expect(counts(markup, "k2-ni-count")).toEqual([big, huge, "7", "0", "99+"]);
  });

  test(`tabs write their counts in the page's language, whole (${locale})`, () => {
    const markup = inLocale(locale, () =>
      createComponent(Tabs, {
        label: "Ansichten",
        items: [
          { label: "Alle", current: true, count: 12345, onClick: () => undefined },
          { label: "Archiv", count: 1234567, onClick: () => undefined },
          { label: "Weitere", count: "+8", menu: [{ label: "Papierkorb", onClick: () => undefined }] },
        ],
      }),
    );
    expect(counts(markup, "k2-tab-count")).toEqual([big, huge, "+8"]);
  });
}
